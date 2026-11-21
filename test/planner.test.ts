import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { afterEach } from "node:test";
import { createPlan, decideEscalation } from "../src/core/planner.js";
import { MockClient, mockTool } from "../src/models/client.js";
import type { MockStep } from "../src/models/client.js";
import type { PlannerCtx } from "../src/core/planner.js";
import { repoMap, runReadTool } from "../src/core/repo.js";
import { git, makeRepo, removeRepos } from "./helpers.js";
import type { EventInput } from "../src/store/events.js";
import { json, plan, task } from "./helpers.js";

afterEach(removeRepos);

function planner(steps: MockStep[], maxPlanRetries = 2, repo: Partial<PlannerCtx["repo"]> = {}) {
  const events: Array<Omit<EventInput, "runId">> = [];
  const client = new MockClient(steps);
  const ctx: PlannerCtx = {
    client, modelName: "mock", emit: (event) => { events.push(event); }, limits: { maxFiles: 5, maxLines: 300 }, maxPlanRetries,
    commandPolicy: { allow: ["node"], deny: [], timeoutMs: 1000, outputLimitBytes: 1000 }, fileExists: (file) => file === "scripts/check.js",
    workerModels: ["mock"],
    repo: { baseSha: "0".repeat(40), map: "(test repository map)", maxToolTurns: 4, runTool: async () => ({}), ...repo },
  };
  return { ctx, client, events: () => events, types: () => events.map((event) => event.type) };
}

describe("createPlan", () => {
  it("accepts a multi-task plan and sends the split guidance to the planner", async () => {
    const { ctx, client, types } = planner([json(plan([task("a", ["src/a/**"]), task("b", ["src/b/**"])]))]);
    assert.equal((await createPlan(ctx, "build it")).tasks.length, 2);
    assert.deepEqual(types(), ["model_call", "plan_proposed", "plan_accepted"]);
    assert.match(client.calls[0]!.messages[0]!.content, /define interfaces/);
    assert.match(client.calls[0]!.messages[0]!.content, /quality gates/);
  });

  it("sends a rejected plan back with the reason until it validates", async () => {
    const overlapping = plan([task("a", ["src/**"]), task("b", ["src/lib/**"])]);
    const { ctx, client, types } = planner([json(overlapping), { ...json(""), message: { role: "assistant", content: "not json" } }, json(plan([task("a", ["src/a/**"])]))]);
    assert.equal((await createPlan(ctx, "build it")).tasks.length, 1);
    assert.deepEqual(types().filter((type) => type.startsWith("plan_")), ["plan_proposed", "plan_rejected", "plan_rejected", "plan_proposed", "plan_accepted"]);
    assert.ok(client.calls[1]!.messages.some((message) => /Plan rejected: parallel writeScope overlap/.test(message.content)));
  });

  it("sees the repository in its prompt and can read files before planning", async () => {
    const repo = await makeRepo({ "src/feature.ts": "export const flag = true;\n" });
    const baseSha = git(repo, "rev-parse", "HEAD");
    const { ctx, client, types } = planner([
      mockTool("read_file", { path: "src/feature.ts" }),
      mockTool("search", { pattern: "flag" }),
      json(plan([task("a", ["src/a.ts"])])),
    ], 2, { baseSha, map: repoMap(repo, baseSha), runTool: (name, args) => runReadTool(repo, baseSha, name, args, { maxReadLines: 100, maxSearchHits: 10 }) });
    assert.equal((await createPlan(ctx, "use the flag")).tasks.length, 1);
    // The system prompt carries the file list; file contents arrive through the tools.
    assert.match(client.calls[0]!.messages[0]!.content, /src\/feature\.ts/);
    assert.match(client.calls[0]!.messages[0]!.content, /tracked files/);
    const results = client.calls[2]!.messages.filter((message) => message.role === "tool");
    assert.equal(results.length, 2);
    assert.match(results[0]!.content, /export const flag = true/);
    assert.match(results[1]!.content, /src\/feature\.ts:1:/);
    assert.deepEqual(types().filter((type) => type === "tool_call").length, 2);
  });

  it("searches for a fixed string, not a regex", async () => {
    const repo = await makeRepo({ "src/feature.ts": "export const flag = true;\n" });
    const baseSha = git(repo, "rev-parse", "HEAD");
    // An unbalanced bracket is a regex error; as a fixed string it is simply no match.
    assert.equal(await runReadTool(repo, baseSha, "search", { pattern: "flag[" }, { maxReadLines: 100, maxSearchHits: 10 }), "(no matches)");
  });

  it("stops inspecting after maxToolTurns and asks for the plan", async () => {
    const repo = await makeRepo({ "src/a.ts": "x\n" });
    const baseSha = git(repo, "rev-parse", "HEAD");
    // Two inspection turns run (maxToolTurns), the third turn's tool call is cut off, then the plan must come.
    const reads = Array.from({ length: 3 }, () => mockTool("read_file", { path: "src/a.ts" }));
    const { ctx, client } = planner([...reads, json(plan([task("a", ["src/a.ts"])]))], 0, { baseSha, maxToolTurns: 2, runTool: (name, args) => runReadTool(repo, baseSha, name, args, { maxReadLines: 100, maxSearchHits: 10 }) });
    assert.equal((await createPlan(ctx, "x")).tasks.length, 1);
    assert.ok(client.calls.at(-1)!.messages.some((message) => message.role === "user" && /Stop inspecting/.test(message.content)));
  });

  it("rejects acceptance commands the command policy would refuse, before any task runs", async () => {
    const shell = plan([task("a", ["src/a/**"], [], ["node -p 1; node -p 2"])]);
    const notAllowed = plan([task("a", ["src/a/**"])], ["npm test"]);
    const { ctx, client, types } = planner([json(shell), json(notAllowed), json(plan([task("a", ["src/a/**"])], ["node scripts/check.js"]))]);
    assert.equal((await createPlan(ctx, "build it")).tasks.length, 1);
    assert.equal(types().filter((type) => type === "plan_rejected").length, 2);
    const feedback = client.calls[2]!.messages.filter((message) => message.role === "user").map((message) => message.content).join("\n");
    assert.match(feedback, /acceptance command of task a cannot run: `node -p 1; node -p 2` \(command must be plain argv text without shell syntax\)/);
    assert.match(feedback, /acceptance command of globalAcceptance cannot run: `npm test` \(command is not allowed: npm\)/);
  });

  it("rejects an acceptance command that needs a file the task cannot have yet", async () => {
    const impl = (commands: string[]) => task("impl", ["src/a.js"], [], commands);
    const test = task("test", ["test/a.test.js"], ["impl"], ["node test/a.test.js", "node scripts/check.js src/a.js"]);
    // impl is verified by a test file that only the later task writes.
    const { ctx, client, types } = planner([json(plan([impl(["node test/a.test.js"]), test])), json(plan([impl(["node --check ./src/a.js"]), test], ["node test/a.test.js"]))]);
    assert.equal((await createPlan(ctx, "build it")).tasks.length, 2);
    assert.equal(types().filter((type) => type === "plan_rejected").length, 1);
    assert.ok(client.calls[1]!.messages.some((message) => /task impl uses test\/a\.test\.js, which does not exist/.test(message.content)));

    const global = planner([json(plan([impl(["node --check src/a.js"])], ["node test/missing.test.js"]))], 0);
    await assert.rejects(createPlan(global.ctx, "build it"), /globalAcceptance uses test\/missing\.test\.js/);
  });

  it("gives up after maxPlanRetries rejected plans", async () => {
    const bad = json(plan([task("a", ["a/**"], ["missing"])]));
    const { ctx, client } = planner([bad, bad, bad, bad], 1);
    await assert.rejects(createPlan(ctx, "build it"), /no valid plan after 2 attempts: unknown dependency/);
    assert.equal(client.calls.length, 2);
  });
});

describe("decideEscalation", () => {
  const current = plan([task("a", ["src/a/**"]), task("b", ["src/b/**"], ["a"])]);
  const input = { plan: current, taskId: "a", failures: [], usedIds: new Set(["a", "b"]) };

  it("rewrites the DAG for a split: subtasks replace the task for its dependents", async () => {
    const { ctx } = planner([json({ action: "split", tasks: [task("a1", ["src/a/one.ts"]), task("a2", ["src/a/two.ts"])] })]);
    const decision = await decideEscalation(ctx, input);
    assert.equal(decision.action, "split");
    assert.ok(decision.action === "split");
    assert.deepEqual(decision.plan.tasks.map((entry) => entry.id), ["b", "a1", "a2"]);
    assert.deepEqual(decision.plan.tasks[0]!.dependsOn, ["a1", "a2"]);
  });

  it("rejects a split that reuses an id or fails plan validation, then abandons", async () => {
    const reused = json({ action: "split", tasks: [task("b", ["src/a/one.ts"])] });
    const overlapping = json({ action: "split", tasks: [task("a1", ["src/a/**"]), task("a2", ["src/a/x/**"])] });
    const { ctx, types } = planner([reused, overlapping], 1);
    const decision = await decideEscalation(ctx, input);
    assert.equal(decision.action, "abandon");
    assert.match(decision.reason, /overlap/);
    assert.equal(types().filter((type) => type === "plan_rejected").length, 2);
  });
});

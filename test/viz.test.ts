import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { afterEach, describe, it } from "node:test";
import path from "node:path";
import { EventStore } from "../src/store/events.js";
import { startVizServer } from "../src/cli/viz.js";
import type { VizData, VizServer } from "../src/cli/viz.js";
import { config, dbPath, json, makeRepo, plan, removeRepos, run, task, writes } from "./helpers.js";

const servers: VizServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await removeRepos();
});

async function getData(server: VizServer): Promise<VizData> {
  const response = await fetch(`${server.url}/api/run`);
  assert.equal(response.status, 200);
  return (await response.json()) as VizData;
}

describe("viz server", () => {
  it("serves a finished run as tasks, attempt timeline, stats and an HTML page", async () => {
    const repo = await makeRepo();
    const result = await run(repo, {
      planner: [json(plan([task("a", ["out/a.txt"]), task("b", ["out/b.txt"], ["a"])]))],
      tasks: { a: [writes("out/a.txt", "A")], b: [writes("out/b.txt", "B")] },
    });
    assert.equal(result.state, "passed", result.summary);
    const server = await startVizServer({ repoRoot: repo, runId: result.runId, port: 0 });
    servers.push(server);

    const data = await getData(server);
    assert.equal(data.runId, result.runId);
    assert.equal(data.state, "passed");
    assert.deepEqual(data.tasks.map((entry) => entry.state), ["merged", "merged"]);
    assert.deepEqual(data.tasks[1]!.dependsOn, ["a"]);
    assert.ok(data.tasks.every((entry) => entry.timeline.length === 1 && entry.timeline[0]!.endedAt !== null));
    assert.equal(data.stats.merges, 2);
    assert.ok(data.events.some((event) => event.type === "run_finished"));

    const html = await (await fetch(`${server.url}/`)).text();
    assert.match(html, /智能蜂群/);
  });

  it("shows a running attempt as open and picks up events appended later", async () => {
    const repo = await makeRepo();
    await mkdir(path.join(repo, ".swarm"), { recursive: true });
    const store = new EventStore(dbPath(repo));
    store.append({ runId: "r1", type: "run_started", payload: { request: "live", baseSha: "abc", config: config() } });
    store.append({ runId: "r1", type: "plan_accepted", payload: { plan: plan([task("a", ["out/a.txt"])]) } });
    store.append({ runId: "r1", taskId: "a", attempt: 1, type: "task_state_changed", payload: { from: "pending", to: "running" } });
    store.append({ runId: "r1", taskId: "a", attempt: 1, type: "worker_started", payload: { attemptId: "x", branch: "b", worktreePath: "/tmp/w", baseSha: "abc", leaseUntil: 0, role: "worker" } });
    store.close();
    const server = await startVizServer({ repoRoot: repo, runId: "r1", port: 0 });
    servers.push(server);

    const first = await getData(server);
    assert.equal(first.state, "running");
    assert.equal(first.tasks[0]!.state, "running");
    assert.equal(first.tasks[0]!.timeline.length, 1);
    assert.equal(first.tasks[0]!.timeline[0]!.endedAt, null);

    const later = new EventStore(dbPath(repo));
    later.append({ runId: "r1", taskId: "a", attempt: 1, type: "task_state_changed", payload: { from: "running", to: "passed", branch: "b" } });
    later.close();
    const second = await getData(server);
    assert.equal(second.tasks[0]!.state, "passed");
    assert.notEqual(second.tasks[0]!.timeline[0]!.endedAt, null);
    assert.equal(second.tasks[0]!.timeline[0]!.outcome, "passed");
  });
});

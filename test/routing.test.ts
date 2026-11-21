import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { configSchema, integrationProfile, workerProfile } from "../src/schema/config.js";
import { validatePlan } from "../src/schema/plan.js";
import { eventsOf, json, makeRepo, plan, removeRepos, run, task, writes } from "./helpers.js";

afterEach(removeRepos);

describe("worker routes", () => {
  it("applies the route for a task kind over the worker defaults", () => {
    const config = configSchema.parse({
      worker: { model: "base", routes: { test: { model: "tester", reasoningEffort: "low", maxTurns: 3, maxTokens: 1000, maxWallSec: 60 } } },
      task: { maxTurns: 20, maxTokens: 30000, maxWallSec: 900 },
    });
    const profile = workerProfile(config, "test");
    assert.equal(profile.model, "tester");
    assert.equal(profile.reasoningEffort, "low");
    assert.equal(profile.maxTurns, 3);
    assert.equal(profile.maxTokens, 1000);
    assert.equal(profile.maxWallSec, 60);
    const fallback = workerProfile(config, "docs");
    assert.equal(fallback.model, "base");
    assert.equal(fallback.maxTurns, 20);
    const escalated = workerProfile(config, "docs", { model: "stronger", reasoningEffort: "high" });
    assert.equal(escalated.model, "stronger");
    assert.equal(escalated.reasoningEffort, "high");

    const anthropic = configSchema.parse({ worker: { provider: "anthropic", routes: { test: { provider: "openai" } } } });
    assert.equal(workerProfile(anthropic, "test").provider, "openai");
    assert.equal(workerProfile(anthropic, "docs").provider, "anthropic");
  });

  it("gives integration fixes their own model and budget", () => {
    const config = configSchema.parse({ integration: { model: "fixer", maxTurns: 5, maxTokens: 1000, maxWallSec: 60 } });
    const profile = integrationProfile(config);
    assert.equal(profile.model, "fixer");
    assert.equal(profile.maxTurns, 5);
    assert.equal(profile.maxTokens, 1000);
    assert.equal(profile.maxWallSec, 60);
  });

  it("defaults a planned task to the implement kind", () => {
    const plan = validatePlan({
      goal: "g",
      globalAcceptance: [],
      tasks: [{
        id: "a",
        title: "Do it",
        description: "d",
        writeScope: ["a"],
        readContext: [],
        dependsOn: [],
        acceptance: { commands: ["node -p 1"] },
        estimate: { files: 1, lines: 1 },
      }],
    }, { maxFiles: 5, maxLines: 300 });
    assert.equal(plan.tasks[0]!.kind, "implement");
  });

  it("uses the route's turn budget for the task's attempts", async () => {
    const repo = await makeRepo();
    const result = await run(repo, {
      planner: [json(plan([task("a", ["out/a.txt"])])), json({ action: "abandon", reason: "stop" })],
      tasks: { a: [writes("out/a.txt", "A")] },
    }, { maxLogicRetries: 0, worker: { routes: { implement: { maxTurns: 1 } } } });
    assert.equal(result.state, "failed");
    assert.match(String(eventsOf(repo, result.runId, "failure")[0]!.payload.errorSummary), /maxTurns \(1\)/);
  });
});

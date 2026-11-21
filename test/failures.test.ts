import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { afterEach, describe, it } from "node:test";
import path from "node:path";
import { cleanup } from "../src/core/cleanup.js";
import { resumeRun } from "../src/core/run.js";
import { configSchema } from "../src/schema/config.js";
import { EventStore } from "../src/store/events.js";
import { getBaseSha } from "../src/worker/worktree.js";
import type { SpawnAttempt } from "../src/worker/spawn.js";
import { command, dbPath, eventsOf, finish, git, json, makeRepo, plan, removeRepos, run, stateOf, task, writes } from "./helpers.js";

afterEach(removeRepos);

const needsFile = (id: string, dependsOn: string[] = []) => task(id, [`out/${id}.txt`], dependsOn, [`node expect.js out/${id}.txt ok`]);
const classes = (repo: string, runId: string, taskId?: string) => eventsOf(repo, runId, "failure", taskId).map((event) => event.payload.class);

describe("failure classes and retries", () => {
  it("transient: retries with exponential backoff and does not count as a logic failure", async () => {
    const repo = await makeRepo();
    const result = await run(repo, {
      planner: [json(plan([needsFile("a")]))],
      tasks: { a: [[{ fault: "transient" }], [{ fault: "transient" }], writes("out/a.txt", "ok")] },
    }, { maxLogicRetries: 0 });
    assert.equal(result.state, "passed", result.summary);
    assert.deepEqual(classes(repo, result.runId), ["transient", "transient"]);
    assert.deepEqual(eventsOf(repo, result.runId, "retry_scheduled").map((event) => event.payload.delayMs), [10, 20]);
    assert.equal(eventsOf(repo, result.runId, "escalated_to_planner").length, 0);
  });

  it("transient: a worker process that crashes is retried without having reported anything", async () => {
    const repo = await makeRepo();
    const result = await run(repo, { planner: [json(plan([needsFile("a")]))], tasks: { a: [[{ fault: "crash" }], writes("out/a.txt", "ok")] } });
    assert.equal(result.state, "passed", result.summary);
    const failure = eventsOf(repo, result.runId, "failure")[0]!.payload;
    assert.equal(failure.class, "transient");
    assert.match(String(failure.errorSummary), /exited without a result/);
  });

  it("logic: a failed acceptance is retried with its output, and the recovery is recorded", async () => {
    const repo = await makeRepo();
    const result = await run(repo, {
      planner: [json(plan([needsFile("a")]))],
      tasks: { a: [writes("out/a.txt", "wrong"), writes("out/a.txt", "ok")] },
    }, { task: { maxTurns: 2 } });
    assert.equal(result.state, "passed", result.summary);
    const failure = eventsOf(repo, result.runId, "failure")[0]!.payload;
    assert.equal(failure.class, "logic");
    assert.match(String(failure.errorSummary), /expected ok, got wrong/);
    assert.deepEqual(failure.relatedFiles, ["out/a.txt"]);
    assert.equal(eventsOf(repo, result.runId, "retry_scheduled")[0]?.payload.class, "logic");
    const recovered = eventsOf(repo, result.runId, "recovered")[0]!.payload;
    assert.equal(recovered.retries, 1);
    assert.match(String(recovered.diffSummary), /out\/a\.txt/);
  });

  it("logic: a task that outlives its wall-clock limit is killed", async () => {
    const repo = await makeRepo();
    const result = await run(repo, {
      planner: [json(plan([needsFile("a")])), json({ action: "abandon", reason: "too slow" })],
      tasks: { a: [[command("node sleep.js"), finish()]] },
    }, { maxLogicRetries: 0, task: { maxWallSec: 1 } });
    assert.equal(result.state, "failed");
    assert.match(String(eventsOf(repo, result.runId, "failure")[0]!.payload.errorSummary), /wall-clock limit/);
    assert.deepEqual(classes(repo, result.runId), ["logic"]);
  });

  it("stops a run when its signal is aborted", async () => {
    const repo = await makeRepo();
    const controller = new AbortController();
    const pending = run(repo, {
      planner: [json(plan([needsFile("a")]))],
      tasks: { a: [[command("node sleep.js"), finish()]] },
    }, {}, { signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    const result = await pending;
    assert.equal(result.state, "stopped");
    assert.match(String(result.reason), /cancelled/);
  });

  it("upstream: tasks behind an abandoned task are blocked and never run", async () => {
    const repo = await makeRepo();
    const result = await run(repo, {
      planner: [json(plan([needsFile("a"), needsFile("b", ["a"]), needsFile("c", ["b"])])), json({ action: "abandon", reason: "cannot be done" })],
      tasks: { a: [[finish()]] },
    }, { maxLogicRetries: 1, task: { maxTurns: 1 } });
    assert.equal(result.state, "failed");
    assert.deepEqual(result.tasks.map((entry) => `${entry.id}:${entry.state}:${entry.attempts}`), ["a:failed_escalated:2", "b:blocked:0", "c:blocked:0"]);
    assert.deepEqual(classes(repo, result.runId, "a"), ["logic", "logic"]);
    assert.deepEqual(classes(repo, result.runId, "b"), ["upstream"]);
    assert.equal(eventsOf(repo, result.runId, "escalation_decision")[0]?.payload.reason, "cannot be done");
    assert.equal(eventsOf(repo, result.runId, "merge_attempted").length, 0);
  });

  it("transient: a planner call failure is retried instead of failing the run", async () => {
    const repo = await makeRepo();
    const result = await run(repo, {
      planner: [{ fault: "transient" }, json(plan([needsFile("a")]))],
      tasks: { a: [writes("out/a.txt", "ok")] },
    });
    assert.equal(result.state, "passed", result.summary);
    assert.equal(eventsOf(repo, result.runId, "run_reopened").length, 0);
  });

  it("transient: an escalation call failure is retried instead of abandoning the task", async () => {
    const repo = await makeRepo();
    const result = await run(repo, {
      planner: [json(plan([needsFile("a")])), { fault: "transient" }, json({ action: "abandon", reason: "cannot" })],
      tasks: { a: [[finish()]] },
    }, { maxLogicRetries: 0, task: { maxTurns: 1 } });
    assert.equal(result.state, "failed");
    assert.equal(eventsOf(repo, result.runId, "escalation_decision")[0]?.payload.reason, "cannot");
    assert.doesNotMatch(String(result.reason), /planner escalation call failed/);
  });
});

describe("escalation to the planner", () => {
  it("split: subtasks replace the failed task and its dependents wait for all of them", async () => {
    const repo = await makeRepo();
    const result = await run(repo, {
      planner: [
        // a owns out/a*.txt, so b may already name the files that a's later subtasks will write.
        json(plan([task("a", ["out/a*.txt"], [], ["node expect.js out/a.txt ok"]), task("b", ["out/b.txt"], ["a"], ["node exists.js out/a1.txt out/a2.txt out/b.txt"])])),
        json({ action: "split", reason: "too big", tasks: [needsFile("a1"), needsFile("a2")] }),
      ],
      tasks: { a: [[finish()]], a1: [writes("out/a1.txt", "ok")], a2: [writes("out/a2.txt", "ok")], b: [writes("out/b.txt", "B")] },
    }, { maxLogicRetries: 0, task: { maxTurns: 2 } });
    assert.equal(result.state, "passed", result.summary);
    assert.equal(stateOf(result, "a"), "cancelled");
    assert.deepEqual(["a1", "a2", "b"].map((id) => stateOf(result, id)), ["merged", "merged", "merged"]);
    const replan = eventsOf(repo, result.runId, "replan")[0]!.payload;
    assert.deepEqual(replan.subtasks, ["a1", "a2"]);
    assert.deepEqual((replan.plan as ReturnType<typeof plan>).tasks.find((entry) => entry.id === "b")?.dependsOn, ["a1", "a2"]);
    assert.equal(git(repo, "show", `${result.integrationBranch}:out/b.txt`), "B");
  });

  it("implement: the planner does the task itself through the same acceptance gate", async () => {
    const repo = await makeRepo();
    const result = await run(repo, {
      planner: [json(plan([needsFile("a")])), json({ action: "implement" })],
      tasks: { a: [[finish()], writes("out/a.txt", "ok")] },
    }, { maxLogicRetries: 0, task: { maxTurns: 2 } });
    assert.equal(result.state, "passed", result.summary);
    assert.deepEqual(eventsOf(repo, result.runId, "worker_started").map((event) => event.payload.role), ["worker", "planner"]);
    assert.ok(eventsOf(repo, result.runId, "model_call", "a").some((event) => event.payload.phase === "planner"));
  });

  it("implement: a failed planner attempt ends the task instead of looping", async () => {
    const repo = await makeRepo();
    const result = await run(repo, {
      planner: [json(plan([needsFile("a")])), json({ action: "implement" })],
      tasks: { a: [[finish()]] },
    }, { maxLogicRetries: 0, task: { maxTurns: 1 } });
    assert.equal(result.state, "failed");
    assert.deepEqual(result.tasks, [{ id: "a", state: "failed_escalated", attempts: 2 }]);
  });

  it("retry_with: retries the task once with the escalated model", async () => {
    const repo = await makeRepo();
    const result = await run(repo, {
      planner: [json(plan([needsFile("a")])), json({ action: "retry_with", reason: "try stronger", model: "stronger" })],
      tasks: { a: [writes("out/a.txt", "wrong"), writes("out/a.txt", "ok")] },
    }, { maxLogicRetries: 0, task: { maxTurns: 2 } });
    assert.equal(result.state, "passed", result.summary);
    assert.equal(eventsOf(repo, result.runId, "escalation_decision")[0]?.payload.action, "retry_with");
    assert.deepEqual(eventsOf(repo, result.runId, "worker_started").map((event) => event.payload.role), ["worker", "worker"]);
  });
});

describe("leases and fencing", () => {
  it("reclaims a frozen worker when its lease expires", async () => {
    const repo = await makeRepo();
    const result = await run(repo, {
      planner: [json(plan([needsFile("a")]))],
      tasks: { a: [[{ fault: "freeze" }], writes("out/a.txt", "ok")] },
    }, { leaseSec: 2, heartbeatSec: 1 });
    assert.equal(result.state, "passed", result.summary);
    const failure = eventsOf(repo, result.runId, "failure")[0]!.payload;
    assert.equal(failure.class, "transient");
    assert.match(String(failure.errorSummary), /lease expired/);
    assert.ok(eventsOf(repo, result.runId, "lease_renewed").length >= 1);
  });

  it("ignores a result that arrives after the attempt lost its lease", async () => {
    const repo = await makeRepo();
    let spawned = 0;
    // The first attempt never heartbeats, cannot be killed, and reports success after its lease ran out
    // (at 1s), while the second attempt (started at ~1s, done at ~1.5s) is still running.
    const spawn: SpawnAttempt = (_init, onHeartbeat) => {
      if (++spawned === 1) return { result: new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 1200)), kill: () => {} };
      onHeartbeat();
      return { result: new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 500)), kill: () => {} };
    };
    const result = await run(repo, { planner: [json(plan([task("a", ["out/a.txt"])]))], tasks: {} }, { leaseSec: 1 }, { spawn });
    assert.equal(result.state, "passed", result.summary);
    const started = eventsOf(repo, result.runId, "worker_started");
    const passed = eventsOf(repo, result.runId, "task_state_changed").filter((event) => event.payload.to === "passed");
    assert.equal(started.length, 2);
    assert.equal(passed.length, 1);
    assert.equal(passed[0]!.payload.attemptId, started[1]!.payload.attemptId);
    assert.ok(Date.parse(passed[0]!.ts) - Date.parse(started[1]!.ts) >= 450, "the late result must not complete the new attempt early");
    assert.match(String(eventsOf(repo, result.runId, "failure")[0]!.payload.errorSummary), /lease expired/);
  });
});

describe("budget guards and cleanup", () => {
  it("stops the run when the estimated cost passes run.maxCostUsd", async () => {
    const repo = await makeRepo();
    // Every mock call is 20 tokens = $20: planning fits the $30 limit, the first worker call does not.
    const result = await run(repo, {
      planner: [json(plan([needsFile("a"), needsFile("b", ["a"])]))],
      tasks: { a: [writes("out/a.txt", "ok")], b: [writes("out/b.txt", "ok")] },
    }, { run: { maxCostUsd: 30 }, pricing: { mock: { inputPerMillion: 1_000_000, outputPerMillion: 1_000_000 } } });
    assert.equal(result.state, "stopped");
    assert.match(String(result.reason), /exceeded run\.maxCostUsd/);
    assert.equal(eventsOf(repo, result.runId, "worker_started", "b").length, 0);
    assert.equal(eventsOf(repo, result.runId, "run_finished")[0]?.payload.state, "stopped");

    const resumed = await resumeRun({
      repoRoot: repo,
      runId: result.runId,
      maxCostUsd: 200,
      tickMs: 20,
      scripts: { planner: [], tasks: { a: [writes("out/a.txt", "ok")], b: [writes("out/b.txt", "ok")] } },
    });
    assert.equal(resumed.state, "passed", resumed.summary);
    assert.equal(eventsOf(repo, result.runId, "run_config_updated")[0]?.payload.maxCostUsd, 200);
  });

  it("stops calling the planner when the cost limit is crossed during a burst of escalations", async () => {
    const repo = await makeRepo();
    await mkdir(path.join(repo, ".swarm"), { recursive: true });
    // A resumed run with two escalations already pending: both are settled in the same step-5 loop.
    // Planning cost $20 of a $25 limit, and the first escalation another $20, so the second one must not
    // be paid for.
    const config = configSchema.parse({ run: { maxCostUsd: 25 }, pricing: { mock: { inputPerMillion: 1_000_000, outputPerMillion: 1_000_000 } } });
    const runId = "escalation-burst";
    const store = new EventStore(dbPath(repo));
    store.append({ runId, type: "run_started", payload: { request: "test", baseSha: getBaseSha(repo), dirty: false, config } });
    store.append({ runId, type: "plan_accepted", payload: { plan: plan([task("a", ["out/a.txt"]), task("b", ["out/b.txt"])]) } });
    store.append({ runId, type: "model_call", payload: { phase: "planning", model: "mock", usage: { inputTokens: 10, outputTokens: 10 } } });
    for (const id of ["a", "b"]) {
      store.append({ runId, taskId: id, attempt: 1, type: "failure", payload: { class: "logic", errorSummary: "boom", relatedFiles: [], attempt: 1 } });
      store.append({ runId, taskId: id, attempt: 1, type: "escalated_to_planner", payload: { kind: "task", class: "logic", reason: "boom" } });
      store.append({ runId, taskId: id, attempt: 1, type: "task_state_changed", payload: { from: "running", to: "failed_escalated" } });
    }
    store.close();
    const result = await resumeRun({ repoRoot: repo, runId, scripts: { planner: [json({ action: "abandon", reason: "test" })] }, tickMs: 20 });
    assert.equal(result.state, "failed");
    const decisions = eventsOf(repo, runId, "escalation_decision").map((event) => event.payload);
    assert.equal(decisions[0]!.action, "abandon");
    assert.equal(decisions[1]!.reason, "run cost limit reached before escalation");
  });

  it("cleanup removes expired failed attempts but keeps passed branches and fresh failures", async () => {
    const repo = await makeRepo();
    const result = await run(repo, {
      planner: [json(plan([needsFile("a")]))],
      tasks: { a: [[finish()], writes("out/a.txt", "ok")] },
    }, { task: { maxTurns: 2 } });
    assert.equal(result.state, "passed", result.summary);
    const [failed, passed] = eventsOf(repo, result.runId, "worker_started").map((event) => event.payload as { branch: string; worktreePath: string });
    assert.ok(existsSync(failed!.worktreePath), "a failed worktree is kept for debugging");
    assert.equal(existsSync(passed!.worktreePath), false, "a passed worktree is removed at once");

    const store = new EventStore(dbPath(repo));
    try {
      assert.deepEqual(cleanup(repo, store), { removedWorktrees: [], removedBranches: [] });
      const later = Date.now() + 61 * 60_000;
      assert.deepEqual(cleanup(repo, store, later), { removedWorktrees: [failed!.worktreePath], removedBranches: [failed!.branch] });
    } finally {
      store.close();
    }
    assert.equal(existsSync(failed!.worktreePath), false);
    const branches = git(repo, "branch", "--list", "swarm/*");
    assert.ok(branches.includes(passed!.branch) && branches.includes("integration") && !branches.includes(failed!.branch));
  });

  it("removes finished run branches after keepBranchesMinutes", async () => {
    const repo = await makeRepo();
    const result = await run(repo, {
      planner: [json(plan([needsFile("a")]))],
      tasks: { a: [writes("out/a.txt", "ok")] },
    }, { keepBranchesMinutes: 1 });
    assert.equal(result.state, "passed", result.summary);
    const store = new EventStore(dbPath(repo));
    try {
      const removed = cleanup(repo, store, Date.now() + 2 * 60_000);
      assert.ok(removed.removedBranches.some((branch) => branch.includes(result.runId)));
    } finally {
      store.close();
    }
    assert.equal(git(repo, "branch", "--list", "swarm/*"), "");
  });
});

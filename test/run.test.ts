import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { afterEach, describe, it } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MockClient, mockTool } from "../src/models/client.js";
import { defaultConfig } from "../src/schema/config.js";
import type { Task } from "../src/schema/plan.js";
import { EventStore } from "../src/store/events.js";
import { runWorker } from "../src/worker/runtime.js";
import { dryRunScripts, resumeRun, startRun } from "../src/core/run.js";
import { summarizeRun } from "../src/cli/report.js";
import { snapshotWorkingTree } from "../src/worker/worktree.js";
import { command, config, dbPath, eventsOf, finish, git, json, makeRepo, plan, removeRepos, run, stateOf, task, write, writes } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  await removeRepos();
});

describe("parallel run and integration", () => {
  it("runs the scripted dry run end to end without touching the user's branch", async () => {
    const repo = await makeRepo();
    const head = git(repo, "rev-parse", "HEAD");
    const result = await startRun({ repoRoot: repo, request: "smoke", config: config(), scripts: dryRunScripts(), tickMs: 20 });
    assert.equal(result.state, "passed");
    assert.match(result.summary, /git merge swarm\/.+\/integration/);
    assert.equal(git(repo, "rev-parse", "HEAD"), head);
    assert.equal(git(repo, "status", "--porcelain"), "");
    assert.equal(git(repo, "worktree", "list").split("\n").length, 1);
    assert.equal(git(repo, "show", `${result.integrationBranch}:swarm-dry-run/t3.txt`), "t3");
  });

  it("runs a supplied plan without calling the planner", async () => {
    const repo = await makeRepo();
    const supplied = plan([task("a", ["out/a.txt"])]);
    const result = await startRun({ repoRoot: repo, request: "approved plan", config: config(), plan: supplied, tickMs: 20, scripts: { planner: [], tasks: { a: [writes("out/a.txt", "A")] } } });
    assert.equal(result.state, "passed", result.summary);
    assert.equal(eventsOf(repo, result.runId, "model_call").filter((event) => event.payload.phase === "planning").length, 0);
    assert.equal(eventsOf(repo, result.runId, "plan_accepted").length, 1);
    assert.equal(git(repo, "show", `${result.integrationBranch}:out/a.txt`), "A");
  });

  it("runs independent tasks in parallel and starts dependents from their dependencies' merged result", async () => {
    const repo = await makeRepo();
    const result = await run(repo, {
      planner: [json(plan([
        task("a", ["out/a.txt"]),
        task("b", ["out/b.txt"]),
        // c can only pass if its worktree already contains what a and b produced.
        task("c", ["out/c.txt"], ["a", "b"], ["node exists.js out/a.txt out/b.txt out/c.txt"]),
      ], ["node exists.js out/a.txt out/b.txt out/c.txt"]))],
      tasks: { a: [writes("out/a.txt", "A")], b: [writes("out/b.txt", "B")], c: [writes("out/c.txt", "C")] },
    });
    assert.equal(result.state, "passed", result.summary);
    assert.deepEqual(result.tasks.map((entry) => entry.state), ["merged", "merged", "merged"]);
    const order = eventsOf(repo, result.runId).filter((event) => event.type === "worker_started" || (event.type === "task_state_changed" && event.payload.to === "passed")).map((event) => `${event.type}:${event.taskId}`);
    assert.deepEqual(order.slice(0, 2), ["worker_started:a", "worker_started:b"]);
    assert.equal(order.at(-2), "worker_started:c");
    assert.equal(git(repo, "show", `${result.integrationBranch}:out/c.txt`), "C");
    assert.deepEqual(eventsOf(repo, result.runId, "merge_attempted").map((event) => event.taskId), ["a", "b", "c"]);
    assert.ok(eventsOf(repo, result.runId, "acceptance_run").some((event) => event.payload.scope === "global" && event.payload.exitCode === 0));
  });

  it("links node_modules into the integration worktree", async () => {
    const repo = await makeRepo({
      ".gitignore": "node_modules/\n.swarm/\n",
      "node_modules/marker/index.js": "module.exports = 1\n",
    });
    const result = await run(repo, {
      planner: [json(plan([task("a", ["out/a.txt"], [], ["node -e \"require('marker')\""])], ["node -e \"require('marker')\""]))],
      tasks: { a: [writes("out/a.txt", "A")] },
    }, { worktree: { linkNodeModules: true } });
    assert.equal(result.state, "passed", result.summary);
  });

  it("starts from the working tree, uncommitted and untracked files included", async () => {
    const repo = await makeRepo({ "src/base.txt": "base\n" });
    await writeFile(path.join(repo, "src/base.txt"), "edited\n");
    await writeFile(path.join(repo, "src/untracked.txt"), "new\n");
    const statusBefore = git(repo, "status", "--porcelain");
    const result = await run(repo, {
      planner: [json(plan([task("a", ["out/a.txt"], [], ["node expect.js src/base.txt edited", "node expect.js src/untracked.txt new"])]))],
      tasks: { a: [writes("out/a.txt", "ok")] },
    });
    assert.equal(result.state, "passed", result.summary);
    assert.equal(eventsOf(repo, result.runId, "run_started")[0]!.payload.dirty, true);
    const baseDiff = eventsOf(repo, result.runId, "run_started")[0]!.payload.baseDiff as { changed: string[]; deleted: string[] };
    assert.ok(baseDiff.changed.includes("src/base.txt"));
    assert.ok(baseDiff.changed.includes("src/untracked.txt"));
    assert.deepEqual(baseDiff.deleted, []);
    assert.ok(git(repo, "rev-parse", `refs/swarm/${result.runId}/base`));
    assert.equal(git(repo, "status", "--porcelain"), statusBefore);
    assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  });

  it("leaves the tool's own .swarm directory out of the snapshot even when it is not ignored", async () => {
    const repo = await makeRepo();
    await writeFile(path.join(repo, ".gitignore"), "node_modules/\n");
    await mkdir(path.join(repo, ".swarm"));
    await writeFile(path.join(repo, ".swarm", "events.sqlite"), "db");
    await writeFile(path.join(repo, "notes.txt"), "x");
    const sha = snapshotWorkingTree(repo, "snapshot-test");
    const tree = git(repo, "ls-tree", "-r", "--name-only", sha);
    assert.match(tree, /notes\.txt/);
    assert.doesNotMatch(tree, /\.swarm/);
    assert.equal(git(repo, "rev-parse", `refs/swarm/snapshot-test/base`), sha);
  });

  it("keeps tracked files that match an ignore rule in the snapshot", async () => {
    const repo = await makeRepo({ "keep.txt": "keep\n" });
    await writeFile(path.join(repo, ".gitignore"), "keep.txt\n.swarm/\n");
    git(repo, "add", ".gitignore");
    git(repo, "commit", "-qm", "ignore keep");
    const sha = snapshotWorkingTree(repo, "ignored-tracked");
    assert.equal(git(repo, "show", `${sha}:keep.txt`), "keep");
  });

  it("allows a tracked file the user deleted from the working tree", async () => {
    const repo = await makeRepo({ "gone.txt": "x\n" });
    await rm(path.join(repo, "gone.txt"));
    const sha = snapshotWorkingTree(repo, "deleted-test");
    assert.throws(() => git(repo, "show", `${sha}:gone.txt`));
  });

  it("snapshots working-tree bytes without autocrlf normalization", async () => {
    const repo = await makeRepo({ "crlf.txt": "line1\nline2\n" });
    await writeFile(path.join(repo, "crlf.txt"), "line1\r\nline2\r\n");
    git(repo, "config", "core.autocrlf", "false");
    git(repo, "add", "crlf.txt");
    git(repo, "commit", "-qm", "crlf");
    git(repo, "config", "core.autocrlf", "input");
    const sha = snapshotWorkingTree(repo, "crlf-test");
    assert.match(git(repo, "show", `${sha}:crlf.txt`), /\r\n/);
  });

  it("gives the planner the repository so it can inspect files before planning", async () => {
    const repo = await makeRepo({ "src/feature.ts": "export const flag = true;\n" });
    const result = await run(repo, {
      planner: [mockTool("read_file", { path: "src/feature.ts" }), json(plan([task("a", ["out/a.txt"])]))],
      tasks: { a: [writes("out/a.txt", "ok")] },
    });
    assert.equal(result.state, "passed", result.summary);
    const call = eventsOf(repo, result.runId, "tool_call")[0]!;
    assert.equal(call.payload.phase, "planning");
    assert.equal(call.payload.tool, "read_file");
    assert.match(String(call.payload.resultSummary), /flag = true/);
  });

  it("lets the worker edit part of an existing file instead of rewriting it", async () => {
    const repo = await makeRepo({ "src/keep.txt": "alpha\nbeta\ngamma\n" });
    const result = await run(repo, {
      planner: [json(plan([task("a", ["src/keep.txt"], [], ["node contains.js src/keep.txt BETA", "node contains.js src/keep.txt alpha"])]))],
      tasks: { a: [[mockTool("read_file", { path: "src/keep.txt" }), mockTool("edit_file", { path: "src/keep.txt", old: "beta", new: "BETA" }), finish()]] },
    });
    assert.equal(result.state, "passed", result.summary);
    assert.equal(git(repo, "show", `${result.integrationBranch}:src/keep.txt`), "alpha\nBETA\ngamma");
    const edit = eventsOf(repo, result.runId, "tool_call").find((event) => event.payload.tool === "edit_file");
    assert.deepEqual(edit?.payload.resultSummary, { replaced: 1 });
  });

  it("never runs more tasks at once than maxConcurrency", async () => {
    const repo = await makeRepo();
    const result = await run(repo, {
      planner: [json(plan([task("a", ["out/a.txt"]), task("b", ["out/b.txt"]), task("c", ["out/c.txt"])]))],
      tasks: { a: [writes("out/a.txt", "A")], b: [writes("out/b.txt", "B")], c: [writes("out/c.txt", "C")] },
    }, { maxConcurrency: 1 });
    assert.equal(result.state, "passed", result.summary);
    let running = 0;
    for (const event of eventsOf(repo, result.runId, "task_state_changed")) {
      if (event.payload.to === "running") running += 1;
      if (event.payload.from === "running") running -= 1;
      assert.ok(running <= 1);
    }
  });

  it("discards an attempt that changed files outside writeScope, retries, and records the recovery", async () => {
    const repo = await makeRepo();
    const result = await run(repo, {
      planner: [json(plan([task("a", ["out/a.txt"])]))],
      tasks: { a: [[command("node mess.js"), ...writes("out/a.txt", "A")], writes("out/a.txt", "A")] },
    });
    assert.equal(result.state, "passed", result.summary);
    assert.deepEqual(eventsOf(repo, result.runId, "scope_violation")[0]?.payload.files, ["stray.txt"]);
    assert.equal(eventsOf(repo, result.runId, "failure")[0]?.payload.class, "scope_violation");
    const recovered = eventsOf(repo, result.runId, "recovered")[0]!.payload;
    assert.equal(recovered.retries, 1);
    assert.match(String(recovered.diffSummary), /stray\.txt/);
    assert.throws(() => git(repo, "show", `${result.integrationBranch}:stray.txt`));
  });

  it("keeps the in-scope work of a scope violation on retry", async () => {
    const repo = await makeRepo();
    const result = await run(repo, {
      planner: [json(plan([task("a", ["out/a.txt"], [], ["node expect.js out/a.txt A"])]))],
      tasks: { a: [[write("out/a.txt", "A"), command("node mess.js"), finish()], [finish()]] },
    }, { task: { maxTurns: 3 } });
    assert.equal(result.state, "passed", result.summary);
    assert.deepEqual(eventsOf(repo, result.runId, "scope_violation")[0]?.payload.files, ["stray.txt"]);
    assert.equal(eventsOf(repo, result.runId, "worker_started").length, 2);
    assert.equal(git(repo, "show", `${result.integrationBranch}:out/a.txt`), "A");
    assert.throws(() => git(repo, "show", `${result.integrationBranch}:stray.txt`));
  });

  it("resumes a run whose scheduler process was killed, without redoing finished tasks", async () => {
    const repo = await makeRepo();
    const options = {
      repoRoot: repo,
      request: "resume me",
      config: config({ leaseSec: 2, heartbeatSec: 1 }),
      tickMs: 20,
      scripts: {
        planner: [json(plan([task("a", ["out/a.txt"]), task("b", ["out/b.txt"], ["a"])]))],
        // b hangs in a long command, so the run is guaranteed to be mid-flight when it is killed.
        tasks: { a: [writes("out/a.txt", "A")], b: [[command("node sleep.js"), finish()]] },
      },
    };
    await mkdir(path.join(repo, ".swarm"));
    const runner = fork(fileURLToPath(new URL("./fixtures/runner.ts", import.meta.url)), [JSON.stringify(options)], { stdio: "ignore" });
    const store = new EventStore(dbPath(repo));
    let runId: string | undefined;
    try {
      for (let waited = 0; ; waited += 50) {
        assert.ok(waited < 20000, "run never reached task b");
        runId = store.latestRunId();
        if (runId && store.list({ runId, taskId: "b", type: "model_call" }).length) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      store.close();
      runner.kill("SIGKILL");
      await new Promise((resolve) => runner.once("exit", resolve));
    }

    const result = await resumeRun({ repoRoot: repo, runId: runId!, tickMs: 20, scripts: { planner: [], tasks: { b: [writes("out/b.txt", "B")] } } });
    assert.equal(result.state, "passed", result.summary);
    assert.deepEqual(result.tasks.map((entry) => entry.attempts), [1, 2]);
    const failure = eventsOf(repo, runId!, "failure", "b")[0]!.payload;
    assert.equal(failure.class, "transient");
    assert.match(String(failure.errorSummary), /lease expired/);
    assert.equal(git(repo, "show", `${result.integrationBranch}:out/b.txt`), "B");
    await assert.rejects(resumeRun({ repoRoot: repo, runId: runId!, scripts: { planner: [], tasks: {} } }), /already finished/);
  });

  it("resumes a run that finished failed and retries its unfinished tasks", async () => {
    const repo = await makeRepo();
    const first = await run(repo, {
      planner: [json(plan([task("a", ["out/a.txt"], [], ["node expect.js out/a.txt ok"])])), json({ action: "abandon", reason: "first try" })],
      tasks: { a: [writes("out/a.txt", "wrong")] },
    }, { maxLogicRetries: 0, task: { maxTurns: 2 } });
    assert.equal(first.state, "failed");
    const second = await resumeRun({ repoRoot: repo, runId: first.runId, tickMs: 20, scripts: { planner: [], tasks: { a: [writes("out/a.txt", "ok")] } } });
    assert.equal(second.state, "passed", second.summary);
    assert.equal(eventsOf(repo, first.runId, "run_reopened").length, 1);
    assert.equal(git(repo, "show", `${second.integrationBranch}:out/a.txt`), "ok");
  });

  it("integrates the tasks that passed even when another task fails", async () => {
    const repo = await makeRepo();
    const result = await run(repo, {
      planner: [json(plan([task("a", ["out/a.txt"]), task("b", ["out/b.txt"], [], ["node expect.js out/b.txt ok"])])), json({ action: "abandon", reason: "give up" })],
      tasks: { a: [writes("out/a.txt", "A")], b: [writes("out/b.txt", "wrong")] },
    }, { maxLogicRetries: 0, task: { maxTurns: 2 } });
    assert.equal(result.state, "failed");
    assert.ok(result.integrationBranch);
    assert.match(result.summary, /Partial result/);
    assert.equal(git(repo, "show", `${result.integrationBranch}:out/a.txt`), "A");
    assert.throws(() => git(repo, "show", `${result.integrationBranch}:out/b.txt`));
  });

  it("refuses to resume a run that another live scheduler process is driving", async () => {
    const repo = await makeRepo();
    await mkdir(path.join(repo, ".swarm"));
    const store = new EventStore(dbPath(repo));
    store.append({ runId: "busy", type: "run_started", payload: { request: "x", baseSha: git(repo, "rev-parse", "HEAD"), config: config() } });
    store.append({ runId: "busy", type: "scheduler_started", payload: { pid: process.ppid } });
    store.close();
    await assert.rejects(resumeRun({ repoRoot: repo, runId: "busy", scripts: { planner: [], tasks: {} } }), /still being driven by process/);
    await assert.rejects(resumeRun({ repoRoot: repo, runId: "nope", scripts: { planner: [], tasks: {} } }), /unknown run/);
  });

  /** A run whose two tasks already passed on branches that both rewrote shared.txt: only integration is left. */
  async function conflictingRun(): Promise<{ repo: string; runId: string }> {
    const repo = await makeRepo({ "shared.txt": "base\n" });
    const runId = "conflict-run";
    const tasks = [task("a", ["shared.txt"]), task("b", ["shared.txt"], ["a"])];
    await mkdir(path.join(repo, ".swarm"));
    const store = new EventStore(dbPath(repo));
    const emit = (type: string, payload: Record<string, unknown>, taskId?: string): void => {
      store.append({ runId, type, payload, ...(taskId ? { taskId } : {}) });
    };
    emit("run_started", { request: "conflict", baseSha: git(repo, "rev-parse", "HEAD"), config: config() });
    emit("plan_accepted", { plan: plan(tasks) });
    for (const { id } of tasks) {
      const branch = `swarm/${runId}/${id}/x`;
      git(repo, "checkout", "-q", "-b", branch, "main");
      await writeFile(path.join(repo, "shared.txt"), `${id}\n`);
      git(repo, "commit", "-q", "-am", id);
      emit("task_state_changed", { from: "running", to: "passed", branch }, id);
    }
    git(repo, "checkout", "-q", "main");
    store.close();
    return { repo, runId };
  }

  it("refuses integration changes outside every task's writeScope", async () => {
    const repo = await makeRepo();
    const runId = "guard-run";
    await mkdir(path.join(repo, ".swarm"));
    const store = new EventStore(dbPath(repo));
    const emit = (type: string, payload: Record<string, unknown>, taskId?: string): void => {
      store.append({ runId, type, payload, ...(taskId ? { taskId } : {}) });
    };
    emit("run_started", { request: "guard", baseSha: git(repo, "rev-parse", "HEAD"), config: config() });
    emit("plan_accepted", { plan: plan([task("a", ["out/a.txt"])]) });
    const branch = `swarm/${runId}/a/x`;
    git(repo, "checkout", "-q", "-b", branch, "main");
    await mkdir(path.join(repo, "out"), { recursive: true });
    await writeFile(path.join(repo, "out/a.txt"), "A\n");
    await writeFile(path.join(repo, "stray.txt"), "x\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "task");
    emit("task_state_changed", { from: "running", to: "passed", branch }, "a");
    git(repo, "checkout", "-q", "main");
    store.close();
    const result = await resumeRun({ repoRoot: repo, runId, tickMs: 20, scripts: { planner: [], tasks: {} } });
    assert.equal(result.state, "failed");
    assert.match(String(result.reason), /outside every task's writeScope/);
    assert.equal(eventsOf(repo, runId, "integration_guard_failed").length, 1);
  });

  it("hands a merge conflict to the planner and continues integrating with its resolution", async () => {
    const { repo, runId } = await conflictingRun();
    const result = await resumeRun({ repoRoot: repo, runId, tickMs: 20, scripts: { planner: [], tasks: { "@merge-b": [writes("shared.txt", "a+b\n")] } } });
    assert.equal(result.state, "passed", result.summary);
    assert.deepEqual(eventsOf(repo, runId, "merge_conflict")[0]?.payload.files, ["shared.txt"]);
    assert.equal(eventsOf(repo, runId, "escalated_to_planner")[0]?.payload.kind, "merge_conflict");
    assert.equal(git(repo, "show", `${result.integrationBranch}:shared.txt`), "a+b");
    assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  });

  it("retries a conflict resolution that leaves the conflict markers", async () => {
    const { repo, runId } = await conflictingRun();
    const result = await resumeRun({ repoRoot: repo, runId, tickMs: 20, scripts: { planner: [], tasks: { "@merge-b": [[finish()], writes("shared.txt", "a+b")] } } });
    assert.equal(result.state, "passed", result.summary);
    assert.equal(eventsOf(repo, runId, "escalated_to_planner").filter((event) => event.payload.kind === "merge_conflict").length, 2);
    assert.equal(git(repo, "show", `${result.integrationBranch}:shared.txt`), "a+b");
  });

  it("fails the run when the planner leaves the conflict unresolved", async () => {
    const { repo, runId } = await conflictingRun();
    const result = await resumeRun({ repoRoot: repo, runId, tickMs: 20, scripts: { planner: [], tasks: { "@merge-b": [[finish()]] } } });
    assert.equal(result.state, "failed");
    assert.match(String(result.reason), /merge conflict while merging b/);
    assert.equal(git(repo, "worktree", "list").split("\n").length, 1);
  });

  it("escalates a global acceptance failure to the planner only after every task is merged", async () => {
    const repo = await makeRepo();
    const scripts = (fix: ReturnType<typeof writes>) => ({
      planner: [json(plan([task("a", ["out/a.txt"]), task("b", ["out/b.txt"])], ["node expect.js out/a.txt fixed"]))],
      tasks: { a: [writes("out/a.txt", "draft")], b: [writes("out/b.txt", "B")], "@integration": [fix] },
    });
    const result = await run(repo, scripts(writes("out/a.txt", "fixed")));
    assert.equal(result.state, "passed", result.summary);
    const log = eventsOf(repo, result.runId);
    const globalFailure = log.find((event) => event.type === "failure" && event.payload.scope === "global_acceptance")!;
    assert.deepEqual(globalFailure.payload.suspectTasks, ["a"]);
    assert.ok(log.findIndex((event) => event.id === globalFailure.id) > log.findLastIndex((event) => event.type === "merge_attempted"));
    assert.equal(git(repo, "show", `${result.integrationBranch}:out/a.txt`), "fixed");

    const store = new EventStore(dbPath(repo));
    try {
      assert.ok(summarizeRun(store, result.runId).tasks.some((task) => task.taskId === "@integration"));
    } finally {
      store.close();
    }

    const unfixed = await run(repo, scripts([finish()]));
    assert.equal(unfixed.state, "failed");
    assert.match(String(unfixed.reason), /global acceptance failed/);
  });

  it("retries the global acceptance fix with the previous failure", async () => {
    const repo = await makeRepo();
    const result = await run(repo, {
      planner: [json(plan([task("a", ["out/a.txt"])], ["node expect.js out/a.txt fixed"]))],
      tasks: { a: [writes("out/a.txt", "draft")], "@integration": [writes("out/a.txt", "wrong"), writes("out/a.txt", "fixed")] },
    }, { maxLogicRetries: 1 });
    assert.equal(result.state, "passed", result.summary);
    assert.equal(eventsOf(repo, result.runId, "escalated_to_planner").filter((event) => event.payload.kind === "global_acceptance").length, 2);
    assert.equal(git(repo, "show", `${result.integrationBranch}:out/a.txt`), "fixed");
  });

  it("ignores a global acceptance failure that was already there with baselinePolicy ignore-existing", async () => {
    const repo = await makeRepo({ "broken.txt": "wrong\n" });
    const result = await run(repo, {
      planner: [json(plan([task("a", ["out/a.txt"], [], ["node exists.js out/a.txt"])], ["node expect.js broken.txt ok"]))],
      tasks: { a: [writes("out/a.txt", "A")] },
    }, { run: { baselinePolicy: "ignore-existing" } });
    assert.equal(result.state, "passed", result.summary);
    assert.equal(eventsOf(repo, result.runId, "baseline_recorded").length, 1);
    assert.equal(eventsOf(repo, result.runId, "baseline_failure").length, 1);
    assert.match(String(result.warnings?.[0]), /pre-existing/);
  });

  it("still blocks a regression under baselinePolicy ignore-existing", async () => {
    const repo = await makeRepo({ "check.txt": "ok\n" });
    const result = await run(repo, {
      planner: [json(plan([task("a", ["check.txt"])], ["node expect.js check.txt ok"]))],
      tasks: { a: [writes("check.txt", "broken")], "@integration": [[finish()]] },
    }, { run: { baselinePolicy: "ignore-existing" } });
    assert.equal(result.state, "failed");
    const failure = eventsOf(repo, result.runId, "failure").find((event) => event.payload.scope === "global_acceptance");
    assert.ok(failure);
    assert.equal(failure.payload.preexistingCommands, undefined);
  });

  it("does not treat a failing command for a task-written file as pre-existing", async () => {
    const repo = await makeRepo();
    const result = await run(repo, {
      planner: [json(plan([task("a", ["out/a.txt"])], ["node expect.js out/a.txt B"]))],
      tasks: { a: [writes("out/a.txt", "A")], "@integration": [[finish()]] },
    }, { run: { baselinePolicy: "ignore-existing" } });
    assert.equal(result.state, "failed");
  });
});

describe("runWorker", () => {
  async function worktree(): Promise<{ dir: string; events: EventStore }> {
    const root = await mkdtemp(path.join(os.tmpdir(), "swarm-worker-"));
    roots.push(root);
    await mkdir(path.join(root, "worktree"));
    return { dir: path.join(root, "worktree"), events: new EventStore(path.join(root, "events.sqlite")) };
  }
  const scoped: Task = task("t1", ["allowed.txt"]);

  it("returns a rejected out-of-scope write to the model and logs it", async () => {
    const { dir, events } = await worktree();
    const client = new MockClient([mockTool("write_file", { path: "blocked.txt", content: "x" }), mockTool("finish")]);
    await runWorker({ client, task: scoped, worktreePath: dir, config: defaultConfig, events, runId: "r1", attemptId: "a1", attempt: 1 });
    assert.ok(client.calls[1]?.messages.some((message) => message.role === "tool" && message.content.includes("writeScope")));
    assert.ok(events.list({ runId: "r1" }).some((event) => event.type === "scope_violation"));
    assert.equal(existsSync(path.join(dir, "blocked.txt")), false);
    events.close();
  });

  it("answers every tool call of a turn, including finish and calls made after it", async () => {
    const { dir, events } = await worktree();
    const turn = { ...mockTool("finish"), toolCalls: [{ id: "c1", name: "finish", arguments: {} }, { id: "c2", name: "list_dir", arguments: {} }] };
    const client = new MockClient([turn]);
    await runWorker({ client, task: scoped, worktreePath: dir, config: defaultConfig, events, runId: "r1", attemptId: "a1", attempt: 1 });
    const results = client.calls[0]!.messages.filter((message) => message.role === "tool");
    assert.deepEqual(results.map((message) => message.toolCallId), ["c1", "c2"]);
    assert.match(results[1]!.content, /Skipped/);
    events.close();
  });

  it("gives the worker the previous attempt's failure and stops at the token budget", async () => {
    const { dir, events } = await worktree();
    const client = new MockClient([mockTool("list_dir"), mockTool("finish")]);
    const params = { client, task: scoped, worktreePath: dir, events, runId: "r1", attemptId: "a1", attempt: 2, previousFailure: "node check.js exited 1: boom" };
    await assert.rejects(runWorker({ ...params, config: config({ task: { maxTokens: 30 } }) }), /task token budget exceeded \(40 > 30\)/);
    assert.match(client.calls[0]!.messages[1]!.content, /previousAttemptFailure.*boom/);
    events.close();
  });

  it("shows the project conventions to the worker", async () => {
    const { dir, events } = await worktree();
    const client = new MockClient([mockTool("finish")]);
    await runWorker({ client, task: scoped, worktreePath: dir, config: defaultConfig, context: "AGENTS.md (first 3000 characters):\nUse tabs.", events, runId: "r1", attemptId: "a1", attempt: 1 });
    assert.match(client.calls[0]!.messages[0]!.content, /Use tabs/);
    events.close();
  });

  it("compacts older tool output when the context grows", async () => {
    const { dir, events } = await worktree();
    const client = new MockClient([...Array.from({ length: 10 }, () => mockTool("list_dir")), mockTool("finish")]);
    await runWorker({ client, task: scoped, worktreePath: dir, config: config({ task: { maxContextChars: 100 } }), events, runId: "r1", attemptId: "a1", attempt: 1 });
    const messages = client.calls.at(-1)!.messages;
    assert.ok(messages.some((message) => message.role === "tool" && message.content === "[older tool output omitted]"));
    events.close();
  });

  it("deletes a file inside writeScope and refuses one outside", async () => {
    const { dir, events } = await worktree();
    await writeFile(path.join(dir, "allowed.txt"), "x");
    await writeFile(path.join(dir, "blocked.txt"), "x");
    const client = new MockClient([
      mockTool("delete_file", { path: "allowed.txt" }),
      mockTool("delete_file", { path: "blocked.txt" }),
      mockTool("finish"),
    ]);
    await runWorker({ client, task: scoped, worktreePath: dir, config: defaultConfig, events, runId: "r1", attemptId: "a1", attempt: 1 });
    assert.equal(existsSync(path.join(dir, "allowed.txt")), false);
    assert.equal(existsSync(path.join(dir, "blocked.txt")), true);
    events.close();
  });
});

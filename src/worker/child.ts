import { MockClient, TransientError } from "../models/client.js";
import { createClient } from "../models/factory.js";
import { EventStore } from "../store/events.js";
import { runWorker } from "./runtime.js";
import type { AttemptInit, ChildResult } from "./spawn.js";

// Entry point of a worker process. It only runs the agent loop and acceptance; the scheduler
// alone decides task state and commits, so a stale worker can never change either.

// The scheduler died: stop working. The lease expires and the attempt is rerun from a clean worktree.
process.on("disconnect", () => process.exit(1));

process.once("message", (init: AttemptInit) => {
  process.send?.({ type: "heartbeat" });
  const heartbeat = setInterval(() => process.send?.({ type: "heartbeat" }), init.config.heartbeatSec * 1000);
  const events = new EventStore(init.dbPath);
  // A missing key or model fails the attempt like any other error, instead of crashing the process.
  const model = Promise.resolve().then(() => (init.client.kind === "mock"
    ? { client: new MockClient(init.client.script), model: "mock" }
    : createClient(init.role, init.config, init.role === "worker" || init.useProfile ? init.profile : {})));
  model.then(({ client, model: modelName }) => runWorker({
    client,
    task: init.task,
    worktreePath: init.worktreePath,
    config: init.config,
    profile: init.profile,
    context: init.context,
    events,
    runId: init.runId,
    attemptId: init.attemptId,
    attempt: init.attempt,
    modelName,
    phase: init.role,
    ...(init.previousFailure ? { previousFailure: init.previousFailure } : {}),
  })).then(
    (): ChildResult => ({ ok: true }),
    (error: unknown): ChildResult => ({
      ok: false,
      class: error instanceof TransientError ? "transient" : "logic",
      errorSummary: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
    }),
  ).then((result) => {
    clearInterval(heartbeat);
    events.close();
    process.send?.({ type: "result", ...result }, undefined, undefined, () => process.exit(0));
  });
});

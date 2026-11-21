import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { MockStep } from "../models/client.js";
import type { SwarmConfig } from "../schema/config.js";
import type { WorkerProfile } from "../schema/config.js";
import type { Task } from "../schema/plan.js";

/** Everything a worker process needs; sent once over IPC. `client` is the extension point for real adapters. */
export interface AttemptInit {
  dbPath: string;
  runId: string;
  task: Task;
  worktreePath: string;
  attemptId: string;
  attempt: number;
  role: "worker" | "planner";
  config: SwarmConfig;
  /** Model and budgets for this task's kind. */
  profile: WorkerProfile;
  /** Use `profile` for the client too (integration fixes), not only for budgets. */
  useProfile?: boolean;
  /** Project conventions shown to the worker (AGENTS.md/CLAUDE.md/README.md). */
  context: string;
  client: { kind: "mock"; script: MockStep[] } | { kind: "real" };
  previousFailure?: string;
}

export interface ChildResult {
  ok: boolean;
  class?: "transient" | "logic";
  errorSummary?: string;
}

export interface AttemptHandle {
  result: Promise<ChildResult>;
  kill(): void;
}

export type SpawnAttempt = (init: AttemptInit, onHeartbeat: () => void) => AttemptHandle;

// Run from source (tsx) or from the compiled build: the child entry sits next to this file either way.
const childEntry = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./child.ts" : "./child.js", import.meta.url));

/** One OS process per attempt. A process that dies without reporting a result is a transient failure. */
export const forkAttempt: SpawnAttempt = (init, onHeartbeat) => {
  const child = fork(childEntry, [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const result = new Promise<ChildResult>((resolve) => {
    child.on("message", (message: ChildResult & { type: string }) => {
      if (message.type === "heartbeat") onHeartbeat();
      else resolve({ ok: message.ok, ...(message.class ? { class: message.class } : {}), ...(message.errorSummary ? { errorSummary: message.errorSummary } : {}) });
    });
    child.once("error", (error) => resolve({ ok: false, class: "transient", errorSummary: `worker process error: ${error.message}` }));
    child.once("exit", (code, signal) => resolve({ ok: false, class: "transient", errorSummary: `worker process exited without a result (code ${code}, signal ${signal})` }));
  });
  child.send(init);
  return { result, kill: () => { child.kill("SIGKILL"); } };
};

/**
 * Enforces the lease and the wall-clock limit from outside the worker, so a frozen or crashed worker
 * is reclaimed without its cooperation. Settles exactly once: whatever the worker reports afterwards is dropped.
 */
export function supervise(spawn: SpawnAttempt, init: AttemptInit, leaseMs: number, wallMs: number, onLease: (leaseUntil: number) => void): AttemptHandle {
  let handle: AttemptHandle | undefined;
  let lease: NodeJS.Timeout | undefined;
  let wall: NodeJS.Timeout | undefined;
  const result = new Promise<ChildResult>((resolve) => {
    const finish = (outcome: ChildResult): void => {
      clearTimeout(lease);
      clearTimeout(wall);
      handle?.kill();
      resolve(outcome);
    };
    // shortcut: lease timers share the scheduler's event loop, so synchronous git work longer than
    // leaseSec could expire a healthy lease; move leases to a dedicated thread if that ever shows up.
    const arm = (): void => {
      clearTimeout(lease);
      lease = setTimeout(() => finish({ ok: false, class: "transient", errorSummary: "lease expired: no heartbeat from worker" }), leaseMs);
    };
    wall = setTimeout(() => finish({ ok: false, class: "logic", errorSummary: `task wall-clock limit exceeded (${wallMs / 1000}s)` }), wallMs);
    arm();
    handle = spawn(init, () => {
      onLease(Date.now() + leaseMs);
      arm();
    });
    void handle.result.then(finish);
  });
  return { result, kill: () => handle?.kill() };
}

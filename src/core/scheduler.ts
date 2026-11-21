import type { MockScripts } from "../models/client.js";
import { TransientError } from "../models/client.js";
import { workerProfile } from "../schema/config.js";
import type { WorkerOverride, WorkerProfile } from "../schema/config.js";
import type { Task } from "../schema/plan.js";
import { transitiveDeps } from "../schema/plan.js";
import type { EventInput, EventStore } from "../store/events.js";
import { taskChangesInScope } from "../worker/runtime.js";
import { supervise } from "../worker/spawn.js";
import type { AttemptHandle, ChildResult, SpawnAttempt } from "../worker/spawn.js";
import { changedFiles, commitTaskChanges, createTaskWorktree, gitCommand, removeTaskWorktree, snapshotWorktree } from "../worker/worktree.js";
import { decideEscalation } from "./planner.js";
import type { EscalationDecision, PlannerCtx } from "./planner.js";
import type { AttemptInfo, RunState, TaskState, TaskStatus } from "./state.js";

export interface Ctx {
  repoRoot: string;
  dbPath: string;
  events: EventStore;
  /** Derived from the event log; changed only through emit. */
  state: RunState;
  /** Append an event and fold it into state. */
  emit(event: Omit<EventInput, "runId">): void;
  planner: PlannerCtx;
  /** Project conventions (AGENTS.md/CLAUDE.md/README.md) shown to every worker. */
  projectContext: string;
  /** Scripted model replies; absent for a real run. */
  scripts?: MockScripts;
  /** Cancel the run; running workers are killed and their tasks are cancelled. */
  signal?: AbortSignal;
  spawn: SpawnAttempt;
  tickMs: number;
}

export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Start a supervised worker process for one attempt; every lease renewal is persisted. */
export function runChild(ctx: Ctx, p: { task: Task; worktreePath: string; attemptId: string; attempt: number; role: "worker" | "planner"; previousFailure?: string; override?: WorkerOverride; profile?: WorkerProfile }): AttemptHandle {
  const { config, runId } = ctx.state;
  const profile = p.profile ?? workerProfile(config, p.task.kind, p.override);
  const scripts = ctx.scripts?.tasks[p.task.id] ?? [];
  return supervise(ctx.spawn, {
    dbPath: ctx.dbPath,
    runId,
    task: p.task,
    worktreePath: p.worktreePath,
    attemptId: p.attemptId,
    attempt: p.attempt,
    role: p.role,
    config,
    profile,
    ...(p.profile ? { useProfile: true } : {}),
    context: ctx.projectContext,
    client: ctx.scripts ? { kind: "mock", script: scripts[p.attempt - 1] ?? scripts.at(-1) ?? [] } : { kind: "real" },
    ...(p.previousFailure ? { previousFailure: p.previousFailure } : {}),
  }, config.leaseSec * 1000, profile.maxWallSec * 1000, (leaseUntil) => {
    ctx.emit({ taskId: p.task.id, attempt: p.attempt, type: "lease_renewed", payload: { attemptId: p.attemptId, leaseUntil } });
  });
}

/**
 * The deterministic scheduler: runs every task of the plan to a final state.
 * Returns a reason when the run was stopped by the cost guard, otherwise undefined.
 */
export async function schedule(ctx: Ctx): Promise<string | undefined> {
  const { state, emit, repoRoot } = ctx;
  const { config, runId } = state;
  const active = new Map<string, AttemptHandle>();
  const done: Array<{ taskId: string; attemptId: string; result: ChildResult }> = [];
  let wake = (): void => {};

  const tasks = (): TaskState[] => state.plan!.tasks.map((spec) => state.tasks.get(spec.id)!);
  const setState = (task: TaskState, to: TaskStatus, extra: Record<string, unknown> = {}): void => {
    emit({ taskId: task.id, attempt: task.attempts, type: "task_state_changed", payload: { from: task.state, to, ...extra } });
  };
  const deadEnd = (task: TaskState): boolean => task.state === "blocked" || task.state === "cancelled" || (task.state === "failed_escalated" && task.escalation === "abandon");
  const live = (task: TaskState): boolean => ["pending", "ready", "running", "failed_retryable"].includes(task.state) || (task.state === "failed_escalated" && task.escalation !== "abandon");
  const launchable = (task: TaskState, now: number): boolean => task.state === "ready"
    || (task.state === "failed_retryable" && now >= task.notBefore)
    || (task.state === "failed_escalated" && (task.escalation === "implement" || task.escalation === "retry_with"));

  /** Record a failure and apply the retry policy. `attempt` is absent when no worker ever started. */
  const fail = (task: TaskState, cls: "transient" | "logic" | "scope_violation", errorSummary: string, attempt?: AttemptInfo, relatedFiles?: string[]): void => {
    if (attempt) {
      try {
        relatedFiles ??= changedFiles(attempt.worktreePath, attempt.baseSha);
        snapshotWorktree(attempt.worktreePath);
      } catch {
        // The worktree may be gone or unusable; the failure itself is still recorded below.
      }
    }
    const summary = errorSummary.slice(0, 2000);
    emit({ taskId: task.id, attempt: task.attempts, type: "failure", payload: { class: cls, errorSummary: summary, relatedFiles: relatedFiles ?? [], attempt: task.attempts, attemptId: attempt?.attemptId ?? null } });
    if (task.escalation === "implement") {
      emit({ taskId: task.id, type: "escalation_decision", payload: { action: "abandon", reason: "the planner's own implementation attempt failed" } });
      return setState(task, "failed_escalated");
    }
    if (task.escalation === "retry_with") {
      emit({ taskId: task.id, type: "escalation_decision", payload: { action: "abandon", reason: "the retry with the escalated model failed" } });
      return setState(task, "failed_escalated");
    }
    const transient = cls === "transient";
    if (transient ? task.transientFailures <= config.maxTransientRetries : task.logicFailures <= config.maxLogicRetries) {
      const delayMs = config.retryBaseMs * (transient ? 2 ** (task.transientFailures - 1) : 1);
      emit({ taskId: task.id, attempt: task.attempts, type: "retry_scheduled", payload: { class: cls, delayMs, notBefore: Date.now() + delayMs } });
      return setState(task, "failed_retryable");
    }
    emit({ taskId: task.id, type: "escalated_to_planner", payload: { kind: "task", class: cls, reason: summary } });
    setState(task, "failed_escalated");
  };

  /** A worker reported its result while still holding the lease: gate on scope, then commit. */
  const settle = (task: TaskState, result: ChildResult): void => {
    const attempt = task.attempt!;
    if (!result.ok) return fail(task, result.class ?? "transient", result.errorSummary ?? "worker failed", attempt);
    const spec = state.plan!.tasks.find((candidate) => candidate.id === task.id)!;
    try {
      const changed = changedFiles(attempt.worktreePath, attempt.baseSha);
      const violations = taskChangesInScope(changed, spec.writeScope);
      if (violations.length) {
        emit({ taskId: task.id, attempt: task.attempts, type: "scope_violation", payload: { files: violations, attemptId: attempt.attemptId } });
        return fail(task, "scope_violation", `worker changed paths outside writeScope: ${violations.join(", ")}`, attempt, violations);
      }
      commitTaskChanges(attempt.worktreePath, task.id, changed);
    } catch (error) {
      return fail(task, "transient", `could not commit the task result: ${messageOf(error)}`, attempt);
    }
    try {
      removeTaskWorktree(repoRoot, attempt.worktreePath);
    } catch (error) {
      emit({ taskId: task.id, attempt: task.attempts, type: "worktree_cleanup_failed", payload: { attemptId: attempt.attemptId, errorSummary: messageOf(error).slice(0, 1000) } });
    }
    const failed = task.lastAttempt;
    setState(task, "passed", { attemptId: attempt.attemptId, branch: attempt.branch });
    if (!failed) return;
    let diffSummary = "";
    try {
      diffSummary = gitCommand(repoRoot, ["diff", "--stat", failed.branch, attempt.branch]).slice(0, 2000);
    } catch {
      // The failed attempt's snapshot branch is gone (cleanup); the retry count is still worth recording.
    }
    emit({ taskId: task.id, attempt: task.attempts, type: "recovered", payload: { retries: task.attempts - 1, failedAttemptId: failed.attemptId, failedBranch: failed.branch, passedBranch: attempt.branch, diffSummary } });
  };

  const launch = async (spec: Task, task: TaskState): Promise<void> => {
    const role = task.escalation === "implement" ? "planner" : "worker";
    const dependencies = transitiveDeps(state.plan!.tasks, spec.id).map((dependency) => state.tasks.get(dependency.id)!.branch!);
    const retry = task.state === "failed_retryable" && task.lastAttempt && task.lastViolations && task.lastViolations.length > 0
      ? { branch: task.lastAttempt.branch, baseSha: task.lastAttempt.baseSha, paths: task.lastViolations }
      : undefined;
    let worktree;
    try {
      worktree = await createTaskWorktree(repoRoot, runId, spec.id, state.baseSha, retry ? [] : dependencies, {
        linkNodeModules: state.config.worktree.linkNodeModules,
        ...(retry ? { retry } : {}),
      });
    } catch (error) {
      if (!retry) return fail(task, "transient", `could not create the attempt worktree: ${messageOf(error)}`);
      // The failed snapshot may be gone (cleanup): fall back to a fresh worktree from the base.
      try {
        worktree = await createTaskWorktree(repoRoot, runId, spec.id, state.baseSha, dependencies, { linkNodeModules: state.config.worktree.linkNodeModules });
      } catch (fallbackError) {
        return fail(task, "transient", `could not create the attempt worktree: ${messageOf(fallbackError)}`);
      }
    }
    const { attemptId } = worktree;
    const attempt = task.attempts + 1;
    const previousFailure = task.lastFailure;
    emit({ taskId: spec.id, attempt, type: "worker_started", payload: { attemptId, branch: worktree.branch, worktreePath: worktree.path, baseSha: worktree.baseSha, leaseUntil: Date.now() + config.leaseSec * 1000, role } });
    setState(task, "running", { attemptId });
    const child = runChild(ctx, { task: spec, worktreePath: worktree.path, attemptId, attempt, role, ...(previousFailure ? { previousFailure } : {}), ...(task.override ? { override: task.override } : {}) });
    active.set(spec.id, child);
    void child.result.then((result) => {
      done.push({ taskId: spec.id, attemptId, result });
      wake();
    });
  };

  const cost = (): number => ctx.events.usageByModel(runId).reduce((sum, usage) => {
    const price = config.pricing[usage.model];
    return price ? sum + (usage.inputTokens * price.inputPerMillion + usage.outputTokens * price.outputPerMillion) / 1_000_000 : sum;
  }, 0);

  const escalate = async (task: TaskState): Promise<void> => {
    // The tick-level guard runs only between ticks, and one tick can settle several failures at once.
    // Check again before each planner call so a burst of escalations cannot overshoot the budget.
    if (cost() > config.run.maxCostUsd) {
      emit({ taskId: task.id, type: "escalation_decision", payload: { action: "abandon", reason: "run cost limit reached before escalation" } });
      return;
    }
    let decision: EscalationDecision;
    for (let attempt = 0; ; attempt++) {
      try {
        decision = await decideEscalation(ctx.planner, {
          plan: state.plan!,
          taskId: task.id,
          failures: ctx.events.list({ runId, taskId: task.id, type: "failure" }).map((event) => event.payload),
          usedIds: new Set(state.tasks.keys()),
        });
        break;
      } catch (error) {
        // A transient model error must not abandon the task; only a final error (or exhausted retries) does.
        if (error instanceof TransientError && attempt < config.maxTransientRetries) {
          await new Promise((resolve) => setTimeout(resolve, config.retryBaseMs * 2 ** attempt));
          continue;
        }
        decision = { action: "abandon", reason: `planner escalation call failed: ${messageOf(error)}` };
        break;
      }
    }
    if (decision.action === "split") {
      emit({ taskId: task.id, type: "replan", payload: { plan: decision.plan, replaced: task.id, subtasks: decision.subtasks, reason: decision.reason } });
      setState(task, "cancelled", { reason: `replaced by ${decision.subtasks.join(", ")}` });
    }
    const override = decision.action === "retry_with"
      ? { ...(decision.model ? { model: decision.model } : {}), ...(decision.reasoningEffort ? { reasoningEffort: decision.reasoningEffort } : {}) }
      : {};
    emit({ taskId: task.id, type: "escalation_decision", payload: { action: decision.action, reason: decision.reason, ...override } });
  };

  for (;;) {
    if (ctx.signal?.aborted) {
      for (const child of active.values()) child.kill();
      for (const task of tasks()) if (task.state === "running") setState(task, "cancelled", { reason: "cancelled by user" });
      return "cancelled by user";
    }

    // 1. Results from workers. Fencing: only the attempt that currently holds the task may settle it.
    for (const completion of done.splice(0)) {
      const task = state.tasks.get(completion.taskId)!;
      if (task.state !== "running" || task.attempt?.attemptId !== completion.attemptId) continue;
      active.delete(task.id);
      settle(task, completion.result);
    }

    // 2. Attempts left behind by a dead scheduler have no process to supervise: reclaim them when the lease runs out.
    for (const task of tasks()) {
      if (task.state === "running" && task.attempt && !active.has(task.id) && Date.now() > task.attempt.leaseUntil) {
        fail(task, "transient", "lease expired: the attempt was abandoned by a previous scheduler process", task.attempt);
      }
    }

    // 3. Run-level cost guard.
    // shortcut: one aggregate query per tick; keep a running total if event volume makes this slow.
    const spent = cost();
    if (spent > config.run.maxCostUsd) {
      for (const child of active.values()) child.kill();
      for (const task of tasks()) if (task.state === "running") setState(task, "cancelled", { reason: "run cost limit reached" });
      return `estimated cost $${spent.toFixed(4)} exceeded run.maxCostUsd $${config.run.maxCostUsd}`;
    }

    // 4. Dependency resolution.
    for (const spec of state.plan!.tasks) {
      const task = state.tasks.get(spec.id)!;
      if (task.state !== "pending") continue;
      const dependencies = spec.dependsOn.map((id) => state.tasks.get(id)!);
      const broken = dependencies.find(deadEnd);
      if (broken) {
        emit({ taskId: task.id, type: "failure", payload: { class: "upstream", errorSummary: `dependency ${broken.id} did not pass (${broken.state})`, relatedFiles: [], attempt: 0 } });
        setState(task, "blocked");
      } else if (dependencies.every((dependency) => dependency.state === "passed" || dependency.state === "merged")) {
        setState(task, "ready");
      }
    }

    // 5. Planner escalations.
    // shortcut: decided one at a time and inline, so scheduling pauses while the planner thinks
    // (running workers continue); run them concurrently if escalations become frequent.
    for (const task of tasks()) {
      if (task.state === "failed_escalated" && task.escalation === "pending") await escalate(task);
    }

    // 6. Launch up to the concurrency limit. A re-split in step 5 changed the plan, so read it again.
    for (const spec of state.plan!.tasks) {
      if (tasks().filter((task) => task.state === "running").length >= config.maxConcurrency) break;
      const task = state.tasks.get(spec.id)!;
      if (launchable(task, Date.now())) await launch(spec, task);
    }

    if (!tasks().some(live)) return undefined;
    if (!done.length) {
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, ctx.tickMs);
      });
    }
  }
}

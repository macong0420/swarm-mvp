import { configSchema } from "../schema/config.js";
import type { SwarmConfig } from "../schema/config.js";
import type { Plan } from "../schema/plan.js";

export type TaskStatus = "pending" | "ready" | "running" | "passed" | "failed_retryable" | "failed_escalated" | "blocked" | "cancelled" | "merged";

export interface AttemptInfo {
  attemptId: string;
  branch: string;
  worktreePath: string;
  baseSha: string;
  leaseUntil: number;
}

export interface TaskState {
  id: string;
  state: TaskStatus;
  attempts: number;
  logicFailures: number;
  transientFailures: number;
  notBefore: number;
  /** The attempt holding the lease while the task is running. */
  attempt?: AttemptInfo;
  /** The most recent attempt that is no longer running. */
  lastAttempt?: AttemptInfo;
  /** Branch of the attempt that passed. */
  branch?: string;
  lastFailure?: string;
  /** Files the last failed attempt changed outside writeScope; a retry resets only these. */
  lastViolations?: string[];
  /** pending = waiting for the planner's decision; implement = the planner's own attempt is due or running; retry_with = retry with the escalated model. */
  escalation?: "pending" | "split" | "implement" | "retry_with" | "abandon";
  /** Model/effort override chosen by a retry_with escalation. */
  override?: { model?: string; reasoningEffort?: string };
}

export interface RunState {
  runId: string;
  request: string;
  baseSha: string;
  config: SwarmConfig;
  plan?: Plan;
  /** Exit code of each global acceptance command on the base commit, recorded before the tasks ran. */
  baseline?: Record<string, number>;
  /** What the dirty working-tree snapshot changed relative to HEAD (files, not contents). */
  baseDiff?: { changed: string[]; deleted: string[] };
  /** Every task the run ever had, including tasks replaced by a re-split. */
  tasks: Map<string, TaskState>;
  schedulerPid?: number;
  finished?: Record<string, unknown>;
}

export interface StateEvent {
  taskId?: string | null;
  type: string;
  payload: Record<string, unknown>;
}

/** The only place task and run state is derived: used both live (after every append) and when replaying a run. */
export function apply(state: RunState, event: StateEvent): void {
  const p = event.payload;
  const task = event.taskId ? state.tasks.get(event.taskId) : undefined;
  switch (event.type) {
    case "run_started":
      state.request = String(p.request);
      state.baseSha = String(p.baseSha);
      state.config = configSchema.parse(p.config);
      if (p.baseDiff && typeof p.baseDiff === "object") {
        const diff = p.baseDiff as { changed?: unknown; deleted?: unknown };
        state.baseDiff = {
          changed: Array.isArray(diff.changed) ? diff.changed.map(String) : [],
          deleted: Array.isArray(diff.deleted) ? diff.deleted.map(String) : [],
        };
      } else {
        delete state.baseDiff;
      }
      break;
    case "scheduler_started":
      state.schedulerPid = Number(p.pid);
      break;
    case "baseline_recorded": {
      const baseline: Record<string, number> = {};
      for (const entry of Array.isArray(p.results) ? p.results : []) {
        const result = entry as { command?: unknown; exitCode?: unknown };
        if (typeof result.command === "string") baseline[result.command] = Number(result.exitCode ?? 1);
      }
      state.baseline = baseline;
      break;
    }
    case "plan_accepted":
    case "replan":
      state.plan = p.plan as Plan;
      for (const { id } of state.plan.tasks) {
        if (!state.tasks.has(id)) state.tasks.set(id, { id, state: "pending", attempts: 0, logicFailures: 0, transientFailures: 0, notBefore: 0 });
      }
      break;
    case "run_finished":
      state.finished = p;
      break;
    case "run_config_updated":
      state.config.run.maxCostUsd = Number(p.maxCostUsd);
      break;
    case "run_reopened": {
      // A finished failed/stopped run is resumed: give its unfinished tasks a fresh retry budget.
      delete state.finished;
      const reset = Array.isArray(p.resetTasks) ? p.resetTasks.map(String) : [];
      for (const id of reset) {
        const resetTask = state.tasks.get(id);
        if (!resetTask) continue;
        if (resetTask.state === "blocked" || resetTask.state === "cancelled") delete resetTask.lastFailure;
        resetTask.state = "pending";
        resetTask.logicFailures = 0;
        resetTask.transientFailures = 0;
        resetTask.notBefore = 0;
        delete resetTask.escalation;
        delete resetTask.override;
        delete resetTask.lastViolations;
        delete resetTask.attempt;
        delete resetTask.lastAttempt;
      }
      break;
    }
  }
  if (!task) return;
  switch (event.type) {
    case "worker_started":
      task.attempts += 1;
      task.attempt = { attemptId: String(p.attemptId), branch: String(p.branch), worktreePath: String(p.worktreePath), baseSha: String(p.baseSha), leaseUntil: Number(p.leaseUntil) };
      break;
    case "lease_renewed":
      if (task.attempt && task.attempt.attemptId === p.attemptId) task.attempt.leaseUntil = Number(p.leaseUntil);
      break;
    case "failure":
      if (p.class === "transient") task.transientFailures += 1;
      else if (p.class !== "upstream") task.logicFailures += 1;
      task.lastFailure = String(p.errorSummary);
      if (p.class === "scope_violation") task.lastViolations = Array.isArray(p.relatedFiles) ? p.relatedFiles.map(String) : [];
      else delete task.lastViolations;
      break;
    case "retry_scheduled":
      task.notBefore = Number(p.notBefore);
      break;
    case "escalated_to_planner":
      task.escalation = "pending";
      break;
    case "escalation_decision":
      task.escalation = p.action as NonNullable<TaskState["escalation"]>;
      if (p.action === "retry_with") {
        const override = {
          ...(typeof p.model === "string" ? { model: p.model } : {}),
          ...(typeof p.reasoningEffort === "string" ? { reasoningEffort: p.reasoningEffort } : {}),
        };
        if (Object.keys(override).length) task.override = override;
      }
      break;
    case "task_state_changed":
      task.state = p.to as TaskStatus;
      if (task.state !== "running" && task.attempt) {
        task.lastAttempt = task.attempt;
        delete task.attempt;
      }
      if (task.state === "passed") {
        task.branch = String(p.branch);
        delete task.lastViolations;
      }
      break;
  }
}

export function replay(runId: string, events: StateEvent[]): RunState {
  const state: RunState = { runId, request: "", baseSha: "", config: configSchema.parse({}), tasks: new Map() };
  for (const event of events) apply(state, event);
  return state;
}

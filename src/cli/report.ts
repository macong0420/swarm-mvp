import type { EventStore } from "../store/events.js";
import { replay } from "../core/state.js";

/** Run summary derived from the event log; shared by `status` and `viz`. */
export function summarizeRun(events: EventStore, runId: string) {
  const all = events.list({ runId });
  const state = replay(runId, all);
  const taskEvents = new Map<string, typeof all>();
  for (const event of all) {
    if (!event.taskId) continue;
    const existing = taskEvents.get(event.taskId) ?? [];
    existing.push(event);
    taskEvents.set(event.taskId, existing);
  }
  const started = all.find((event) => event.type === "run_started");
  // A reopened run is live again: only a run_finished after it counts as terminal.
  const terminal = [...all].reverse().find((event) => event.type === "run_finished" || event.type === "run_reopened");
  const finished = terminal?.type === "run_finished" ? terminal : undefined;
  const now = Date.now();
  const runElapsedMs = Math.max(0, (Date.parse(finished?.ts ?? new Date(now).toISOString()) - Date.parse(started?.ts ?? new Date(now).toISOString())));
  const config = started?.payload.config as { pricing?: Record<string, { inputPerMillion: number; outputPerMillion: number }> } | undefined;
  const usageFor = (modelEvents: typeof all) => modelEvents.reduce((usage, event) => {
    if (event.type !== "model_call") return usage;
    const tokens = event.payload.usage as { inputTokens?: number; outputTokens?: number } | undefined;
    return { inputTokens: usage.inputTokens + (tokens?.inputTokens ?? 0), outputTokens: usage.outputTokens + (tokens?.outputTokens ?? 0) };
  }, { inputTokens: 0, outputTokens: 0 });
  const costFor = (modelEvents: typeof all): number | null => {
    let total = 0;
    for (const event of modelEvents) {
      if (event.type !== "model_call") continue;
      const model = typeof event.payload.model === "string" ? event.payload.model : "";
      const price = config?.pricing?.[model];
      const tokens = event.payload.usage as { inputTokens?: number; outputTokens?: number } | undefined;
      if (!price) return null;
      total += ((tokens?.inputTokens ?? 0) * price.inputPerMillion + (tokens?.outputTokens ?? 0) * price.outputPerMillion) / 1_000_000;
    }
    return total;
  };
  const summarizeTask = (taskId: string, taskState: string, attempts: number, failureReason: string | null) => {
    const taskLog = taskEvents.get(taskId) ?? [];
    const workerStarted = taskLog.find((event) => event.type === "worker_started");
    const stopped = [...taskLog].reverse().find((event) => event.type === "task_state_changed" && event.payload.from === "running");
    const stateAt = stopped && taskState !== "running" ? Date.parse(stopped.ts) : now;
    const taskStartAt = workerStarted ? Date.parse(workerStarted.ts) : stateAt;
    const usage = usageFor(taskLog);
    return {
      taskId,
      state: taskState,
      attempts,
      elapsedMs: Math.max(0, stateAt - taskStartAt),
      ...usage,
      estimatedCostUsd: costFor(taskLog),
      failureReason,
    };
  };
  const tasks = [...state.tasks.values()].map((task) => summarizeTask(task.id, task.state, task.attempts, task.state === "passed" || task.state === "merged" ? null : task.lastFailure ?? null));
  // Integration fixes (@integration, @merge-*) are not plan tasks but can be the most expensive model calls.
  for (const taskId of taskEvents.keys()) {
    if (state.tasks.has(taskId)) continue;
    const log = taskEvents.get(taskId)!;
    const failure = [...log].reverse().find((event) => event.type === "failure");
    const attempts = Math.max(0, ...log.map((event) => event.attempt ?? 0));
    tasks.push(summarizeTask(taskId, "integration", attempts, failure ? String(failure.payload.errorSummary ?? "") : null));
  }
  const usage = usageFor(all);
  const warnings = Array.isArray(finished?.payload.warnings) ? finished.payload.warnings.map(String) : [];
  const pidAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  };
  const stale = !finished && state.schedulerPid !== undefined && !pidAlive(state.schedulerPid);
  return { runId, state: finished?.payload.state ?? (stale ? "stale" : "running"), reason: finished?.payload.reason ?? null, warnings, elapsedMs: runElapsedMs, ...usage, estimatedCostUsd: costFor(all), tasks };
}

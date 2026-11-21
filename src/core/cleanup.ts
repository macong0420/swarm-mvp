import { existsSync } from "node:fs";
import type { EventStore } from "../store/events.js";
import { gitCommand, removeTaskWorktree } from "../worker/worktree.js";
import { replay } from "./state.js";

/**
 * Remove worktrees and branches of attempts that did not pass, once they are older than the run's
 * failedWorktreeTtlMinutes. Passed task branches, integration branches and attempts that still hold
 * a lease are kept. Only attempts recorded in the event log are touched.
 */
export function cleanup(repoRoot: string, events: EventStore, now = Date.now()): { removedWorktrees: string[]; removedBranches: string[] } {
  const removedWorktrees: string[] = [];
  const removedBranches: string[] = [];
  for (const runId of events.runIds()) {
    const log = events.list({ runId });
    const state = replay(runId, log);
    const ttlMs = state.config.failedWorktreeTtlMinutes * 60_000;
    const keep = new Set<string>();
    for (const task of state.tasks.values()) {
      if (task.branch) keep.add(task.branch);
      if (task.attempt && task.attempt.leaseUntil > now) keep.add(task.attempt.branch);
    }
    // The base snapshot only exists so an unfinished run can be resumed; after the same window as a
    // failed worktree it is no longer needed and its objects should not stay alive forever.
    const last = log.at(-1);
    if (state.finished && last && now - Date.parse(last.ts) >= ttlMs) {
      try { gitCommand(repoRoot, ["update-ref", "-d", `refs/swarm/${runId}/base`]); } catch { /* no snapshot for this run */ }
    }
    const lastSeen = new Map<string, number>();
    for (const event of log) if (event.taskId && event.attempt !== null) lastSeen.set(`${event.taskId}/${event.attempt}`, Date.parse(event.ts));
    for (const event of log) {
      if (event.type !== "worker_started") continue;
      const branch = String(event.payload.branch);
      const worktreePath = String(event.payload.worktreePath);
      if (keep.has(branch) || now - (lastSeen.get(`${event.taskId}/${event.attempt}`) ?? 0) < ttlMs) continue;
      try {
        if (existsSync(worktreePath)) {
          removeTaskWorktree(repoRoot, worktreePath);
          removedWorktrees.push(worktreePath);
        }
        gitCommand(repoRoot, ["branch", "-D", branch]);
        removedBranches.push(branch);
      } catch {
        // Already removed by an earlier cleanup.
      }
    }
    // Opt-in retention for the branches of finished runs (passed tasks and integration).
    const keepMs = state.config.keepBranchesMinutes * 60_000;
    if (keepMs > 0 && state.finished && last && now - Date.parse(last.ts) >= keepMs) {
      const branches = gitCommand(repoRoot, ["for-each-ref", "--format=%(refname:short)", `refs/heads/swarm/${runId}/`]).split("\n").filter(Boolean);
      for (const branch of branches) {
        try {
          gitCommand(repoRoot, ["branch", "-D", branch]);
          removedBranches.push(branch);
        } catch {
          // Checked out in a worktree; the next cleanup retries after the worktree is gone.
        }
      }
    }
  }
  gitCommand(repoRoot, ["worktree", "prune"]);
  return { removedWorktrees, removedBranches };
}

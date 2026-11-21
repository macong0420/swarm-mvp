import { mkdir } from "node:fs/promises";
import path from "node:path";
import { runAcceptance } from "../worker/runtime.js";
import type { AcceptanceResult } from "../worker/runtime.js";
import { gitCommand, linkNodeModules, worktreeRoot } from "../worker/worktree.js";
import type { Ctx } from "./scheduler.js";

const errorOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 1000);

/**
 * Run global acceptance once on the base commit, before any task. The integration step compares its
 * results with this baseline, so a failure that was already there is not blamed on a task.
 */
export async function recordBaseline(ctx: Ctx, commands: string[]): Promise<void> {
  if (!commands.length) return;
  const worktree = path.join(worktreeRoot(ctx.repoRoot), ctx.state.runId, "baseline");
  let results: AcceptanceResult[] = [];
  try {
    try {
      gitCommand(ctx.repoRoot, ["worktree", "remove", "--force", worktree]);
    } catch {
      // Nothing left over from an interrupted baseline.
    }
    await mkdir(path.dirname(worktree), { recursive: true });
    gitCommand(ctx.repoRoot, ["worktree", "add", "--detach", worktree, ctx.state.baseSha]);
    if (ctx.state.config.worktree.linkNodeModules) await linkNodeModules(ctx.repoRoot, worktree);
    results = await runAcceptance(commands, worktree, ctx.state.config.commandPolicy, (payload) => {
      ctx.emit({ type: "acceptance_run", payload: { ...payload, scope: "baseline" } });
    });
  } catch (error) {
    // A baseline that cannot run is not fatal: record nothing and let the strict policy apply later.
    ctx.emit({ type: "baseline_failed", payload: { errorSummary: errorOf(error) } });
  } finally {
    try {
      gitCommand(ctx.repoRoot, ["worktree", "remove", "--force", worktree]);
    } catch {
      // Already removed.
    }
  }
  ctx.emit({
    type: "baseline_recorded",
    payload: { results: results.map(({ command, exitCode, timedOut }) => ({ command, exitCode, timedOut })) },
  });
}

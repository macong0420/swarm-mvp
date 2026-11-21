import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { integrationProfile } from "../schema/config.js";
import { pathMatchesScope, topoOrder } from "../schema/plan.js";
import type { Task } from "../schema/plan.js";
import { tokenizeCommand } from "../worker/commands.js";
import { runAcceptance, taskChangesInScope } from "../worker/runtime.js";
import type { AcceptanceResult } from "../worker/runtime.js";
import { GIT_IDENTITY, changedFiles, commitTaskChanges, gitCommand, linkNodeModules, removeTaskWorktree, worktreeRoot } from "../worker/worktree.js";
import { messageOf, runChild } from "./scheduler.js";
import type { Ctx } from "./scheduler.js";

export type IntegrationResult = { ok: true; branch: string; partial?: boolean; warnings?: string[] } | { ok: false; branch: string; reason: string };

const lines = (text: string): string[] => text.split("\n").filter(Boolean);
const clip = (text: string, max = 4000): string => (text.length > max ? `${text.slice(0, max)}...` : text);
const names = (cwd: string, args: string[]): string[] => lines(gitCommand(cwd, ["-c", "core.quotePath=false", ...args]));

/** Planner escalation for integration problems: the planner works in the integration worktree with the worker's restricted tools. */
async function plannerFix(ctx: Ctx, kind: string, task: Task, worktreePath: string, detail: Record<string, unknown>, previousFailure?: string, attempt = 1): Promise<{ ok: boolean; errorSummary?: string }> {
  ctx.emit({ taskId: task.id, type: "escalated_to_planner", payload: { kind, ...detail } });
  const attemptId = randomUUID().slice(0, 8);
  const result = await runChild(ctx, {
    task,
    worktreePath,
    attemptId,
    attempt,
    role: "planner",
    profile: integrationProfile(ctx.state.config),
    ...(previousFailure ? { previousFailure } : {}),
  }).result;
  if (!result.ok) {
    const errorSummary = result.errorSummary ?? "planner fix failed";
    ctx.emit({ taskId: task.id, attempt, type: "failure", payload: { class: result.class ?? "transient", errorSummary, relatedFiles: task.writeScope, attempt, attemptId } });
    return { ok: false, errorSummary };
  }
  return { ok: true };
}

/**
 * Merge every passed task branch, dependencies first, into swarm/<runId>/integration, then run the
 * global acceptance commands once. The user's branches are never touched. Safe to rerun: the
 * integration branch is rebuilt from baseSha each time. With `partial`, only the tasks that passed are
 * merged and global acceptance is skipped: a run with failed tasks still leaves a usable branch.
 */
export async function integrate(ctx: Ctx, partial = false): Promise<IntegrationResult> {
  const { state, emit, repoRoot } = ctx;
  const plan = state.plan!;
  const taskFiles = plan.tasks.flatMap((task) => task.writeScope);
  const branch = `swarm/${state.runId}/integration`;
  const worktree = path.join(worktreeRoot(repoRoot), state.runId, "integration");
  const failed = (reason: string): IntegrationResult => ({ ok: false, branch, reason });
  try {
    removeTaskWorktree(repoRoot, worktree);
  } catch {
    // Nothing left over from an interrupted integration.
  }
  gitCommand(repoRoot, ["worktree", "prune"]);
  gitCommand(repoRoot, ["worktree", "add", "-B", branch, worktree, state.baseSha]);
  // Global acceptance and the planner's integration fix run here; they need the installed dependencies too.
  if (state.config.worktree.linkNodeModules) await linkNodeModules(repoRoot, worktree);
  try {
    const mergeable = new Set(plan.tasks.filter((task) => {
      const taskState = state.tasks.get(task.id)!;
      return (taskState.state === "passed" || taskState.state === "merged") && taskState.branch;
    }).map((task) => task.id));
    const merged: Array<{ id: string; files: string[] }> = [];
    for (const task of topoOrder(plan.tasks)) {
      if (!mergeable.has(task.id)) continue;
      const taskState = state.tasks.get(task.id)!;
      const taskBranch = taskState.branch!;
      const before = gitCommand(worktree, ["rev-parse", "HEAD"]);
      emit({ taskId: task.id, type: "merge_attempted", payload: { branch: taskBranch, into: branch } });
      try {
        gitCommand(worktree, [...GIT_IDENTITY, "merge", "--no-ff", "--no-edit", "-m", `swarm: merge ${task.id}`, taskBranch]);
      } catch (error) {
        let files = names(worktree, ["diff", "--name-only", "--diff-filter=U"]);
        emit({ taskId: task.id, type: "merge_conflict", payload: { branch: taskBranch, into: branch, files, errorSummary: clip(messageOf(error), 1000) } });
        if (!files.length) return failed(`merge conflict while merging ${task.id}: ${messageOf(error)}`);
        let resolution: { ok: boolean; errorSummary?: string } = { ok: false };
        for (let attempt = 1; attempt <= state.config.maxLogicRetries + 1; attempt++) {
          if (attempt > 1) {
            // Undo the failed resolution and reproduce the conflict before asking again.
            try {
              gitCommand(worktree, ["merge", "--abort"]);
            } catch {
              // No merge in progress.
            }
            let retryError: unknown;
            try {
              gitCommand(worktree, [...GIT_IDENTITY, "merge", "--no-ff", "--no-edit", "-m", `swarm: merge ${task.id}`, taskBranch]);
            } catch (mergeError) {
              retryError = mergeError;
            }
            const retryFiles = names(worktree, ["diff", "--name-only", "--diff-filter=U"]);
            if (!retryFiles.length) {
              if (retryError) return failed(`merge conflict while merging ${task.id}: ${messageOf(retryError)}`);
              resolution = { ok: true };
              break;
            }
            files = retryFiles;
          }
          resolution = await resolveConflict(ctx, task, taskBranch, worktree, files, resolution.errorSummary, attempt);
          if (resolution.ok) break;
        }
        if (!resolution.ok) return failed(`merge conflict while merging ${task.id}: ${files.join(", ") || resolution.errorSummary || messageOf(error)}`);
      }
      merged.push({ id: task.id, files: names(worktree, ["diff", "--name-only", before, "HEAD"]) });
      if (taskState.state !== "merged") emit({ taskId: task.id, attempt: taskState.attempts, type: "task_state_changed", payload: { from: taskState.state, to: "merged" } });
    }

    // Every merged change must belong to some task's writeScope; this catches a bad branch or snapshot.
    const outsideScopes = names(worktree, ["diff", "--name-only", state.baseSha, "HEAD"]).filter((file) => !pathMatchesScope(file, taskFiles));
    if (outsideScopes.length) {
      emit({ type: "integration_guard_failed", payload: { files: outsideScopes } });
      return failed(`integration changed files outside every task's writeScope: ${outsideScopes.join(", ")}`);
    }

    if (partial) return { ok: true, branch, partial: true };

    // Global acceptance runs only now, with every task merged.
    const head = gitCommand(worktree, ["rev-parse", "HEAD"]);
    let results: AcceptanceResult[];
    try {
      results = await runAcceptance(plan.globalAcceptance, worktree, state.config.commandPolicy, (payload) => emit({ type: "acceptance_run", payload: { ...payload, scope: "global" } }));
    } catch (error) {
      results = [{ command: "(acceptance)", exitCode: 1, timedOut: false, output: messageOf(error) }];
    }
    const formatResult = (result: AcceptanceResult): string => `${result.command} exited ${result.exitCode}: ${result.output}`;
    const baseline = state.baseline;
    // A command that names a file the tasks create was expected to fail at baseline; it is not "pre-existing".
    const referencesTaskFile = (command: string): boolean => tokenizeCommand(command).slice(1).some((argument) =>
      !argument.startsWith("-") && /\.[A-Za-z0-9]+$/.test(argument) && pathMatchesScope(argument.replace(/^\.\//, ""), taskFiles));
    const isPreexisting = (result: AcceptanceResult): boolean => result.exitCode !== 0
      && state.config.run.baselinePolicy === "ignore-existing"
      && baseline !== undefined
      && baseline[result.command] !== undefined
      && baseline[result.command] !== 0
      && !referencesTaskFile(result.command);
    const failures = results.filter((result) => result.exitCode !== 0);
    const preexisting = failures.filter(isPreexisting);
    const blocking = failures.filter((result) => !isPreexisting(result));
    if (!blocking.length) {
      if (!preexisting.length) return { ok: true, branch };
      const warning = `pre-existing global acceptance failures (ignored by run.baselinePolicy): ${preexisting.map((result) => result.command).join(", ")}`;
      emit({ type: "baseline_failure", payload: { commands: preexisting.map((result) => result.command), outputSummary: clip(preexisting.map(formatResult).join("\n"), 2000) } });
      return { ok: true, branch, warnings: [warning] };
    }

    const output = blocking.map(formatResult).join("\n");
    // shortcut: suspects are the tasks whose files the failure output names; bisect the merge commits if that proves too coarse.
    const suspects = merged.filter((entry) => entry.files.some((file) => output.includes(file)));
    const suspectTasks = suspects.map((entry) => entry.id);
    const preexistingNote = preexisting.length ? `\nThese commands already failed before the run and are not part of this fix: ${preexisting.map((result) => result.command).join(", ")}` : "";
    emit({ type: "failure", payload: { class: "logic", scope: "global_acceptance", errorSummary: clip(output, 2000), relatedFiles: suspects.flatMap((entry) => entry.files), attempt: 0, suspectTasks, mergeRange: { from: state.baseSha, to: head }, ...(preexisting.length ? { preexistingCommands: preexisting.map((result) => result.command) } : {}) } });
    const fix: Task = {
      id: "@integration",
      kind: "implement",
      title: "Fix the global acceptance failure",
      description: `Every task branch is merged, but the global acceptance commands fail. Make them pass with the smallest change.\nSuspect tasks: ${suspectTasks.join(", ") || "unknown"}\nFailure output:\n${clip(output)}${preexistingNote}\nPrefer a targeted fix; do not add blanket lint disables such as /* eslint-disable */ — if a rule must be suppressed, name the rule.`,
      writeScope: [...new Set(plan.tasks.flatMap((task) => task.writeScope))],
      readContext: [],
      dependsOn: [],
      acceptance: { commands: plan.globalAcceptance },
      estimate: { files: 0, lines: 0 },
    };
    let fixResult: { ok: boolean; errorSummary?: string } = { ok: false };
    for (let attempt = 1; attempt <= state.config.maxLogicRetries + 1; attempt++) {
      if (attempt > 1) {
        // Discard the failed fix; the integration commit before it is still the base.
        gitCommand(worktree, ["reset", "--hard", head]);
        gitCommand(worktree, ["clean", "-fd"]);
      }
      const attemptTask: Task = attempt === 1 || !fixResult.errorSummary
        ? fix
        : { ...fix, description: `${fix.description}\nThe previous fix attempt failed with:\n${fixResult.errorSummary}` };
      fixResult = await plannerFix(ctx, "global_acceptance", attemptTask, worktree, { suspectTasks }, fixResult.errorSummary, attempt);
      if (fixResult.ok) break;
    }
    if (!fixResult.ok) return failed(`global acceptance failed: ${clip(output, 500)}`);
    const changed = changedFiles(worktree, head);
    const outside = taskChangesInScope(changed, fix.writeScope);
    if (outside.length) return failed(`the planner's integration fix changed files outside every task's writeScope: ${outside.join(", ")}`);
    commitTaskChanges(worktree, "integration fix", changed);
    emit({ type: "integration_fix_committed", payload: { commit: gitCommand(worktree, ["rev-parse", "HEAD"]), files: changed } });
    if (state.config.integration.verifyAfterFix) {
      const finalResults = await runAcceptance(plan.globalAcceptance, worktree, state.config.commandPolicy, (payload) => emit({ type: "acceptance_run", payload: { ...payload, scope: "global" } }));
      const finalFailures = finalResults.filter((result) => result.exitCode !== 0 && !isPreexisting(result));
      if (finalFailures.length) {
        const finalOutput = finalFailures.map(formatResult).join("\n");
        emit({ type: "failure", payload: { class: "logic", scope: "global_acceptance", errorSummary: clip(finalOutput, 2000), relatedFiles: suspects.flatMap((entry) => entry.files), attempt: 0, suspectTasks, mergeRange: { from: state.baseSha, to: gitCommand(worktree, ["rev-parse", "HEAD"]) } } });
        return failed(`global acceptance still fails after the fix: ${clip(finalOutput, 500)}`);
      }
    }
    return { ok: true, branch };
  } finally {
    try {
      gitCommand(worktree, ["merge", "--abort"]);
    } catch {
      // No merge in progress.
    }
    try {
      removeTaskWorktree(repoRoot, worktree);
    } catch {
      // Removed again at the start of the next integration.
    }
  }
}

/** Hand a conflicted merge to the planner; conclude the merge only if exactly the conflicted files were resolved. */
async function resolveConflict(ctx: Ctx, task: Task, taskBranch: string, worktree: string, files: string[], previousFailure?: string, attempt = 1): Promise<{ ok: boolean; errorSummary?: string }> {
  const base = gitCommand(worktree, ["merge-base", "HEAD", taskBranch]);
  const fix: Task = {
    id: `@merge-${task.id}`,
    kind: "implement",
    title: `Resolve the merge conflict of ${task.id}`,
    description: [
      `Merging task ${task.id} ("${task.title}") into the integration branch conflicted in: ${files.join(", ")}.`,
      "The files contain git conflict markers. Rewrite each file so that both sides' intent is kept and no markers remain. Change nothing else.",
      `Integration side diff:\n${clip(gitCommand(worktree, ["diff", base, "HEAD", "--", ...files]))}`,
      `Task side diff:\n${clip(gitCommand(worktree, ["diff", base, taskBranch, "--", ...files]))}`,
      ...(previousFailure ? [`A previous resolution attempt failed with:\n${previousFailure}`] : []),
    ].join("\n\n"),
    writeScope: files,
    readContext: files,
    dependsOn: [],
    acceptance: task.acceptance,
    estimate: { files: files.length, lines: 0 },
  };
  const fixResult = await plannerFix(ctx, "merge_conflict", fix, worktree, { task: task.id, files }, previousFailure, attempt);
  if (!fixResult.ok) return fixResult;
  const touched = [...names(worktree, ["diff", "--name-only"]), ...names(worktree, ["ls-files", "--others", "--exclude-standard"])];
  const unresolved = files.some((file) => /^(<{7}|>{7}) /m.test(readFileSync(path.join(worktree, file), "utf8")));
  if (unresolved || touched.some((file) => !files.includes(file))) {
    const errorSummary = unresolved ? "conflict markers remain" : "the planner changed files other than the conflicted ones";
    ctx.emit({ taskId: fix.id, attempt, type: "failure", payload: { class: "logic", errorSummary, relatedFiles: touched, attempt } });
    return { ok: false, errorSummary };
  }
  gitCommand(worktree, ["add", "--", ...files]);
  gitCommand(worktree, [...GIT_IDENTITY, "commit", "--no-edit"]);
  ctx.emit({ taskId: fix.id, type: "conflict_resolved", payload: { task: task.id, files, commit: gitCommand(worktree, ["rev-parse", "HEAD"]) } });
  return { ok: true };
}

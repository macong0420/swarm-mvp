import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { MockClient, TransientError, mockText, mockTool } from "../models/client.js";
import type { MockScripts } from "../models/client.js";
import { createClient } from "../models/factory.js";
import type { SwarmConfig } from "../schema/config.js";
import type { Plan, Task } from "../schema/plan.js";
import { EventStore } from "../store/events.js";
import type { EventInput } from "../store/events.js";
import { forkAttempt } from "../worker/spawn.js";
import type { SpawnAttempt } from "../worker/spawn.js";
import { getBaseSha, gitCommand, snapshotDiff, snapshotWorkingTree, workingTreeDirty } from "../worker/worktree.js";
import { projectInstructions, repoMap, runReadTool } from "./repo.js";
import { recordBaseline } from "./baseline.js";
import { cleanup } from "./cleanup.js";
import { integrate } from "./integrator.js";
import { createPlan, validatePlanForRun } from "./planner.js";
import { messageOf, schedule } from "./scheduler.js";
import type { Ctx } from "./scheduler.js";
import { apply, replay } from "./state.js";

export interface RunOptions {
  repoRoot: string;
  /** Scripted model replies (tests, --dry-run). Leave out to call the configured models. */
  scripts?: MockScripts;
  /** A plan approved in advance (`swarm plan` output); skips the planning call. */
  plan?: Plan;
  /** Overrides run.maxCostUsd; on resume it raises the budget recorded at run start. */
  maxCostUsd?: number;
  /** Abort the run: running workers are killed and the run finishes as stopped. */
  signal?: AbortSignal;
  dbPath?: string;
  spawn?: SpawnAttempt;
  tickMs?: number;
}

export interface RunResult {
  runId: string;
  state: "passed" | "failed" | "stopped";
  reason: string | null;
  integrationBranch: string | null;
  tasks: Array<{ id: string; state: string; attempts: number }>;
  summary: string;
  warnings?: string[];
}

/** Scripted three-task run for --dry-run: two parallel tasks and one that depends on both. */
export function dryRunScripts(): MockScripts {
  const task = (id: string, dependsOn: string[]): Task => ({
    id,
    kind: "implement",
    title: `Dry run step ${id}`,
    description: "Write one marker file. Exercises planning, worktrees, acceptance and merging; touches nothing else.",
    writeScope: [`swarm-dry-run/${id}.txt`],
    readContext: [],
    dependsOn,
    acceptance: { commands: ["node -p 1"] },
    estimate: { files: 1, lines: 1 },
  });
  const plan: Plan = { goal: "dry run", globalAcceptance: ["node -p 1"], tasks: [task("t1", []), task("t2", []), task("t3", ["t1", "t2"])] };
  const script = (id: string) => [[mockTool("write_file", { path: `swarm-dry-run/${id}.txt`, content: `${id}\n` }), mockTool("finish")]];
  return { planner: [mockText(JSON.stringify(plan))], tasks: { t1: script("t1"), t2: script("t2"), t3: script("t3") } };
}

/** Start a new run from the working tree. Uncommitted changes are frozen into a base commit; the working tree is never modified. */
export async function startRun(options: RunOptions & { request: string; config: SwarmConfig }): Promise<RunResult> {
  // A missing model or key must fail before the run exists, not leave an unfinishable run behind.
  // The planner client is still built with a supplied plan: escalations may need it later.
  if (!options.scripts) for (const role of ["planner", "worker"] as const) createClient(role, options.config);
  const runId = randomUUID();
  // Uncommitted work is the user's real starting point: freeze the working tree into a commit
  // without touching HEAD, the index or the files, and let every worktree start from it.
  const dirty = workingTreeDirty(options.repoRoot);
  const baseSha = dirty ? snapshotWorkingTree(options.repoRoot, runId) : getBaseSha(options.repoRoot);
  const baseDiff = dirty ? snapshotDiff(options.repoRoot, baseSha) : undefined;
  const config = options.maxCostUsd === undefined ? options.config : { ...options.config, run: { ...options.config.run, maxCostUsd: options.maxCostUsd } };
  return drive(options, runId, { request: options.request, baseSha, dirty, config, ...(baseDiff ? { baseDiff } : {}) });
}

/** Continue an unfinished run from its event log, for example after the process was killed. */
export async function resumeRun(options: RunOptions & { runId: string }): Promise<RunResult> {
  return drive(options, options.runId);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user; only ESRCH means it is gone.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function drive(options: RunOptions, runId: string, start?: Record<string, unknown>): Promise<RunResult> {
  const dbPath = options.dbPath ?? path.join(options.repoRoot, ".swarm", "events.sqlite");
  await mkdir(path.dirname(dbPath), { recursive: true });
  const events = new EventStore(dbPath);
  try {
    const state = replay(runId, events.list({ runId }));
    const emit = (event: Omit<EventInput, "runId">): void => {
      events.append({ ...event, runId });
      apply(state, event);
    };
    if (start) {
      emit({ type: "run_started", payload: start });
    } else {
      if (!state.baseSha) throw new Error(`unknown run: ${runId}`);
      // shortcut: a pid check, which a reused pid can fool into refusing forever; give the scheduler its own lease if that bites.
      if (state.schedulerPid && state.schedulerPid !== process.pid && pidAlive(state.schedulerPid)) {
        throw new Error(`run ${runId} is still being driven by process ${state.schedulerPid}`);
      }
      // A failed or stopped run can be retried: reopen it and reset every unfinished plan task. A passed
      // run has nothing left to do. Tasks that already passed are never reset.
      if (state.finished) {
        const finishedState = String(state.finished.state);
        if (finishedState === "passed") throw new Error(`run ${runId} already finished (${finishedState})`);
        const planIds = new Set(state.plan?.tasks.map((task) => task.id) ?? []);
        const resetTasks = [...state.tasks.values()]
          .filter((task) => planIds.has(task.id) && task.state !== "passed" && task.state !== "merged")
          .map((task) => task.id);
        emit({ type: "run_reopened", payload: { from: finishedState, resetTasks } });
      }
      // A stopped run keeps its original config snapshot; --max-cost lets the user raise the budget it stopped at.
      if (options.maxCostUsd !== undefined) emit({ type: "run_config_updated", payload: { maxCostUsd: options.maxCostUsd } });
    }
    emit({ type: "scheduler_started", payload: { pid: process.pid, resumed: !start } });
    // shortcut: the periodic reclaim is "once per run start", and it replays every run in the database;
    // add a timer and an index of open attempts if databases grow large.
    cleanup(options.repoRoot, events);

    const { config } = state;
    const planner = options.scripts ? { client: new MockClient(options.scripts.planner), model: "mock" } : createClient("planner", config);
    const fileExists = (file: string): boolean => {
      try {
        gitCommand(options.repoRoot, ["cat-file", "-e", `${state.baseSha}:${file}`]);
        return true;
      } catch {
        return false;
      }
    };
    const workerModels = [...new Set([
      config.worker.model,
      ...Object.values(config.worker.routes).map((route) => route.model).filter((model): model is string => Boolean(model)),
    ])].filter(Boolean);
    const ctx: Ctx = {
      repoRoot: options.repoRoot,
      dbPath,
      events,
      state,
      emit,
      planner: {
        client: planner.client, modelName: planner.model, emit, limits: config.task, maxPlanRetries: config.maxPlanRetries, commandPolicy: config.commandPolicy, fileExists, workerModels,
        repo: {
          baseSha: state.baseSha,
          map: repoMap(options.repoRoot, state.baseSha),
          maxToolTurns: config.planner.maxToolTurns,
          runTool: (name, args) => runReadTool(options.repoRoot, state.baseSha, name, args, config.planner),
        },
      },
      ...(options.scripts ? { scripts: options.scripts } : {}),
      projectContext: projectInstructions(options.repoRoot, state.baseSha),
      ...(options.signal ? { signal: options.signal } : {}),
      spawn: options.spawn ?? forkAttempt,
      tickMs: options.tickMs ?? 200,
    };
    const finish = (result: RunResult["state"], reason: string | null, integrationBranch: string | null, warnings: string[] = []): RunResult => {
      const tasks = [...state.tasks.values()].map((task) => ({ id: task.id, state: task.state, attempts: task.attempts }));
      const models = [...new Set([config.planner.model, config.worker.model, ...Object.values(config.worker.routes).map((route) => route.model).filter((model): model is string => Boolean(model))])];
      const unpriced = models.filter((model) => model && !config.pricing[model]);
      const allWarnings = [
        ...warnings,
        ...(state.plan && state.plan.globalAcceptance.length === 0 ? ["the plan has no global acceptance commands; the integration branch is not verified"] : []),
        ...(unpriced.length ? [`no pricing for ${unpriced.join(", ")}; cost estimates and run.maxCostUsd ignore these models`] : []),
      ];
      emit({ type: "run_finished", payload: { state: result, reason, integrationBranch, tasks, ...(allWarnings.length ? { warnings: allWarnings } : {}) } });
      const summary = [
        `Run ${runId}: ${result}${reason ? ` (${reason})` : ""}`,
        ...(allWarnings.length ? ["Warnings:", ...allWarnings.map((warning) => `  ${warning}`)] : []),
        ...(state.baseDiff && (state.baseDiff.changed.length || state.baseDiff.deleted.length)
          ? [`Base snapshot vs HEAD: ${state.baseDiff.changed.length} changed, ${state.baseDiff.deleted.length} deleted`]
          : []),
        ...tasks.map((task) => `  ${task.id}  ${task.state}  attempts=${task.attempts}`),
        ...(integrationBranch
          ? [
              `Integration branch: ${integrationBranch}`,
              result === "passed" ? "Nothing was merged into your branches. To take the result, review it and run:" : "Partial result: only the tasks that passed are merged. Review it and run:",
              `  git merge ${integrationBranch}`,
            ]
          : [`Inspect with: swarm status ${runId}`]),
      ].join("\n");
      return { runId, state: result, reason, integrationBranch, tasks, summary, ...(allWarnings.length ? { warnings: allWarnings } : {}) };
    };

    if (!state.plan) {
      if (options.plan) {
        // The user reviewed this plan (`swarm plan`): validate it like a planner reply, then run it as is.
        try {
          emit({ type: "plan_accepted", payload: { plan: validatePlanForRun(options.plan, ctx.planner) } });
        } catch (error) {
          return finish("failed", `plan rejected: ${messageOf(error)}`, null);
        }
      } else {
        for (let attempt = 0; ; attempt++) {
          try {
            await createPlan(ctx.planner, state.request);
            break;
          } catch (error) {
            // A transient model error must not end the run: planning has not produced a plan yet.
            if (error instanceof TransientError && attempt < config.maxTransientRetries) {
              await new Promise((resolve) => setTimeout(resolve, config.retryBaseMs * 2 ** attempt));
              continue;
            }
            return finish("failed", `planning failed: ${messageOf(error)}`, null);
          }
        }
      }
    }
    if (config.run.baseline && state.plan!.globalAcceptance.length && !state.baseline) {
      await recordBaseline(ctx, state.plan!.globalAcceptance);
    }
    let stopped: string | undefined;
    try {
      stopped = await schedule(ctx);
    } catch (error) {
      return finish("failed", `scheduling failed: ${messageOf(error)}`, null);
    }
    if (stopped) return finish("stopped", stopped, null);
    const unfinished = state.plan!.tasks.map((task) => state.tasks.get(task.id)!).filter((task) => task.state !== "passed" && task.state !== "merged");
    if (unfinished.length) {
      const reason = `tasks did not pass: ${unfinished.map((task) => `${task.id} (${task.state})`).join(", ")}`;
      const passed = state.plan!.tasks.filter((task) => {
        const taskState = state.tasks.get(task.id)!;
        return taskState.state === "passed" || taskState.state === "merged";
      });
      if (!passed.length) return finish("failed", reason, null);
      // Partial delivery: integrate what passed instead of throwing the whole run away.
      let integration: Awaited<ReturnType<typeof integrate>>;
      try {
        integration = await integrate(ctx, true);
      } catch (error) {
        return finish("failed", `${reason}; partial integration failed: ${messageOf(error)}`, null);
      }
      return finish("failed", integration.ok ? `${reason}; integrated the ${passed.length} passed task(s)` : reason, integration.branch);
    }
    let integration: Awaited<ReturnType<typeof integrate>>;
    try {
      integration = await integrate(ctx);
    } catch (error) {
      return finish("failed", `integration failed: ${messageOf(error)}`, null);
    }
    return integration.ok ? finish("passed", null, integration.branch, integration.warnings ?? []) : finish("failed", integration.reason, integration.branch);
  } finally {
    events.close();
  }
}

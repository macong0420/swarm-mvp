#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { createPlan } from "../core/planner.js";
import type { PlannerCtx } from "../core/planner.js";
import { repoMap, runReadTool } from "../core/repo.js";
import { createClient } from "../models/factory.js";
import { configSchema, defaultConfig, parseConfig } from "../schema/config.js";
import type { Plan } from "../schema/plan.js";
import { EventStore } from "../store/events.js";
import type { EventInput } from "../store/events.js";
import { findRepoRoot, getBaseSha, gitCommand } from "../worker/worktree.js";
import { cleanup } from "../core/cleanup.js";
import { dryRunScripts, resumeRun, startRun } from "../core/run.js";
import { startConfigServer } from "./config-ui.js";
import { doctor } from "./doctor.js";
import { loadEnvFile } from "./env-file.js";
import { summarizeRun } from "./report.js";
import { startVizServer } from "./viz.js";

function flags(args: string[], options: Record<string, { type: "boolean" | "string"; short?: string }> = {}): { values: Record<string, string | boolean | undefined>; positionals: string[] } {
  return parseArgs({ args, options: { json: { type: "boolean" }, ...options }, allowPositionals: true, strict: true }) as {
    values: Record<string, string | boolean | undefined>;
    positionals: string[];
  };
}

function print(value: unknown, asJson: boolean): void {
  const output = asJson ? JSON.stringify(value, null, 2) : typeof value === "string" ? value : JSON.stringify(value, null, 2);
  process.stdout.write(`${output}\n`);
}

function swarmDir(repoRoot: string): string {
  return path.join(repoRoot, ".swarm");
}

async function loadConfig(repoRoot: string) {
  const filename = path.join(swarmDir(repoRoot), "config.json");
  return parseConfig(await readFile(filename, "utf8"));
}

/** Accept both a bare Plan and the `{ plan, estimatedCostUsd }` wrapper that `plan --json` prints. */
function readPlan(value: unknown): Plan {
  if (value && typeof value === "object" && "plan" in value) return (value as { plan: Plan }).plan;
  return value as Plan;
}

/** `swarm plan`: ask the planner for a plan without creating a run, so it can be reviewed (and later passed to `run --plan`). */
async function planRequest(repoRoot: string, request: string, asJson: boolean): Promise<void> {
  const config = await loadConfig(repoRoot);
  const { client, model } = createClient("planner", config);
  const baseSha = getBaseSha(repoRoot);
  const emitted: Array<Omit<EventInput, "runId">> = [];
  const fileExists = (file: string): boolean => {
    try {
      gitCommand(repoRoot, ["cat-file", "-e", `${baseSha}:${file}`]);
      return true;
    } catch {
      return false;
    }
  };
  const workerModels = [...new Set([
    config.worker.model,
    ...Object.values(config.worker.routes).map((route) => route.model).filter((model): model is string => Boolean(model)),
  ])].filter(Boolean);
  const ctx: PlannerCtx = {
    client,
    modelName: model,
    emit: (event) => { emitted.push(event); },
    limits: config.task,
    maxPlanRetries: config.maxPlanRetries,
    commandPolicy: config.commandPolicy,
    workerModels,
    fileExists,
    repo: {
      baseSha,
      map: repoMap(repoRoot, baseSha),
      maxToolTurns: config.planner.maxToolTurns,
      runTool: (name, args) => runReadTool(repoRoot, baseSha, name, args, config.planner),
    },
  };
  const planned = await createPlan(ctx, request);
  let cost: number | null = 0;
  for (const event of emitted) {
    if (event.type !== "model_call") continue;
    const modelName = typeof event.payload.model === "string" ? event.payload.model : "";
    const price = config.pricing[modelName];
    const usage = event.payload.usage as { inputTokens?: number; outputTokens?: number } | undefined;
    if (!price) {
      cost = null;
      break;
    }
    cost += ((usage?.inputTokens ?? 0) * price.inputPerMillion + (usage?.outputTokens ?? 0) * price.outputPerMillion) / 1_000_000;
  }
  if (asJson) print({ plan: planned, estimatedCostUsd: cost }, true);
  else {
    print(JSON.stringify(planned, null, 2), false);
    // Cost goes to stderr so stdout stays a plan file that `run --plan` can read.
    process.stderr.write(`Estimated planning cost: ${cost === null ? "not priced" : `$${cost.toFixed(6)}`}\n`);
  }
}

async function init(asJson: boolean): Promise<void> {
  const repoRoot = findRepoRoot(process.cwd());
  const directory = swarmDir(repoRoot);
  await mkdir(directory, { recursive: true });
  const configPath = path.join(directory, "config.json");
  try {
    await readFile(configPath);
    throw new Error(`${configPath} already exists; edit it directly`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFile(configPath, `${JSON.stringify(defaultConfig, null, 2)}\n`, { flag: "wx" });
  // The run database and config belong to this machine, not to the repository.
  const ignoreFile = path.join(repoRoot, ".gitignore");
  const ignore = await readFile(ignoreFile, "utf8").catch(() => "");
  if (!/^\/?\.swarm\/?$/m.test(ignore)) await writeFile(ignoreFile, `${ignore}${ignore && !ignore.endsWith("\n") ? "\n" : ""}.swarm/\n`);
  const dbPath = path.join(directory, "events.sqlite");
  const events = new EventStore(dbPath);
  events.close();
  const status = gitCommand(repoRoot, ["status", "--short"]);
  print({ repoRoot, configPath, dbPath, dirty: Boolean(status) }, asJson);
}

function latestRun(events: EventStore, explicitRunId?: string): string {
  const runId = explicitRunId ?? events.latestRunId();
  if (!runId) throw new Error("no run events found");
  return runId;
}

function statusText(result: ReturnType<typeof summarizeRun>): string {
  const lines = [
    `Run ${result.runId}: ${result.state} | ${result.elapsedMs} ms | ${result.inputTokens}/${result.outputTokens} tokens | cost ${result.estimatedCostUsd === null ? "not priced" : `$${result.estimatedCostUsd.toFixed(6)}`}`,
    ...(result.reason ? [`Reason: ${String(result.reason)}`] : []),
    ...(result.warnings.length ? [`Warnings: ${result.warnings.join("; ")}`] : []),
    "TASK  STATE  ATTEMPTS  ELAPSED_MS  INPUT  OUTPUT  COST  FAILURE",
    ...result.tasks.map((task) => `${task.taskId}  ${task.state}  ${task.attempts}  ${task.elapsedMs}  ${task.inputTokens}  ${task.outputTokens}  ${task.estimatedCostUsd === null ? "not priced" : `$${task.estimatedCostUsd.toFixed(6)}`}  ${task.failureReason ? task.failureReason.replace(/\s+/g, " ").slice(0, 120) : "-"}`),
  ];
  return lines.join("\n");
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  // .swarm/.env is the convenient local key store; the shell environment still wins.
  // The config page loads it itself so it can tell where each key came from.
  if (command !== "config") {
    try {
      loadEnvFile(path.join(findRepoRoot(process.cwd()), ".swarm", ".env"));
    } catch {
      // Not a Git repository, or no .swarm/.env yet.
    }
  }
  if (!command || command === "--help" || command === "-h") {
    print("Usage: swarm <init|config|plan|run|retry|runs|status|logs|viz|cleanup|doctor> [options]", false);
    return;
  }
  if (command === "init") {
    const parsed = flags(rest);
    await init(Boolean(parsed.values.json));
    return;
  }
  if (command === "config") {
    const parsed = flags(rest, { port: { type: "string" } });
    const repoRoot = findRepoRoot(process.cwd());
    const port = typeof parsed.values.port === "string" ? Number(parsed.values.port) : undefined;
    const server = await startConfigServer({ repoRoot, ...(port === undefined ? {} : { port }) });
    print(`蜂群配置: ${server.url}  (Ctrl+C 退出)`, false);
    return;
  }
  if (command === "plan") {
    const parsed = flags(rest);
    const request = parsed.positionals.join(" ").trim();
    if (!request) throw new Error('usage: swarm plan "<request>"');
    const repoRoot = findRepoRoot(process.cwd());
    await planRequest(repoRoot, request, Boolean(parsed.values.json));
    return;
  }
  if (command === "run") {
    const parsed = flags(rest, { "dry-run": { type: "boolean" }, resume: { type: "string" }, "max-concurrency": { type: "string" }, "max-cost": { type: "string" }, plan: { type: "string" } });
    const planPath = parsed.values.plan;
    const suppliedPlan = typeof planPath === "string" ? readPlan(JSON.parse(await readFile(planPath, "utf8")) as unknown) : undefined;
    const request = parsed.positionals[0] ?? suppliedPlan?.goal;
    const resume = parsed.values.resume;
    const maxConcurrency = parsed.values["max-concurrency"];
    const maxCost = parsed.values["max-cost"];
    const maxCostUsd = typeof maxCost === "string" ? configSchema.shape.run.unwrap().shape.maxCostUsd.parse(Number(maxCost)) : undefined;
    if (typeof resume === "string" && suppliedPlan) throw new Error("--plan cannot be combined with --resume");
    if (!request && typeof resume !== "string") throw new Error('usage: swarm run "<request>" [--plan <file>] [--resume <runId>] [--dry-run] [--max-concurrency N] [--max-cost USD]');
    const repoRoot = findRepoRoot(process.cwd());
    const scripts = parsed.values["dry-run"] ? { scripts: dryRunScripts() } : {};
    const controller = new AbortController();
    const onSigint = (): void => { controller.abort(); };
    process.once("SIGINT", onSigint);
    let result;
    try {
      if (typeof resume === "string") {
        // A resumed run keeps the configuration recorded in its run_started event.
        result = await resumeRun({ repoRoot, runId: resume, ...scripts, signal: controller.signal, ...(maxCostUsd === undefined ? {} : { maxCostUsd }) });
      } else {
        const config = await loadConfig(repoRoot);
        if (typeof maxConcurrency === "string") config.maxConcurrency = configSchema.shape.maxConcurrency.parse(Number(maxConcurrency));
        if (maxCostUsd !== undefined) config.run.maxCostUsd = maxCostUsd;
        result = await startRun({ repoRoot, request: request!, config, ...scripts, signal: controller.signal, ...(suppliedPlan ? { plan: suppliedPlan } : {}) });
      }
    } finally {
      process.removeListener("SIGINT", onSigint);
    }
    print(parsed.values.json ? result : result.summary, Boolean(parsed.values.json));
    if (result.state !== "passed") process.exitCode = 1;
    return;
  }
  if (command === "retry") {
    const parsed = flags(rest, { "max-cost": { type: "string" } });
    const runId = parsed.positionals[0];
    if (!runId) throw new Error("usage: swarm retry <runId> [--max-cost USD]");
    const maxCost = parsed.values["max-cost"];
    const maxCostUsd = typeof maxCost === "string" ? configSchema.shape.run.unwrap().shape.maxCostUsd.parse(Number(maxCost)) : undefined;
    const repoRoot = findRepoRoot(process.cwd());
    const result = await resumeRun({ repoRoot, runId, ...(maxCostUsd === undefined ? {} : { maxCostUsd }) });
    print(parsed.values.json ? result : result.summary, Boolean(parsed.values.json));
    if (result.state !== "passed") process.exitCode = 1;
    return;
  }
  if (command === "runs") {
    const parsed = flags(rest);
    const repoRoot = findRepoRoot(process.cwd());
    const events = new EventStore(path.join(swarmDir(repoRoot), "events.sqlite"));
    try {
      const runs = events.runIds().map((runId) => summarizeRun(events, runId));
      const text = runs.map((run) => `${run.runId}  ${run.state}  ${run.inputTokens}/${run.outputTokens} tokens  ${run.estimatedCostUsd === null ? "not priced" : `$${run.estimatedCostUsd.toFixed(4)}`}`).join("\n");
      print(parsed.values.json ? runs : text || "no runs", Boolean(parsed.values.json));
    } finally {
      events.close();
    }
    return;
  }
  if (command === "status" || command === "logs") {
    const parsed = flags(rest, {
      task: { type: "string" },
      type: { type: "string" },
    });
    const repoRoot = findRepoRoot(process.cwd());
    const events = new EventStore(path.join(swarmDir(repoRoot), "events.sqlite"));
    try {
      const runId = latestRun(events, parsed.positionals[0]);
      if (command === "status") {
        const result = summarizeRun(events, runId);
        print(parsed.values.json ? result : statusText(result), Boolean(parsed.values.json));
      } else {
        const filters = {
          runId,
          ...(typeof parsed.values.task === "string" ? { taskId: parsed.values.task } : {}),
          ...(typeof parsed.values.type === "string" ? { type: parsed.values.type } : {}),
        };
        print(events.list(filters), Boolean(parsed.values.json));
      }
    } finally {
      events.close();
    }
    return;
  }
  if (command === "viz") {
    const parsed = flags(rest, { port: { type: "string" } });
    const repoRoot = findRepoRoot(process.cwd());
    const events = new EventStore(path.join(swarmDir(repoRoot), "events.sqlite"));
    let runId: string;
    try {
      runId = latestRun(events, parsed.positionals[0]);
    } finally {
      events.close();
    }
    const port = typeof parsed.values.port === "string" ? Number(parsed.values.port) : undefined;
    const server = await startVizServer({ repoRoot, runId, ...(port === undefined ? {} : { port }) });
    print(`蜂群运行视图: ${server.url}  (run ${runId}，Ctrl+C 退出)`, false);
    return;
  }
  if (command === "doctor") {
    const parsed = flags(rest);
    const repoRoot = findRepoRoot(process.cwd());
    let config: Awaited<ReturnType<typeof loadConfig>> | null = null;
    let configError: string | null = null;
    try {
      config = await loadConfig(repoRoot);
    } catch (error) {
      configError = error instanceof Error ? error.message : String(error);
    }
    const checks = doctor(repoRoot, config, configError);
    print(parsed.values.json ? checks : checks.map((check) => `${check.level.toUpperCase().padEnd(5)} ${check.name}: ${check.detail}`).join("\n"), Boolean(parsed.values.json));
    if (checks.some((check) => check.level === "error")) process.exitCode = 1;
    return;
  }
  if (command === "cleanup") {
    const parsed = flags(rest);
    const repoRoot = findRepoRoot(process.cwd());
    const events = new EventStore(path.join(swarmDir(repoRoot), "events.sqlite"));
    try {
      print(cleanup(repoRoot, events), Boolean(parsed.values.json));
    } finally {
      events.close();
    }
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

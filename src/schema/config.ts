import { z } from "zod";

/** Per-task-kind overrides for the worker model and its budgets. */
export const routeSchema = z.object({
  provider: z.enum(["openai", "anthropic"]).optional(),
  model: z.string().min(1).optional(),
  fallbackModel: z.string().min(1).optional(),
  baseURL: z.string().min(1).optional(),
  apiKeyEnv: z.string().min(1).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  reasoningEffort: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  maxWallSec: z.number().int().positive().optional(),
});

export type WorkerRoute = z.infer<typeof routeSchema>;

export const configSchema = z.object({
  planner: z.object({
    provider: z.string().default("anthropic"),
    baseURL: z.string().default("https://api.anthropic.com"),
    model: z.string().default(""),
    fallbackModel: z.string().min(1).optional(),
    apiKeyEnv: z.string().default("ANTHROPIC_API_KEY"),
    maxOutputTokens: z.number().int().positive().default(16000),
    reasoningEffort: z.string().optional(),
    maxToolTurns: z.number().int().nonnegative().default(8),
    maxReadLines: z.number().int().positive().default(400),
    maxSearchHits: z.number().int().positive().default(50),
  }).default({ provider: "anthropic", baseURL: "https://api.anthropic.com", model: "", apiKeyEnv: "ANTHROPIC_API_KEY", maxOutputTokens: 16000, maxToolTurns: 8, maxReadLines: 400, maxSearchHits: 50 }),
  worker: z.object({
    provider: z.enum(["openai", "anthropic"]).default("openai"),
    baseURL: z.string().default(""),
    model: z.string().default(""),
    fallbackModel: z.string().min(1).optional(),
    apiKeyEnv: z.string().default("DEEPSEEK_API_KEY"),
    maxOutputTokens: z.number().int().positive().optional(),
    reasoningEffort: z.string().optional(),
    maxReadLines: z.number().int().positive().default(2000),
    /** Task kind (implement, test, refactor, docs, investigate) → model and budget overrides. */
    routes: z.record(z.string(), routeSchema).default({}),
  }).default({ provider: "openai", baseURL: "", model: "", apiKeyEnv: "DEEPSEEK_API_KEY", maxReadLines: 2000, routes: {} }),
  modelCall: z.object({
    timeoutSec: z.number().int().positive().default(300),
    maxRetries: z.number().int().nonnegative().default(3),
    /** Use the Anthropic streaming API. The OpenAI-compatible adapter remains non-streaming. */
    stream: z.boolean().default(false),
    /** Mark the Anthropic system prompt as ephemeral cacheable. Opt-in because gateways differ. */
    cacheSystemPrompt: z.boolean().default(false),
  }).default({ timeoutSec: 300, maxRetries: 3, stream: false, cacheSystemPrompt: false }),
  maxConcurrency: z.number().int().positive().default(4),
  maxLogicRetries: z.number().int().nonnegative().default(2),
  maxPlanRetries: z.number().int().nonnegative().default(3),
  maxTransientRetries: z.number().int().nonnegative().default(5),
  retryBaseMs: z.number().int().positive().default(1000),
  heartbeatSec: z.number().int().positive().default(15),
  leaseSec: z.number().int().positive().default(60),
  task: z.object({
    maxTurns: z.number().int().positive().default(20),
    maxTokens: z.number().int().positive().default(30000),
    maxWallSec: z.number().int().positive().default(900),
    maxFiles: z.number().int().positive().default(5),
    maxLines: z.number().int().positive().default(300),
    /** Replace older tool/user outputs with a short placeholder once the conversation exceeds this many characters. 0 disables. */
    maxContextChars: z.number().int().nonnegative().default(0),
  }).default({ maxTurns: 20, maxTokens: 30000, maxWallSec: 900, maxFiles: 5, maxLines: 300, maxContextChars: 0 }),
  /** The planner's integration fix (global acceptance / merge conflict) has its own model and budget. */
  integration: z.object({
    provider: z.enum(["openai", "anthropic"]).optional(),
    model: z.string().min(1).optional(),
    fallbackModel: z.string().min(1).optional(),
    baseURL: z.string().min(1).optional(),
    apiKeyEnv: z.string().min(1).optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    reasoningEffort: z.string().optional(),
    maxTurns: z.number().int().positive().default(30),
    maxTokens: z.number().int().positive().default(200000),
    maxWallSec: z.number().int().positive().default(900),
    /** Rerun global acceptance after the fix commit. */
    verifyAfterFix: z.boolean().default(true),
  }).default({ maxTurns: 30, maxTokens: 200000, maxWallSec: 900, verifyAfterFix: true }),
  run: z.object({
    maxCostUsd: z.number().nonnegative().default(10),
    /** Run global acceptance on the base commit before the tasks, for comparison at integration. */
    baseline: z.boolean().default(true),
    /** strict: every global acceptance failure blocks. ignore-existing: commands that already failed at baseline do not. */
    baselinePolicy: z.enum(["strict", "ignore-existing"]).default("strict"),
  }).default({ maxCostUsd: 10, baseline: true, baselinePolicy: "strict" }),
  worktree: z.object({
    linkNodeModules: z.boolean().default(false),
  }).default({ linkNodeModules: false }),
  failedWorktreeTtlMinutes: z.number().int().nonnegative().default(60),
  /** Minutes after a finished run when its passed/integration branches are removed; 0 keeps them forever. */
  keepBranchesMinutes: z.number().int().nonnegative().default(0),
  commandPolicy: z.object({
    allow: z.array(z.string()).default(["npm", "node"]),
    deny: z.array(z.string()).default(["push", "reset --hard", "clean -fd", "remote", "install"]),
    /** Extra environment variables (by name) that commands may inherit; everything else stays out. */
    env: z.array(z.string()).default([]),
    timeoutMs: z.number().int().positive().default(120000),
    outputLimitBytes: z.number().int().positive().default(20000),
  }).default({ allow: ["npm", "node"], deny: ["push", "reset --hard", "clean -fd", "remote", "install"], env: [], timeoutMs: 120000, outputLimitBytes: 20000 }),
  pricing: z.record(z.string(), z.object({
    inputPerMillion: z.number().nonnegative(),
    outputPerMillion: z.number().nonnegative(),
  })).default({}),
});

export type SwarmConfig = z.infer<typeof configSchema>;

export const defaultConfig: SwarmConfig = configSchema.parse({});

export function parseConfig(raw: string): SwarmConfig {
  return configSchema.parse(JSON.parse(raw) as unknown);
}

/** Everything one attempt needs from the worker settings: the route for its task kind merged over the defaults. */
export interface WorkerProfile {
  provider: "openai" | "anthropic";
  model: string;
  fallbackModel?: string;
  baseURL: string;
  apiKeyEnv: string;
  maxOutputTokens?: number;
  reasoningEffort?: string;
  maxTurns: number;
  maxTokens: number;
  maxWallSec: number;
}

export interface WorkerOverride {
  model?: string;
  reasoningEffort?: string;
}

export function workerProfile(config: SwarmConfig, kind: string, override: WorkerOverride = {}): WorkerProfile {
  const route = config.worker.routes[kind];
  const maxOutputTokens = route?.maxOutputTokens ?? config.worker.maxOutputTokens;
  const reasoningEffort = override.reasoningEffort ?? route?.reasoningEffort ?? config.worker.reasoningEffort;
  const fallbackModel = route?.fallbackModel ?? config.worker.fallbackModel;
  return {
    provider: route?.provider ?? config.worker.provider,
    model: override.model ?? route?.model ?? config.worker.model,
    ...(fallbackModel === undefined ? {} : { fallbackModel }),
    baseURL: route?.baseURL ?? config.worker.baseURL,
    apiKeyEnv: route?.apiKeyEnv ?? config.worker.apiKeyEnv,
    maxTurns: route?.maxTurns ?? config.task.maxTurns,
    maxTokens: route?.maxTokens ?? config.task.maxTokens,
    maxWallSec: route?.maxWallSec ?? config.task.maxWallSec,
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  };
}

/** The integration fix defaults to the planner model, with its own turn/token/wall-clock budget. */
export function integrationProfile(config: SwarmConfig): WorkerProfile {
  const integration = config.integration;
  const maxOutputTokens = integration.maxOutputTokens ?? config.planner.maxOutputTokens;
  const reasoningEffort = integration.reasoningEffort ?? config.planner.reasoningEffort;
  const fallbackModel = integration.fallbackModel ?? config.planner.fallbackModel;
  return {
    provider: integration.provider ?? (config.planner.provider === "openai" ? "openai" : "anthropic"),
    model: integration.model ?? config.planner.model,
    ...(fallbackModel === undefined ? {} : { fallbackModel }),
    baseURL: integration.baseURL ?? config.planner.baseURL,
    apiKeyEnv: integration.apiKeyEnv ?? config.planner.apiKeyEnv,
    maxTurns: integration.maxTurns,
    maxTokens: integration.maxTokens,
    maxWallSec: integration.maxWallSec,
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  };
}

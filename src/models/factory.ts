import type { SwarmConfig } from "../schema/config.js";
import { registerSecret } from "../store/redact.js";
import { AnthropicClient } from "./anthropic.js";
import type { ModelClient } from "./client.js";
import { FallbackClient } from "./fallback.js";
import { OpenAICompatClient } from "./openai.js";

/** Per-task overrides (worker routes); the key is still read from the environment and never stored. */
export interface ClientOverrides {
  provider?: "openai" | "anthropic";
  model?: string;
  fallbackModel?: string;
  baseURL?: string;
  apiKeyEnv?: string;
  maxOutputTokens?: number;
  reasoningEffort?: string;
}

/** Build the real client for a role from configuration, with the task's route applied over the role defaults. */
export function createClient(role: "planner" | "worker", config: SwarmConfig, overrides: ClientOverrides = {}): { client: ModelClient; model: string } {
  const settings = config[role];
  const model = overrides.model ?? settings.model;
  const baseURL = overrides.baseURL ?? settings.baseURL;
  const apiKeyEnv = overrides.apiKeyEnv ?? settings.apiKeyEnv;
  const reasoningEffort = overrides.reasoningEffort ?? settings.reasoningEffort;
  const fallbackModel = overrides.fallbackModel ?? (role === "planner" ? config.planner.fallbackModel : config.worker.fallbackModel);
  if (!model) throw new Error(`${role}.model is not set in .swarm/config.json`);
  if (!baseURL) throw new Error(`${role}.baseURL is not set in .swarm/config.json`);
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) throw new Error(`environment variable ${apiKeyEnv} (${role}.apiKeyEnv) is not set`);
  registerSecret(apiKey);
  const common = {
    baseURL,
    apiKey,
    timeoutSec: config.modelCall.timeoutSec,
    maxRetries: config.modelCall.maxRetries,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
  const provider = overrides.provider ?? (role === "planner" ? config.planner.provider : config.worker.provider);
  const build = (clientModel: string): ModelClient => {
    if (provider === "anthropic") {
      const maxOutputTokens = overrides.maxOutputTokens ?? (role === "planner" ? config.planner.maxOutputTokens : config.worker.maxOutputTokens ?? config.planner.maxOutputTokens);
      return new AnthropicClient({ ...common, model: clientModel, maxOutputTokens, stream: config.modelCall.stream, cacheSystemPrompt: config.modelCall.cacheSystemPrompt });
    }
    if (provider === "openai") {
      const maxOutputTokens = overrides.maxOutputTokens ?? (role === "planner" ? config.planner.maxOutputTokens : config.worker.maxOutputTokens);
      return new OpenAICompatClient({ ...common, model: clientModel, ...(maxOutputTokens ? { maxOutputTokens } : {}) });
    }
    throw new Error(`unknown planner.provider "${provider}" (use "anthropic" or "openai")`);
  };
  const primary = build(model);
  if (fallbackModel && fallbackModel !== model) return { client: new FallbackClient(primary, build(fallbackModel)), model };
  return { client: primary, model };
}

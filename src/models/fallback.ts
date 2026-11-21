import { TransientError } from "./client.js";
import type { ChatResult, ModelClient, ModelMessage } from "./client.js";

/**
 * Try the primary model; on a final (non-transient) error, use the fallback model.
 * Transient errors are left to the task retry policy.
 */
export class FallbackClient implements ModelClient {
  constructor(private readonly primary: ModelClient, private readonly fallback: ModelClient) {}

  async chat(params: { messages: ModelMessage[]; tools?: Array<Record<string, unknown>>; responseSchema?: Record<string, unknown>; reasoningEffort?: string; signal?: AbortSignal }): Promise<ChatResult> {
    try {
      return await this.primary.chat(params);
    } catch (error) {
      if (error instanceof TransientError) throw error;
      return this.fallback.chat(params);
    }
  }
}

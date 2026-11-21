import OpenAI from "openai";
import { TransientError } from "./client.js";
import type { ChatResult, ModelClient, ModelMessage } from "./client.js";

export interface OpenAICompatOptions {
  baseURL: string;
  apiKey: string;
  model: string;
  maxOutputTokens?: number;
  reasoningEffort?: string;
  timeoutSec: number;
  maxRetries: number;
}

function parseArguments(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  } catch {
    // Truncated or malformed arguments: the tool rejects the empty call and the model gets to try again.
    return {};
  }
}

/** Any OpenAI-compatible chat completions endpoint (DeepSeek and others). Retries, backoff and timeouts are the SDK's. */
export class OpenAICompatClient implements ModelClient {
  private readonly client: OpenAI;

  constructor(private readonly options: OpenAICompatOptions) {
    this.client = new OpenAI({ baseURL: options.baseURL, apiKey: options.apiKey, maxRetries: options.maxRetries, timeout: options.timeoutSec * 1000 });
  }

  async chat(params: { messages: ModelMessage[]; tools?: Array<Record<string, unknown>>; signal?: AbortSignal }): Promise<ChatResult> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = params.messages.map((message) => {
      if (message.role === "tool") return { role: "tool", tool_call_id: message.toolCallId ?? "", content: message.content };
      if (message.role !== "assistant") return { role: message.role, content: message.content };
      return {
        role: "assistant",
        content: message.content,
        ...(message.toolCalls?.length
          ? { tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }
          : {}),
      };
    });
    const tools = (params.tools ?? []).map((tool) => ({
      type: "function" as const,
      function: { name: String(tool.name), description: String(tool.description ?? ""), parameters: tool.input_schema as Record<string, unknown> },
    }));

    let response: OpenAI.Chat.ChatCompletion;
    try {
      response = await this.client.chat.completions.create({
        model: this.options.model,
        messages,
        ...(tools.length ? { tools } : {}),
        ...(this.options.maxOutputTokens ? { max_tokens: this.options.maxOutputTokens } : {}),
        ...(this.options.reasoningEffort ? { reasoning_effort: this.options.reasoningEffort as OpenAI.ReasoningEffort } : {}),
      }, params.signal ? { signal: params.signal } : {});
    } catch (error) {
      if (error instanceof OpenAI.APIConnectionError || error instanceof OpenAI.RateLimitError || error instanceof OpenAI.InternalServerError) {
        throw new TransientError(error.message);
      }
      throw error;
    }
    const message = response.choices[0]?.message;
    if (!message) throw new TransientError("the model returned no choices");
    return {
      message: { role: "assistant", content: message.content ?? "" },
      toolCalls: (message.tool_calls ?? []).flatMap((call) => (call.type === "function" ? [{ id: call.id, name: call.function.name, arguments: parseArguments(call.function.arguments) }] : [])),
      usage: { inputTokens: response.usage?.prompt_tokens ?? 0, outputTokens: response.usage?.completion_tokens ?? 0 },
    };
  }
}

import Anthropic from "@anthropic-ai/sdk";
import { TransientError } from "./client.js";
import type { ChatResult, ModelClient, ModelMessage } from "./client.js";

export interface AnthropicOptions {
  baseURL: string;
  apiKey: string;
  model: string;
  maxOutputTokens: number;
  reasoningEffort?: string;
  timeoutSec: number;
  maxRetries: number;
  /** Use the streaming API and wait for the final message. */
  stream?: boolean;
  /** Mark the system prompt as ephemeral cacheable (Anthropic prompt caching). */
  cacheSystemPrompt?: boolean;
}

/** Anthropic Messages API. Retries, backoff and timeouts are the SDK's; what is still failing afterwards is classified here. */
export class AnthropicClient implements ModelClient {
  private readonly client: Anthropic;

  constructor(private readonly options: AnthropicOptions) {
    this.client = new Anthropic({ baseURL: options.baseURL, apiKey: options.apiKey, maxRetries: options.maxRetries, timeout: options.timeoutSec * 1000 });
  }

  async chat(params: { messages: ModelMessage[]; tools?: Array<Record<string, unknown>>; signal?: AbortSignal }): Promise<ChatResult> {
    const system = params.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
    const messages: Anthropic.MessageParam[] = [];
    for (const message of params.messages) {
      if (message.role === "system") continue;
      if (message.role === "assistant") {
        // Replay the model's own blocks unchanged: thinking blocks must come back exactly as they were sent.
        messages.push({ role: "assistant", content: (message.raw as Anthropic.ContentBlockParam[] | undefined) ?? plainAssistant(message) });
        continue;
      }
      const block: Anthropic.ContentBlockParam = message.role === "tool"
        ? { type: "tool_result", tool_use_id: message.toolCallId ?? "", content: message.content }
        : { type: "text", text: message.content };
      // All tool results of one turn, and any user text after them, go into a single user message.
      const last = messages.at(-1);
      if (last?.role === "user" && Array.isArray(last.content)) last.content.push(block);
      else messages.push({ role: "user", content: [block] });
    }

    let response: Anthropic.Message;
    const systemParam = system
      ? (this.options.cacheSystemPrompt
        ? [{ type: "text" as const, text: system, cache_control: { type: "ephemeral" as const } }]
        : system)
      : undefined;
    const request = {
      model: this.options.model,
      max_tokens: this.options.maxOutputTokens,
      messages,
      ...(systemParam ? { system: systemParam } : {}),
      ...(params.tools?.length ? { tools: params.tools as unknown as Anthropic.Tool[] } : {}),
      ...(this.options.reasoningEffort ? { output_config: { effort: this.options.reasoningEffort as NonNullable<Anthropic.OutputConfig["effort"]> } } : {}),
    } satisfies Anthropic.MessageCreateParamsNonStreaming;
    try {
      response = this.options.stream
        ? await this.client.messages.stream(request, params.signal ? { signal: params.signal } : {}).finalMessage()
        : await this.client.messages.create(request, params.signal ? { signal: params.signal } : {});
    } catch (error) {
      if (error instanceof Anthropic.APIConnectionError || error instanceof Anthropic.RateLimitError || error instanceof Anthropic.InternalServerError) {
        throw new TransientError(error.message);
      }
      throw error;
    }
    if (response.stop_reason === "refusal") throw new Error("the model declined the request (stop_reason: refusal)");

    const usage = response.usage;
    return {
      message: {
        role: "assistant",
        content: response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(""),
        raw: response.content,
      },
      toolCalls: response.content.flatMap((block) => (block.type === "tool_use" ? [{ id: block.id, name: block.name, arguments: block.input as Record<string, unknown> }] : [])),
      // Cached prompt tokens are reported separately; count them as input so cost estimates err high, not low.
      usage: { inputTokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0), outputTokens: usage.output_tokens },
    };
  }
}

function plainAssistant(message: ModelMessage): Anthropic.ContentBlockParam[] {
  return [
    ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
    ...(message.toolCalls ?? []).map((call) => ({ type: "tool_use" as const, id: call.id, name: call.name, input: call.arguments })),
  ];
}

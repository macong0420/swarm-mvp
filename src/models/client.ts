export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: ModelToolCall[];
  /** Provider-native assistant payload, replayed unchanged by the adapter that produced it. */
  raw?: unknown;
}

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResult {
  message: { role: "assistant"; content: string; raw?: unknown };
  toolCalls: ModelToolCall[];
  usage: ModelUsage;
}

export interface ModelClient {
  chat(params: {
    messages: ModelMessage[];
    tools?: Array<Record<string, unknown>>;
    responseSchema?: Record<string, unknown>;
    reasoningEffort?: string;
    signal?: AbortSignal;
  }): Promise<ChatResult>;
}

/** Rate limits, network errors and timeouts: retried with backoff, never counted as a logic failure. */
export class TransientError extends Error {}

/** A scripted reply, or an injected fault: transient error, process crash, or a frozen event loop (no heartbeats). */
export type MockStep = ChatResult | { fault: "transient" | "crash" | "freeze" };

/** Planner replies in call order; worker scripts per task id, one script per attempt (the last one is reused). */
export interface MockScripts {
  planner: MockStep[];
  tasks: Record<string, MockStep[][]>;
}

const mockUsage: ModelUsage = { inputTokens: 10, outputTokens: 10 };
let mockCallId = 0;

export function mockText(content: string): ChatResult {
  return { message: { role: "assistant", content }, toolCalls: [], usage: mockUsage };
}

export function mockTool(name: string, args: Record<string, unknown> = {}): ChatResult {
  return { message: { role: "assistant", content: "" }, toolCalls: [{ id: `${name}-${++mockCallId}`, name, arguments: args }], usage: mockUsage };
}

export class MockClient implements ModelClient {
  private cursor = 0;
  readonly calls: Array<{ messages: ModelMessage[]; tools?: Array<Record<string, unknown>> }> = [];

  constructor(private readonly responses: MockStep[]) {}

  async chat(params: { messages: ModelMessage[]; tools?: Array<Record<string, unknown>> }): Promise<ChatResult> {
    this.calls.push({ messages: params.messages, ...(params.tools ? { tools: params.tools } : {}) });
    const response = this.responses[this.cursor++];
    if (!response) throw new Error("MockClient response script exhausted");
    if ("fault" in response) {
      if (response.fault === "transient") throw new TransientError("mock transient failure");
      if (response.fault === "crash") process.exit(1);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600_000);
      throw new Error("mock freeze elapsed");
    }
    return response;
  }
}

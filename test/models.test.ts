import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { AnthropicClient } from "../src/models/anthropic.js";
import { TransientError } from "../src/models/client.js";
import type { ModelMessage } from "../src/models/client.js";
import { createClient } from "../src/models/factory.js";
import { OpenAICompatClient } from "../src/models/openai.js";
import { config } from "./helpers.js";

// A local stand-in for the provider: records the last request and replies with what the test queued.
let server: Server;
let baseURL = "";
let reply: { status: number; body: unknown } = { status: 200, body: {} };
let seen: { url: string; headers: Record<string, unknown>; body: Record<string, any> } = { url: "", headers: {}, body: {} };

before(async () => {
  server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => { text += chunk; });
    request.on("end", () => {
      seen = { url: request.url ?? "", headers: request.headers, body: JSON.parse(text) };
      response.writeHead(reply.status, { "content-type": "application/json" }).end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const tools = [{ name: "write_file", description: "Write a file", input_schema: { type: "object", properties: { path: { type: "string" } } } }];
const conversation = (raw?: unknown): ModelMessage[] => [
  { role: "system", content: "Be brief." },
  { role: "user", content: "Do the task." },
  { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "write_file", arguments: { path: "a.txt" } }], ...(raw ? { raw } : {}) },
  { role: "tool", toolCallId: "call-1", content: "{\"written\":true}" },
  { role: "user", content: "Acceptance failed." },
];
const limits = { timeoutSec: 5, maxRetries: 0 };

describe("AnthropicClient", () => {
  const client = () => new AnthropicClient({ baseURL, apiKey: "test-key", model: "claude-x", maxOutputTokens: 1000, reasoningEffort: "low", ...limits });

  it("sends Messages API requests and reads text, tool calls and usage including cached tokens", async () => {
    const thinking = { type: "thinking", thinking: "", signature: "sig" };
    const toolUse = { type: "tool_use", id: "call-2", name: "write_file", input: { path: "b.txt" } };
    reply = { status: 200, body: { id: "m", type: "message", role: "assistant", model: "claude-x", stop_reason: "tool_use", content: [thinking, { type: "text", text: "ok" }, toolUse], usage: { input_tokens: 4, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 7 } } };
    const replayed = [thinking, { type: "tool_use", id: "call-1", name: "write_file", input: { path: "a.txt" } }];
    const result = await client().chat({ messages: conversation(replayed), tools });

    assert.equal(seen.url, "/v1/messages");
    // Which header carries the key is the SDK's business; it must reach the server in one of them.
    assert.ok([seen.headers["x-api-key"], seen.headers.authorization].some((header) => String(header).includes("test-key")));
    assert.equal(seen.body.model, "claude-x");
    assert.equal(seen.body.system, "Be brief.");
    assert.deepEqual(seen.body.output_config, { effort: "low" });
    assert.deepEqual(seen.body.tools, tools);
    // The assistant turn is replayed block for block; its tool result and the next user text share one user message.
    assert.deepEqual(seen.body.messages.map((message: { role: string }) => message.role), ["user", "assistant", "user"]);
    assert.deepEqual(seen.body.messages[1].content, replayed);
    assert.deepEqual(seen.body.messages[2].content, [{ type: "tool_result", tool_use_id: "call-1", content: "{\"written\":true}" }, { type: "text", text: "Acceptance failed." }]);

    assert.equal(result.message.content, "ok");
    assert.deepEqual(result.toolCalls, [{ id: "call-2", name: "write_file", arguments: { path: "b.txt" } }]);
    assert.deepEqual(result.usage, { inputTokens: 114, outputTokens: 7 });
    assert.deepEqual(result.message.raw, [thinking, { type: "text", text: "ok" }, toolUse]);
  });

  it("classifies server errors as transient and request errors as final", async () => {
    reply = { status: 529, body: { type: "error", error: { type: "overloaded_error", message: "overloaded" } } };
    await assert.rejects(client().chat({ messages: conversation() }), TransientError);
    reply = { status: 429, body: { type: "error", error: { type: "rate_limit_error", message: "slow down" } } };
    await assert.rejects(client().chat({ messages: conversation() }), TransientError);
    reply = { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "bad model" } } };
    await assert.rejects(client().chat({ messages: conversation() }), (error: Error) => !(error instanceof TransientError) && /bad model/.test(error.message));
  });
});

describe("OpenAICompatClient", () => {
  const client = () => new OpenAICompatClient({ baseURL: `${baseURL}/v1`, apiKey: "test-key", model: "deepseek-x", reasoningEffort: "low", ...limits });
  const completion = (toolArguments: string) => ({ id: "c", object: "chat.completion", model: "deepseek-x", choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, reasoning_content: "hidden", tool_calls: [{ id: "call-2", type: "function", function: { name: "write_file", arguments: toolArguments } }] } }], usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 } });

  it("sends chat completion requests and reads tool calls and usage", async () => {
    reply = { status: 200, body: completion("{\"path\":\"b.txt\"}") };
    const result = await client().chat({ messages: conversation(), tools });

    assert.equal(seen.url, "/v1/chat/completions");
    assert.equal(seen.headers.authorization, "Bearer test-key");
    assert.equal(seen.body.model, "deepseek-x");
    assert.equal(seen.body.reasoning_effort, "low");
    assert.deepEqual(seen.body.tools, [{ type: "function", function: { name: "write_file", description: "Write a file", parameters: tools[0]!.input_schema } }]);
    assert.deepEqual(seen.body.messages.map((message: { role: string }) => message.role), ["system", "user", "assistant", "tool", "user"]);
    assert.deepEqual(seen.body.messages[2].tool_calls, [{ id: "call-1", type: "function", function: { name: "write_file", arguments: "{\"path\":\"a.txt\"}" } }]);
    assert.deepEqual(seen.body.messages[3], { role: "tool", tool_call_id: "call-1", content: "{\"written\":true}" });

    assert.deepEqual(result.toolCalls, [{ id: "call-2", name: "write_file", arguments: { path: "b.txt" } }]);
    assert.deepEqual(result.usage, { inputTokens: 30, outputTokens: 5 });
    assert.equal(result.message.content, "");
  });

  it("turns truncated tool arguments into an empty call instead of failing the attempt", async () => {
    reply = { status: 200, body: completion("{\"path\":\"b.t") };
    assert.deepEqual((await client().chat({ messages: conversation(), tools })).toolCalls[0]?.arguments, {});
  });

  it("classifies server errors as transient and request errors as final", async () => {
    reply = { status: 503, body: { error: { message: "down" } } };
    await assert.rejects(client().chat({ messages: conversation() }), TransientError);
    reply = { status: 401, body: { error: { message: "Invalid token" } } };
    await assert.rejects(client().chat({ messages: conversation() }), (error: Error) => !(error instanceof TransientError) && /Invalid token/.test(error.message));
  });
});

describe("createClient", () => {
  it("builds each role from configuration and names what is missing", () => {
    process.env.SWARM_TEST_KEY = "k";
    const settings = { baseURL: "http://127.0.0.1:1", model: "m", apiKeyEnv: "SWARM_TEST_KEY" };
    try {
      assert.ok(createClient("planner", config({ planner: settings })).client instanceof AnthropicClient);
      assert.ok(createClient("planner", config({ planner: { ...settings, provider: "openai" } })).client instanceof OpenAICompatClient);
      assert.ok(createClient("worker", config({ worker: settings })).client instanceof OpenAICompatClient);
      assert.throws(() => createClient("worker", config()), /worker\.model is not set/);
      assert.throws(() => createClient("worker", config({ worker: { ...settings, apiKeyEnv: "SWARM_TEST_UNSET" } })), /SWARM_TEST_UNSET \(worker\.apiKeyEnv\) is not set/);
      assert.throws(() => createClient("planner", config({ planner: { ...settings, provider: "other" } })), /unknown planner\.provider/);
    } finally {
      delete process.env.SWARM_TEST_KEY;
    }
  });
});

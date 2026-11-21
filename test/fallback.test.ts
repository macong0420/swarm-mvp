import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MockClient, TransientError, mockText } from "../src/models/client.js";
import { FallbackClient } from "../src/models/fallback.js";

class FailingClient extends MockClient {
  constructor(private readonly failure: Error) {
    super([]);
  }

  override async chat(): Promise<never> {
    throw this.failure;
  }
}

describe("FallbackClient", () => {
  it("uses the fallback on a final error", async () => {
    const client = new FallbackClient(new FailingClient(new Error("boom")), new MockClient([mockText("ok")]));
    assert.equal((await client.chat({ messages: [] })).message.content, "ok");
  });

  it("leaves a transient error to the task retry policy", async () => {
    const client = new FallbackClient(new FailingClient(new TransientError("rate limited")), new MockClient([mockText("ok")]));
    await assert.rejects(client.chat({ messages: [] }), /rate limited/);
  });
});

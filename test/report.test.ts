import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { summarizeRun } from "../src/cli/report.js";
import { configSchema } from "../src/schema/config.js";
import { EventStore } from "../src/store/events.js";

describe("summarizeRun", () => {
  it("marks a run whose scheduler process is gone as stale", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "swarm-report-"));
    try {
      const store = new EventStore(path.join(dir, "events.sqlite"));
      try {
        store.append({ runId: "stale", type: "run_started", payload: { request: "x", baseSha: "0".repeat(40), config: configSchema.parse({}) } });
        store.append({ runId: "stale", type: "scheduler_started", payload: { pid: 99999999 } });
        assert.equal(summarizeRun(store, "stale").state, "stale");
      } finally {
        store.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

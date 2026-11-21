import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { afterEach, describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventStore } from "../src/store/events.js";
import { registerSecret } from "../src/store/redact.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("EventStore", () => {
  it("appends and filters events while rejecting updates and deletes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "swarm-events-"));
    roots.push(root);
    const filename = path.join(root, "events.sqlite");
    const events = new EventStore(filename);
    events.append({ runId: "r1", taskId: "t1", type: "task_state_changed", payload: { to: "ready" } });
    events.append({ runId: "r1", taskId: "t2", type: "failure", payload: { class: "logic" } });
    assert.equal(events.list({ runId: "r1", taskId: "t1" }).length, 1);
    assert.equal(events.latestRunId(), "r1");
    const db = new Database(filename);
    assert.throws(() => db.prepare("UPDATE events SET type = 'x' WHERE id = 1").run(), /append-only/);
    assert.throws(() => db.prepare("DELETE FROM events WHERE id = 1").run(), /append-only/);
    db.close();
    events.close();
  });

  it("redacts registered secrets in event payloads", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "swarm-events-"));
    roots.push(root);
    const events = new EventStore(path.join(root, "events.sqlite"));
    registerSecret("super-secret-token");
    events.append({ runId: "r2", type: "failure", payload: { errorSummary: "bad super-secret-token", nested: ["super-secret-token"] } });
    const [event] = events.list({ runId: "r2" });
    assert.equal(event!.payload.errorSummary, "bad [REDACTED]");
    assert.deepEqual(event!.payload.nested, ["[REDACTED]"]);
    events.close();
  });
});

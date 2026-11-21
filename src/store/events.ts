import Database from "better-sqlite3";
import { chmodSync } from "node:fs";
import { redact } from "./redact.js";

export interface EventInput {
  runId: string;
  taskId?: string;
  attempt?: number;
  type: string;
  payload: Record<string, unknown>;
  ts?: string;
}

export interface StoredEvent {
  id: number;
  ts: string;
  runId: string;
  taskId: string | null;
  attempt: number | null;
  type: string;
  payload: Record<string, unknown>;
}

export class EventStore {
  private readonly db: Database.Database;

  constructor(filename: string) {
    this.db = new Database(filename);
    try {
      chmodSync(filename, 0o600);
    } catch {
      // Windows and some filesystems do not support POSIX permissions.
    }
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        runId TEXT NOT NULL,
        taskId TEXT,
        attempt INTEGER,
        type TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_run_id_id ON events(runId, id);
      CREATE TRIGGER IF NOT EXISTS events_no_update
      BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS events_no_delete
      BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
    `);
  }

  append(event: EventInput): number {
    const result = this.db.prepare(`
      INSERT INTO events (ts, runId, taskId, attempt, type, payload)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      event.ts ?? new Date().toISOString(),
      event.runId,
      event.taskId ?? null,
      event.attempt ?? null,
      event.type,
      JSON.stringify(redact(event.payload)),
    );
    return Number(result.lastInsertRowid);
  }

  list(filters: { runId: string; taskId?: string; type?: string }): StoredEvent[] {
    const conditions = ["runId = @runId"];
    const params: Record<string, string> = { runId: filters.runId };
    if (filters.taskId) {
      conditions.push("taskId = @taskId");
      params.taskId = filters.taskId;
    }
    if (filters.type) {
      conditions.push("type = @type");
      params.type = filters.type;
    }
    const rows = this.db.prepare(`
      SELECT id, ts, runId, taskId, attempt, type, payload
      FROM events WHERE ${conditions.join(" AND ")} ORDER BY id
    `).all(params) as Array<Omit<StoredEvent, "payload"> & { payload: string }>;
    return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) as Record<string, unknown> }));
  }

  usageByModel(runId: string): Array<{ model: string; inputTokens: number; outputTokens: number }> {
    return this.db.prepare(`
      SELECT COALESCE(json_extract(payload, '$.model'), '') AS model,
             COALESCE(SUM(json_extract(payload, '$.usage.inputTokens')), 0) AS inputTokens,
             COALESCE(SUM(json_extract(payload, '$.usage.outputTokens')), 0) AS outputTokens
      FROM events WHERE runId = ? AND type = 'model_call' GROUP BY model
    `).all(runId) as Array<{ model: string; inputTokens: number; outputTokens: number }>;
  }

  runIds(): string[] {
    return (this.db.prepare("SELECT runId FROM events GROUP BY runId ORDER BY MAX(id)").all() as Array<{ runId: string }>).map((row) => row.runId);
  }

  latestRunId(): string | undefined {
    const row = this.db.prepare("SELECT runId FROM events ORDER BY id DESC LIMIT 1").get() as { runId: string } | undefined;
    return row?.runId;
  }

  close(): void {
    this.db.close();
  }
}

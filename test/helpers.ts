import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mockText, mockTool } from "../src/models/client.js";
import type { MockScripts, MockStep } from "../src/models/client.js";
import { configSchema } from "../src/schema/config.js";
import type { SwarmConfig } from "../src/schema/config.js";
import type { Plan, Task } from "../src/schema/plan.js";
import { EventStore } from "../src/store/events.js";
import type { StoredEvent } from "../src/store/events.js";
import { startRun } from "../src/core/run.js";
import type { RunOptions, RunResult } from "../src/core/run.js";

const roots: string[] = [];
export async function removeRepos(): Promise<void> {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// Plain-argv check scripts, because acceptance commands cannot use shell syntax or quotes.
const fixtures: Record<string, string> = {
  // node exists.js <file>... : every file exists
  "exists.js": 'process.exit(process.argv.slice(2).every((file) => require("node:fs").existsSync(file)) ? 0 : 1);\n',
  // node expect.js <file> <content> : file content equals <content>
  "expect.js": 'const fs = require("node:fs"); const [file, want] = process.argv.slice(2);\nconst got = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "<missing>";\nif (got !== want) { console.error(`${file}: expected ${want}, got ${got}`); process.exit(1); }\n',
  // node contains.js <file> <needle> : file exists and contains needle
  "contains.js": 'const fs = require("node:fs"); const [file, needle] = process.argv.slice(2);\nprocess.exit(fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(needle) ? 0 : 1);\n',
  // node mess.js : writes a file no task may write
  "mess.js": 'require("node:fs").writeFileSync("stray.txt", "x");\n',
  "sleep.js": "setTimeout(() => {}, 60000);\n",
};

export async function makeRepo(files: Record<string, string> = {}): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "swarm-repo-")));
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  for (const [name, content] of Object.entries({ ...fixtures, ...files })) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  await writeFile(path.join(root, ".gitignore"), ".swarm/\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return root;
}

export function config(overrides: Record<string, unknown> = {}): SwarmConfig {
  return configSchema.parse({ retryBaseMs: 10, commandPolicy: { allow: ["node"] }, ...overrides });
}

export function task(id: string, writeScope: string[], dependsOn: string[] = [], commands = ["node -p 1"]): Task {
  return { id, kind: "implement", title: `Implement ${id}`, description: "Do one focused change.", writeScope, readContext: [], dependsOn, acceptance: { commands }, estimate: { files: 1, lines: 10 } };
}

export const plan = (tasks: Task[], globalAcceptance: string[] = []): Plan => ({ goal: "test", globalAcceptance, tasks });
export const json = (value: unknown): MockStep => mockText(JSON.stringify(value));
export const write = (file: string, content: string): MockStep => mockTool("write_file", { path: file, content });
export const command = (text: string): MockStep => mockTool("run_command", { command: text });
export const finish = (): MockStep => mockTool("finish");
/** A whole attempt that writes one file and finishes. */
export const writes = (file: string, content: string): MockStep[] => [write(file, content), finish()];

export const dbPath = (repo: string): string => path.join(repo, ".swarm", "events.sqlite");

export function run(repo: string, scripts: MockScripts, overrides: Record<string, unknown> = {}, options: Partial<RunOptions> = {}): Promise<RunResult> {
  return startRun({ repoRoot: repo, request: "test request", config: config(overrides), scripts, tickMs: 20, ...options });
}

export function eventsOf(repo: string, runId: string, type?: string, taskId?: string): StoredEvent[] {
  const store = new EventStore(dbPath(repo));
  try {
    return store.list({ runId, ...(type ? { type } : {}), ...(taskId ? { taskId } : {}) });
  } finally {
    store.close();
  }
}

export const stateOf = (result: RunResult, id: string): string | undefined => result.tasks.find((entry) => entry.id === id)?.state;

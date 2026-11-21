import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CommandPolicy {
  allow: string[];
  deny: string[];
  /** Extra environment variables (by name) commands may inherit; everything else stays out. */
  env?: string[];
  timeoutMs: number;
  outputLimitBytes: number;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

// A throwaway HOME per worker process: package managers write caches there, which must land neither in
// the worktree (it would look like an out-of-scope change) nor in the user's real home directory.
const scratchHome = path.join(os.tmpdir(), `swarm-home-${process.pid}`);
mkdirSync(scratchHome, { recursive: true });

const baseEnv = ["PATH", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "LANG"];

function commandEnv(policy: CommandPolicy): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: scratchHome, USERPROFILE: scratchHome };
  for (const key of [...baseEnv, ...(policy.env ?? [])]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

const shellMeta = /[;&|<>`\n\r]/;

/**
 * Split plain argv text into arguments: whitespace separates, single/double quotes group one argument,
 * and a backslash escapes the next character outside single quotes. Nothing is expanded; no shell runs.
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let started = false;
  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    if (shellMeta.test(char)) throw new Error("command must be plain argv text without shell syntax");
    current += char;
    started = true;
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("command has an unterminated quote");
  if (started) tokens.push(current);
  return tokens;
}

function parseCommand(command: string, policy: CommandPolicy): { file: string; args: string[] } {
  const input = command.trim();
  if (!input) throw new Error("command must be plain argv text without shell syntax");
  if (policy.deny.some((pattern) => input.toLowerCase().includes(pattern.toLowerCase()))) {
    throw new Error("command rejected by deny policy");
  }
  const [file, ...args] = tokenizeCommand(input);
  if (!file) throw new Error("command is empty");
  if (!policy.allow.includes(file)) throw new Error(`command is not allowed: ${file}`);
  return { file, args };
}

/** Throws if the command policy would refuse this command. Used to reject a plan before any task runs. */
export function assertCommandAllowed(command: string, policy: CommandPolicy): void {
  parseCommand(command, policy);
}

export function runCommand(command: string, cwd: string, policy: CommandPolicy): Promise<CommandResult> {
  const { file, args } = parseCommand(command, policy);
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env: commandEnv(policy), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const append = (target: string, chunk: Buffer): string => {
      const remaining = policy.outputLimitBytes - Buffer.byteLength(target);
      if (remaining <= 0) return target;
      if (chunk.length <= remaining) return target + chunk.toString("utf8");
      return target + chunk.subarray(0, remaining).toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, policy.timeoutMs);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: timedOut ? 124 : (code ?? 1), stdout, stderr, timedOut });
    });
  });
}

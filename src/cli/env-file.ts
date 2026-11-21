import { chmodSync, existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parse a small .env file: KEY=VALUE lines, comments, optional surrounding quotes. No expansion. */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    if (!KEY.test(key)) continue;
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

/** Load .swarm/.env into process.env without overriding variables already set by the shell. */
export function loadEnvFile(filename: string): void {
  if (!existsSync(filename)) return;
  for (const [key, value] of Object.entries(parseEnvFile(readFileSync(filename, "utf8")))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function keyOf(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;
  const index = trimmed.indexOf("=");
  if (index <= 0) return undefined;
  const key = trimmed.slice(0, index).trim();
  return KEY.test(key) ? key : undefined;
}

async function writeEnvFile(filename: string, name: string, value: string | null): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  const text = await readFile(filename, "utf8").catch(() => "");
  const lines = text.split(/\r?\n/).filter((line) => keyOf(line) !== name);
  if (value !== null) lines.push(`${name}=${value}`);
  const body = lines.join("\n").replace(/\n+$/, "");
  await writeFile(filename, `${body ? `${body}\n` : ""}`, { mode: 0o600 });
  try {
    chmodSync(filename, 0o600);
  } catch {
    // Windows and some filesystems do not support POSIX permissions.
  }
}

export async function setEnvValue(filename: string, name: string, value: string): Promise<void> {
  if (!KEY.test(name)) throw new Error(`invalid environment variable name: ${name}`);
  if (!value) throw new Error("value must not be empty");
  if (/[\r\n]/.test(value)) throw new Error("value must be a single line");
  await writeEnvFile(filename, name, value);
}

export async function removeEnvValue(filename: string, name: string): Promise<void> {
  if (!KEY.test(name)) throw new Error(`invalid environment variable name: ${name}`);
  await writeEnvFile(filename, name, null);
}

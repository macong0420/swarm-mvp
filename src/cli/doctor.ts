import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { SwarmConfig } from "../schema/config.js";
import { gitCommand } from "../worker/worktree.js";

export interface DoctorCheck {
  name: string;
  level: "ok" | "warn" | "error";
  detail: string;
}

function commandExists(file: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [file], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Preflight checks that do not call a model. */
export function doctor(repoRoot: string, config: SwarmConfig | null, configError: string | null): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({ name: "node", level: nodeMajor >= 20 ? "ok" : "error", detail: `${process.version} (need >=20)` });
  checks.push({ name: "git", level: commandExists("git") ? "ok" : "error", detail: "required for worktrees" });
  if (process.platform === "win32") checks.push({ name: "platform", level: "warn", detail: "Windows is experimental; WSL2 or Docker is recommended" });
  try {
    gitCommand(repoRoot, ["rev-parse", "--verify", "HEAD"]);
    checks.push({ name: "git HEAD", level: "ok", detail: "repository has a commit" });
  } catch {
    checks.push({ name: "git HEAD", level: "error", detail: "repository has no commit" });
  }
  if (configError) checks.push({ name: "config", level: "error", detail: configError });
  if (config) {
    const roles = [
      { name: "planner", settings: config.planner },
      { name: "worker", settings: config.worker },
      { name: "integration", settings: config.integration },
    ] as const;
    for (const { name, settings } of roles) {
      const optional = name === "integration";
      const model = settings.model ?? "";
      const baseURL = settings.baseURL ?? "";
      const keyEnv = settings.apiKeyEnv ?? "";
      checks.push({ name: `${name}.model`, level: model || optional ? "ok" : "error", detail: model || (optional ? "planner default" : "not set") });
      checks.push({ name: `${name}.baseURL`, level: baseURL || optional ? "ok" : "error", detail: baseURL || (optional ? "planner default" : "not set") });
      checks.push({
        name: `${name}.apiKeyEnv`,
        level: keyEnv ? (process.env[keyEnv] ? "ok" : "error") : (optional ? "ok" : "error"),
        detail: keyEnv ? `${keyEnv} ${process.env[keyEnv] ? "set" : "missing"}` : (optional ? "planner default" : "not set"),
      });
    }
    const models = [...new Set([
      config.planner.model,
      config.worker.model,
      config.integration.model ?? config.planner.model,
      ...Object.values(config.worker.routes).map((route) => route.model).filter((model): model is string => Boolean(model)),
    ])].filter(Boolean);
    const unpriced = models.filter((model) => !config.pricing[model]);
    checks.push({ name: "pricing", level: unpriced.length ? "warn" : "ok", detail: unpriced.length ? `no price for ${unpriced.join(", ")}` : "all configured models priced" });
    const hasModules = existsSync(path.join(repoRoot, "node_modules"));
    checks.push({
      name: "node_modules",
      level: hasModules ? "ok" : "warn",
      detail: hasModules
        ? (config.worktree.linkNodeModules ? "present; linked into worktrees" : "present; not linked (set worktree.linkNodeModules)")
        : "missing; install dependencies first",
    });
    for (const file of config.commandPolicy.allow) {
      checks.push({ name: `command:${file}`, level: commandExists(file) ? "ok" : "warn", detail: file });
    }
  }
  return checks;
}

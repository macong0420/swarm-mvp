import type { ModelClient, ModelMessage, ModelToolCall } from "../models/client.js";
import type { SwarmConfig, WorkerProfile } from "../schema/config.js";
import type { Task } from "../schema/plan.js";
import type { EventStore } from "../store/events.js";
import { runCommand } from "./commands.js";
import type { CommandPolicy } from "./commands.js";
import { deleteWorktreeFile, editWorktreeFile, isPathInScope, listWorktreeDir, readWorktreeFile, writeWorktreeFile } from "./paths.js";

const toolDefinitions: Array<Record<string, unknown>> = [
  { name: "read_file", description: "Read a UTF-8 file inside the worktree. For large files pass startLine and maxLines.", input_schema: { type: "object", properties: { path: { type: "string" }, startLine: { type: "number" }, maxLines: { type: "number" } }, required: ["path"] } },
  { name: "edit_file", description: "Change part of an existing file: replace the one place that contains old text with new text. Prefer this over write_file; old must match the file exactly and appear once.", input_schema: { type: "object", properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } }, required: ["path", "old", "new"] } },
  { name: "write_file", description: "Create a file, or replace a whole file, inside writeScope", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "delete_file", description: "Delete a regular file inside writeScope", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "list_dir", description: "List a directory inside the worktree", input_schema: { type: "object", properties: { path: { type: "string" } } } },
  { name: "run_command", description: "Run one allowlisted command in the worktree without a shell", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "finish", description: "Finish implementation and start acceptance checks", input_schema: { type: "object", properties: {} } },
];

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function argumentSummary(call: ModelToolCall): Record<string, unknown> {
  const summary: Record<string, unknown> = { keys: Object.keys(call.arguments) };
  if (typeof call.arguments.path === "string") summary.path = call.arguments.path.slice(0, 300);
  if (typeof call.arguments.command === "string") summary.commandLength = call.arguments.command.length;
  if (typeof call.arguments.content === "string") summary.contentBytes = Buffer.byteLength(call.arguments.content);
  if (typeof call.arguments.old === "string") summary.oldBytes = Buffer.byteLength(call.arguments.old);
  return summary;
}

function resultSummary(name: string, value: unknown): unknown {
  if (name === "read_file" && typeof value === "string") return { bytes: Buffer.byteLength(value) };
  if (name === "list_dir" && Array.isArray(value)) return { entries: value.length };
  if (name === "run_command" && typeof value === "object" && value !== null) {
    const result = value as { exitCode?: number; timedOut?: boolean; stdout?: string; stderr?: string };
    return { exitCode: result.exitCode, timedOut: result.timedOut, outputBytes: Buffer.byteLength(`${result.stdout ?? ""}${result.stderr ?? ""}`) };
  }
  return value;
}

function summarize(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 1000 ? `${text.slice(0, 1000)}...` : text;
}

/** Shorten older outputs when the conversation grows past maxChars; tool_call/tool_result pairing stays intact. */
function compactMessages(messages: ModelMessage[], maxChars: number): void {
  if (maxChars <= 0 || JSON.stringify(messages).length <= maxChars) return;
  const keepHead = 2;
  const keepTail = 8;
  for (let index = keepHead; index < messages.length - keepTail; index++) {
    const message = messages[index]!;
    if (message.role === "tool") message.content = "[older tool output omitted]";
    else if (message.role === "user") message.content = "[older message omitted]";
    else if (message.role === "assistant" && message.content.length > 200) message.content = `${message.content.slice(0, 200)}...`;
  }
}

export interface AcceptanceResult {
  command: string;
  exitCode: number;
  timedOut: boolean;
  output: string;
}

/** Runs acceptance commands in order and returns one result per command. */
export async function runAcceptance(commands: string[], cwd: string, policy: CommandPolicy, log: (payload: Record<string, unknown>) => void): Promise<AcceptanceResult[]> {
  const results: AcceptanceResult[] = [];
  for (const command of commands) {
    const result = await runCommand(command, cwd, policy);
    const output = `${result.stdout}${result.stderr}`;
    log({ command, exitCode: result.exitCode, timedOut: result.timedOut, outputSummary: summarize(output) });
    results.push({ command, exitCode: result.exitCode, timedOut: result.timedOut, output });
  }
  return results;
}

export async function runWorker(params: {
  client: ModelClient;
  task: Task;
  worktreePath: string;
  config: SwarmConfig;
  /** The route for this task's kind; absent in direct unit tests, then the global task budgets apply. */
  profile?: WorkerProfile;
  /** Project conventions shown to the worker (AGENTS.md/CLAUDE.md/README.md). */
  context?: string;
  events: EventStore;
  runId: string;
  attemptId: string;
  attempt: number;
  modelName?: string;
  phase?: string;
  previousFailure?: string;
}): Promise<void> {
  const maxTurns = params.profile?.maxTurns ?? params.config.task.maxTurns;
  const maxTokens = params.profile?.maxTokens ?? params.config.task.maxTokens;
  const maxContextChars = params.config.task.maxContextChars;
  const messages: ModelMessage[] = [
    { role: "system", content: [
      "Implement only the task. Use tools for file access and commands. Call finish when ready for acceptance. Do not claim success without finish.",
      "Paths are relative to the repository root and writes are refused outside writeScope. Read a file before changing it. Change existing files with edit_file (one unique old text, exact match); use write_file only for new files or a deliberate full rewrite; delete files with delete_file. For large files read a range with startLine and maxLines. Never satisfy a lint rule with a blanket disable such as /* eslint-disable */; if a suppression is unavoidable, name the rule.",
      `run_command takes plain argv text: quotes group one argument; no shell syntax, pipes or redirects. Allowed executables: ${params.config.commandPolicy.allow.join(", ")}.`,
      ...(params.context ? [`Project conventions (read-only, follow them):\n${params.context}`] : []),
    ].join("\n") },
    { role: "user", content: JSON.stringify({ task: params.task, writeScope: params.task.writeScope, acceptance: params.task.acceptance, ...(params.previousFailure ? { previousAttemptFailure: params.previousFailure } : {}) }) },
  ];
  let tokens = 0;
  let lastFailure = "";

  for (let turn = 1; turn <= maxTurns; turn++) {
    compactMessages(messages, maxContextChars);
    const started = Date.now();
    const response = await params.client.chat({ messages, tools: toolDefinitions });
    tokens += response.usage.inputTokens + response.usage.outputTokens;
    params.events.append({
      runId: params.runId,
      taskId: params.task.id,
      attempt: params.attempt,
      type: "model_call",
      payload: { phase: params.phase ?? "worker", model: params.modelName ?? "unknown", turn, attemptId: params.attemptId, elapsedMs: Date.now() - started, usage: response.usage },
    });
    if (tokens > maxTokens) throw new Error(`task token budget exceeded (${tokens} > ${maxTokens})${lastFailure ? `; last acceptance failure: ${lastFailure}` : ""}`);
    messages.push({ role: "assistant", content: response.message.content, toolCalls: response.toolCalls, ...(response.message.raw !== undefined ? { raw: response.message.raw } : {}) });

    let finished = false;
    for (const call of response.toolCalls) {
      // Every tool call needs a result in the conversation, including finish and anything requested after it.
      if (finished) {
        messages.push({ role: "tool", toolCallId: call.id, content: "Skipped: finish was already called in this turn." });
        continue;
      }
      if (call.name === "finish") {
        params.events.append({
          runId: params.runId,
          taskId: params.task.id,
          attempt: params.attempt,
          type: "tool_call",
          payload: { tool: call.name, arguments: argumentSummary(call), resultSummary: { accepted: true }, attemptId: params.attemptId },
        });
        messages.push({ role: "tool", toolCallId: call.id, content: "Acceptance commands are running." });
        finished = true;
        continue;
      }

      let result: unknown;
      try {
        result = await executeTool(call, params);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result = { error: message };
        if (call.name === "write_file" && message.includes("writeScope")) {
          params.events.append({
            runId: params.runId,
            taskId: params.task.id,
            attempt: params.attempt,
            type: "scope_violation",
            payload: { path: typeof call.arguments.path === "string" ? call.arguments.path : "", reason: message, attemptId: params.attemptId },
          });
        }
      }
      params.events.append({
        runId: params.runId,
        taskId: params.task.id,
        attempt: params.attempt,
        type: "tool_call",
        payload: { tool: call.name, arguments: argumentSummary(call), resultSummary: resultSummary(call.name, result), attemptId: params.attemptId },
      });
      messages.push({ role: "tool", toolCallId: call.id, content: summarize(result) });
    }

    if (!finished) {
      if (!response.toolCalls.length) messages.push({ role: "user", content: "Use a tool or call finish when ready." });
      continue;
    }

    const results = await runAcceptance(params.task.acceptance.commands, params.worktreePath, params.config.commandPolicy, (payload) => {
      params.events.append({ runId: params.runId, taskId: params.task.id, attempt: params.attempt, type: "acceptance_run", payload: { ...payload, attemptId: params.attemptId } });
    });
    const failures = results.filter((result) => result.exitCode !== 0).map((result) => `${result.command} exited ${result.exitCode}: ${result.output}`);
    if (!failures.length) return;
    lastFailure = summarize(failures.join("\n"));
    messages.push({ role: "user", content: `Acceptance failed. Fix the issues and call finish again:\n${failures.join("\n")}` });
  }
  throw new Error(`worker exceeded maxTurns (${maxTurns})${lastFailure ? `; last acceptance failure: ${lastFailure}` : ""}`);
}

async function executeTool(call: ModelToolCall, params: {
  task: Task;
  worktreePath: string;
  config: SwarmConfig;
}): Promise<unknown> {
  switch (call.name) {
    case "read_file": {
      const maxLines = typeof call.arguments.maxLines === "number" ? Math.min(call.arguments.maxLines, params.config.worker.maxReadLines) : params.config.worker.maxReadLines;
      return readWorktreeFile(params.worktreePath, stringArg(call.arguments, "path"), { ...(typeof call.arguments.startLine === "number" ? { startLine: call.arguments.startLine } : {}), maxLines });
    }
    case "edit_file":
      return editWorktreeFile(
        params.worktreePath,
        stringArg(call.arguments, "path"),
        stringArg(call.arguments, "old"),
        stringArg(call.arguments, "new"),
        params.task.writeScope,
      );
    case "write_file":
      await writeWorktreeFile(
        params.worktreePath,
        stringArg(call.arguments, "path"),
        stringArg(call.arguments, "content"),
        params.task.writeScope,
      );
      return { written: true };
    case "delete_file":
      await deleteWorktreeFile(params.worktreePath, stringArg(call.arguments, "path"), params.task.writeScope);
      return { deleted: true };
    case "list_dir":
      return listWorktreeDir(params.worktreePath, typeof call.arguments.path === "string" ? call.arguments.path : ".");
    case "run_command":
      return runCommand(stringArg(call.arguments, "command"), params.worktreePath, params.config.commandPolicy);
    default:
      throw new Error(`unknown tool: ${call.name}`);
  }
}

export function taskChangesInScope(files: string[], writeScope: string[]): string[] {
  return files.filter((file) => !isPathInScope(file, writeScope));
}

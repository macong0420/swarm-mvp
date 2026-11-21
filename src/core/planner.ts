import { z } from "zod";
import type { ChatResult, ModelClient, ModelMessage } from "../models/client.js";
import { plannerToolDefinitions } from "./repo.js";
import type { EventInput } from "../store/events.js";
import type { Plan } from "../schema/plan.js";
import { pathMatchesScope, planSchema, splitTask, taskKinds, taskSchema, transitiveDeps, validatePlan } from "../schema/plan.js";
import { assertCommandAllowed, tokenizeCommand } from "../worker/commands.js";
import type { CommandPolicy } from "../worker/commands.js";

export interface PlannerCtx {
  client: ModelClient;
  modelName: string;
  emit(event: Omit<EventInput, "runId">): void;
  limits: { maxFiles: number; maxLines: number };
  maxPlanRetries: number;
  commandPolicy: CommandPolicy;
  /** Worker models the planner may name in a retry_with escalation. */
  workerModels: string[];
  /** Whether a repository-relative file exists at the run's base commit. */
  fileExists(file: string): boolean;
  /** What the planner may see and read of the repository. */
  repo: {
    baseSha: string;
    map: string;
    maxToolTurns: number;
    runTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  };
}

const decisionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("split"), reason: z.string().default(""), tasks: z.array(taskSchema).min(1) }),
  z.object({ action: z.literal("implement"), reason: z.string().default("") }),
  z.object({ action: z.literal("retry_with"), reason: z.string().default(""), model: z.string().min(1).optional(), reasoningEffort: z.string().optional() }),
  z.object({ action: z.literal("abandon"), reason: z.string().min(1) }),
]);

export type EscalationDecision =
  | { action: "split"; reason: string; plan: Plan; subtasks: string[] }
  | { action: "retry_with"; reason: string; model?: string | undefined; reasoningEffort?: string | undefined }
  | { action: "implement" | "abandon"; reason: string };

const taskRules = (p: PlannerCtx): string => `Task rules:
- A title states one goal and never joins two goals with "and".
- kind is one of ${taskKinds.join(", ")}; the runtime routes each kind to its own worker model and budget.
- description says what to do and, explicitly, what NOT to do.
- writeScope lists the files or globs the task may modify. Tasks with no dependency path between them must have disjoint writeScope.
- readContext lists read-only files the worker should look at.
- Every task needs at least one acceptance command; exit code 0 means pass. Commands are plain argv text split on spaces and run without a shell: quotes group one argument, but there are no pipes, redirects or semicolons and nothing is expanded. Prefer repository test files over inline code such as "node -e ...". Allowed executables: ${p.commandPolicy.allow.join(", ")}.
- Acceptance must cover the repository's real quality gates: when package.json has lint or type-check scripts, include a lint/typecheck check that covers the changed files (for example "pnpm exec eslint <file>" or the repository's script). Prefer the test runner already installed in the repository; node:test is acceptable only when there is none.
- Never satisfy a lint rule with a blanket disable such as /* eslint-disable */; if a suppression is unavoidable, name the rule.
- An acceptance command can only use files that already exist in the repository, that the task itself writes, or that its dependencies write. A test file written by a later task does not exist yet. So either write the implementation and its test in one task, or give an implementation-only task a check it can pass alone, such as "node --check src/file.js".
- estimate must stay within files <= ${p.limits.maxFiles} and lines <= ${p.limits.maxLines}.`;

const repoSection = (p: PlannerCtx): string => `
Repository at the run's base commit ${p.repo.baseSha}. Paths are repository-relative:
${p.repo.map}

You may inspect the repository before answering with the read-only tools list_dir, read_file and search. Read a file when the file list does not tell you what a task must touch; then answer.`;

const planningPrompt = (p: PlannerCtx): string => `You are the planner of a multi-agent coding system. Split the user's request into a dependency graph of small tasks that cheap, fast worker models execute in parallel, each in its own git worktree.
Return exactly one JSON object matching the Plan schema. No markdown fences, no commentary.

How to split:
- Cut along seams: by module or directory; define interfaces (types, function signatures) first, then implement in parallel; keep implementation, tests and docs in separate tasks; for batches of similar work use one task per file.
- Do not cut inside a single function, through tightly coupled logic, or through the overall design of a core data model. Keep such work in one task.
- Each task should be finishable by a cheap model in about 5-20 minutes and a few dozen turns, touching 1-5 files.
- If tasks share an interface, make "define the interface/types" its own task and let the others depend on it.

${taskRules(p)}
${repoSection(p)}

Plan schema: ${JSON.stringify(z.toJSONSchema(planSchema))}`;

const escalationPrompt = (p: PlannerCtx): string => `You are the planner of a multi-agent coding system. A worker failed the task below more often than allowed. Decide what happens next and return exactly one JSON object matching the Decision schema. No markdown fences, no commentary.
- "split": replace the task with smaller or corrected tasks. They inherit its dependencies, and everything that depended on it waits for all of them. Use ids that are not in existingTaskIds.
- "implement": you implement the task yourself next, with the same file and command tools the worker had.
- "retry_with": retry the task once with a different worker model or effort, for example when the task looks solvable but the current model was too weak. Set model (and optionally reasoningEffort); omit model to keep the current route.
- "abandon": give up on the task and say why. Tasks depending on it are blocked.

Available worker models: ${p.workerModels.length ? p.workerModels.join(", ") : "(the configured worker model only)"}

${taskRules(p)}
${repoSection(p)}

Decision schema: ${JSON.stringify(z.toJSONSchema(decisionSchema))}`;

/** Plan validation plus the command policy: an acceptance command the policy refuses could never pass. */
export function validatePlanForRun(raw: unknown, p: PlannerCtx): Plan {
  const plan = validatePlan(raw, p.limits);
  const check = (command: string, where: string): void => {
    try {
      assertCommandAllowed(command, p.commandPolicy);
    } catch (error) {
      throw new Error(`acceptance command of ${where} cannot run: \`${command}\` (${reasonOf(error)})`);
    }
  };
  // shortcut: only arguments that look like a file (have an extension) are checked, so a missing
  // directory or extension-less script still slips through; parse per-tool arguments if that bites.
  const files = (command: string): string[] => tokenizeCommand(command).slice(1).filter((argument) => !argument.startsWith("-") && /\.[A-Za-z0-9]+$/.test(argument));
  const reachable = (file: string, scopes: string[]): boolean => pathMatchesScope(file.replace(/^\.\//, ""), scopes) || p.fileExists(file.replace(/^\.\//, ""));
  for (const task of plan.tasks) {
    const scopes = [task, ...transitiveDeps(plan.tasks, task.id)].flatMap((entry) => entry.writeScope);
    for (const command of task.acceptance.commands) {
      check(command, `task ${task.id}`);
      const missing = files(command).find((file) => !reachable(file, scopes));
      if (missing) throw new Error(`acceptance command of task ${task.id} uses ${missing}, which does not exist in the repository and is not in the writeScope of ${task.id} or of its dependencies`);
    }
  }
  const allScopes = plan.tasks.flatMap((task) => task.writeScope);
  for (const command of plan.globalAcceptance) {
    check(command, "globalAcceptance");
    const missing = files(command).find((file) => !reachable(file, allScopes));
    if (missing) throw new Error(`globalAcceptance uses ${missing}, which does not exist in the repository and is not in any task's writeScope`);
  }
  return plan;
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 2000);
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}...` : text);
const asText = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));

/** One planner call. Model errors propagate to the caller; only the reply's content can be rejected and retried. */
async function ask(p: PlannerCtx, phase: string, messages: ModelMessage[], schema: z.ZodType, tools: boolean): Promise<ChatResult> {
  const started = Date.now();
  const response = await p.client.chat({ messages, ...(tools ? { tools: plannerToolDefinitions } : {}), responseSchema: { name: phase, schema: z.toJSONSchema(schema) } });
  p.emit({ type: "model_call", payload: { phase, model: p.modelName, elapsedMs: Date.now() - started, usage: response.usage } });
  messages.push({ role: "assistant", content: response.message.content, toolCalls: response.toolCalls, ...(response.message.raw !== undefined ? { raw: response.message.raw } : {}) });
  return response;
}

/** Answer with JSON, letting the planner inspect the repository first. Every tool result is fed back before the next call. */
async function askJson(p: PlannerCtx, phase: string, messages: ModelMessage[], schema: z.ZodType, tools: boolean): Promise<string> {
  // Models sometimes wrap the object in a code fence or a sentence; keep only the outermost JSON object.
  const jsonOf = (content: string): string => content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1) || content;
  for (let turn = 0; turn <= p.repo.maxToolTurns; turn++) {
    const response = await ask(p, phase, messages, schema, tools);
    if (!response.toolCalls.length) return jsonOf(response.message.content);
    if (turn === p.repo.maxToolTurns) break;
    for (const call of response.toolCalls) {
      let result: unknown;
      try { result = await p.repo.runTool(call.name, call.arguments); }
      catch (error) { result = { error: reasonOf(error) }; }
      const text = asText(result);
      p.emit({ type: "tool_call", payload: {
        phase,
        tool: call.name,
        arguments: { ...(typeof call.arguments.path === "string" ? { path: call.arguments.path } : {}), ...(typeof call.arguments.pattern === "string" ? { pattern: call.arguments.pattern.slice(0, 120) } : {}) },
        resultSummary: clip(text, 500),
      } });
      messages.push({ role: "tool", toolCallId: call.id, content: clip(text, 8000) });
    }
  }
  messages.push({ role: "user", content: "Stop inspecting the repository. Return the JSON object now, without tool calls." });
  const final = await ask(p, phase, messages, schema, tools);
  if (final.toolCalls.length) throw new Error("planner kept inspecting the repository instead of returning JSON");
  return jsonOf(final.message.content);
}

/** Ask for a plan and validate it with ordinary code; a rejected plan goes back to the planner up to maxPlanRetries times. */
export async function createPlan(p: PlannerCtx, request: string): Promise<Plan> {
  const messages: ModelMessage[] = [{ role: "system", content: planningPrompt(p) }, { role: "user", content: request }];
  let reason = "";
  for (let round = 0; round <= p.maxPlanRetries; round++) {
    const content = await askJson(p, "planning", messages, planSchema, true);
    try {
      const raw = JSON.parse(content) as unknown;
      p.emit({ type: "plan_proposed", payload: { plan: raw } });
      const plan = validatePlanForRun(raw, p);
      p.emit({ type: "plan_accepted", payload: { plan } });
      return plan;
    } catch (error) {
      reason = reasonOf(error);
      p.emit({ type: "plan_rejected", payload: { reason } });
      messages.push({ role: "user", content: `Plan rejected: ${reason}\nReturn a corrected, complete Plan JSON.` });
    }
  }
  throw new Error(`no valid plan after ${p.maxPlanRetries + 1} attempts: ${reason}`);
}

/** Failure escalation for one task. A split is rewritten into the full plan and validated like any other plan. */
export async function decideEscalation(p: PlannerCtx, input: { plan: Plan; taskId: string; failures: unknown[]; usedIds: Set<string> }): Promise<EscalationDecision> {
  const task = input.plan.tasks.find((candidate) => candidate.id === input.taskId);
  const messages: ModelMessage[] = [
    { role: "system", content: escalationPrompt(p) },
    { role: "user", content: JSON.stringify({ goal: input.plan.goal, task, failures: input.failures, existingTaskIds: [...input.usedIds] }) },
  ];
  let reason = "";
  for (let round = 0; round <= p.maxPlanRetries; round++) {
    const content = await askJson(p, "escalation", messages, decisionSchema, true);
    try {
      const decision = decisionSchema.parse(JSON.parse(content) as unknown);
      if (decision.action !== "split") return decision;
      const clash = decision.tasks.find((subtask) => input.usedIds.has(subtask.id));
      if (clash) throw new Error(`task id already used in this run: ${clash.id}`);
      const plan = validatePlanForRun(splitTask(input.plan, input.taskId, decision.tasks), p);
      return { action: "split", reason: decision.reason, plan, subtasks: decision.tasks.map((subtask) => subtask.id) };
    } catch (error) {
      reason = reasonOf(error);
      p.emit({ taskId: input.taskId, type: "plan_rejected", payload: { phase: "escalation", reason } });
      messages.push({ role: "user", content: `Decision rejected: ${reason}\nReturn a corrected Decision JSON.` });
    }
  }
  return { action: "abandon", reason: `no valid escalation decision after ${p.maxPlanRetries + 1} attempts: ${reason}` };
}

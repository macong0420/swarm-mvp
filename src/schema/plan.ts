import picomatch from "picomatch";
import { z } from "zod";

/** Task kinds the planner may use; each may be routed to its own worker model and budget. */
export const taskKinds = ["implement", "test", "refactor", "docs", "investigate"] as const;

export const taskSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  kind: z.enum(taskKinds).default("implement"),
  title: z.string().trim().min(1),
  description: z.string().min(1),
  writeScope: z.array(z.string().min(1)).min(1),
  readContext: z.array(z.string()),
  dependsOn: z.array(z.string()),
  acceptance: z.object({
    commands: z.array(z.string().min(1)).min(1),
    notes: z.string().optional(),
  }),
  estimate: z.object({
    files: z.number().int().nonnegative(),
    lines: z.number().int().nonnegative(),
  }),
});

export const planSchema = z.object({
  goal: z.string().min(1),
  globalAcceptance: z.array(z.string()),
  tasks: z.array(taskSchema).min(1),
});

export type Task = z.infer<typeof taskSchema>;
export type Plan = z.infer<typeof planSchema>;

function staticPrefix(glob: string): string {
  const parts = glob.replaceAll("\\", "/").split("/");
  const prefix: string[] = [];
  for (const part of parts) {
    if (/[*!?{[\]]/.test(part)) break;
    prefix.push(part);
  }
  return prefix.join("/");
}

function prefixesMayOverlap(left: string, right: string): boolean {
  if (!left || !right) return true;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function scopesOverlap(left: string[], right: string[]): boolean {
  return left.some((a) => right.some((b) => prefixesMayOverlap(staticPrefix(a), staticPrefix(b))));
}

function isAncestor(ancestor: string, taskId: string, tasks: Map<string, Task>, seen = new Set<string>()): boolean {
  if (seen.has(taskId)) return false;
  seen.add(taskId);
  const task = tasks.get(taskId);
  if (!task) return false;
  return task.dependsOn.some((dependency) => dependency === ancestor || isAncestor(ancestor, dependency, tasks, seen));
}

export function validatePlan(input: unknown, limits: { maxFiles: number; maxLines: number }): Plan {
  const plan = planSchema.parse(input);
  const tasks = new Map<string, Task>();

  for (const task of plan.tasks) {
    if (tasks.has(task.id)) throw new Error(`duplicate task id: ${task.id}`);
    if (/\band\b|并且/i.test(task.title)) throw new Error(`task title must describe one goal, not join two with "and"/"并且": "${task.title}"`);
    for (const scope of task.writeScope) {
      if (scope.startsWith("/") || scope.split(/[\\/]/).includes("..")) {
        throw new Error(`unsafe writeScope path in ${task.id}: ${scope}`);
      }
    }
    if (task.estimate.files > limits.maxFiles || task.estimate.lines > limits.maxLines) {
      throw new Error(`task estimate exceeds configured limit: ${task.id}`);
    }
    tasks.set(task.id, task);
  }

  for (const task of plan.tasks) {
    for (const dependency of task.dependsOn) {
      if (!tasks.has(dependency)) throw new Error(`unknown dependency ${dependency} in ${task.id}`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(taskId: string): void {
    if (visiting.has(taskId)) throw new Error(`dependency cycle includes ${taskId}`);
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dependency of tasks.get(taskId)?.dependsOn ?? []) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  }
  for (const task of plan.tasks) visit(task.id);

  for (let i = 0; i < plan.tasks.length; i++) {
    const left = plan.tasks[i]!;
    for (const right of plan.tasks.slice(i + 1)) {
      if (isAncestor(left.id, right.id, tasks) || isAncestor(right.id, left.id, tasks)) continue;
      if (scopesOverlap(left.writeScope, right.writeScope)) {
        throw new Error(`parallel writeScope overlap: ${left.id} and ${right.id}`);
      }
    }
  }
  return plan;
}

export function pathMatchesScope(relativePath: string, scopes: string[]): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  return scopes.some((scope) => {
    const pattern = scope.replaceAll("\\", "/").replace(/\/$/, "");
    return picomatch(pattern)(normalized) || (!/[*!?{[\]]/.test(pattern) && normalized.startsWith(`${pattern}/`));
  });
}

/** Dependencies first. Assumes a validated (acyclic, closed) task list. */
export function topoOrder(tasks: Task[]): Task[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const ordered: Task[] = [];
  const seen = new Set<string>();
  const visit = (task: Task): void => {
    if (seen.has(task.id)) return;
    seen.add(task.id);
    for (const dependency of task.dependsOn) visit(byId.get(dependency)!);
    ordered.push(task);
  };
  tasks.forEach(visit);
  return ordered;
}

/** All direct and indirect dependencies of a task, dependencies first. */
export function transitiveDeps(tasks: Task[], taskId: string): Task[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return topoOrder(tasks).filter((task) => task.id !== taskId && isAncestor(task.id, taskId, byId));
}

/** Replace one task by subtasks: they inherit its dependencies, and its dependents now wait for all of them. */
export function splitTask(plan: Plan, replacedId: string, subtasks: Task[]): Plan {
  const original = plan.tasks.find((task) => task.id === replacedId);
  if (!original) throw new Error(`unknown task: ${replacedId}`);
  const ids = subtasks.map((task) => task.id);
  const union = (...lists: string[][]): string[] => [...new Set(lists.flat())];
  return {
    ...plan,
    tasks: [
      ...plan.tasks.filter((task) => task.id !== replacedId).map((task) => task.dependsOn.includes(replacedId)
        ? { ...task, dependsOn: union(task.dependsOn.filter((dependency) => dependency !== replacedId), ids) }
        : task),
      ...subtasks.map((task) => ({ ...task, dependsOn: union(task.dependsOn, original.dependsOn) })),
    ],
  };
}

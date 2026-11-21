import { execFileSync } from "node:child_process";
import { mkdir, symlink } from "node:fs/promises";
import { existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function findRepoRoot(cwd: string): string {
  return git(cwd, ["rev-parse", "--show-toplevel"]);
}

export function getBaseSha(repoRoot: string): string {
  return git(repoRoot, ["rev-parse", "--verify", "HEAD"]);
}

/** Whether the working tree differs from HEAD, ignoring the tool's own .swarm directory. */
export function workingTreeDirty(repoRoot: string): boolean {
  return git(repoRoot, ["status", "--porcelain", "--untracked-files=all"]).split("\n").filter((line) => line && !line.slice(3).startsWith(".swarm/")).length > 0;
}

/**
 * Freeze the working tree, uncommitted changes included, as a commit without touching HEAD, the index
 * or the files: a temporary index records every file, which becomes a commit on top of HEAD. The
 * commit is kept alive by refs/swarm/<runId>/base so a resumed run can still reach it.
 */
export function snapshotWorkingTree(repoRoot: string, runId: string): string {
  const index = path.join(os.tmpdir(), `swarm-index-${process.pid}-${Date.now()}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const run = (args: string[]): string => {
    try { return execFileSync("git", args, { cwd: repoRoot, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) {
      const stderr = String((error as { stderr?: Buffer | string }).stderr ?? "").trim();
      throw new Error(`git ${args.join(" ")} failed: ${stderr || (error as Error).message}`);
    }
  };
  try {
    // Start from HEAD so tracked files stay tracked even when a global or repository ignore rule matches
    // them: with an empty temporary index `git add -A` treats them as untracked and skips them.
    run(["read-tree", "HEAD"]);
    // Store working-tree bytes as they are: core.autocrlf=input would normalize CRLF on add and make the
    // snapshot differ from HEAD for files the user never touched.
    run(["-c", "core.autocrlf=false", "add", "-A", "--", "."]);
    // .swarm belongs to this machine, never to the snapshot.
    run(["rm", "-r", "--cached", "--ignore-unmatch", "--quiet", "--", ".swarm"]);
    const tree = run(["write-tree"]).trim();
    const commit = execFileSync("git", [...GIT_IDENTITY, "commit-tree", tree, "-p", getBaseSha(repoRoot), "-m", "swarm: working tree snapshot"], { cwd: repoRoot, encoding: "utf8" }).trim();
    // Defense in depth: a tracked file that is still in the working tree must never disappear from the
    // snapshot (the empty-index + ignore-rule bug did exactly that).
    const dropped = git(repoRoot, ["diff", "--name-only", "--diff-filter=D", "HEAD", commit]).split("\n").filter(Boolean)
      .filter((file) => existsSync(path.join(repoRoot, file)));
    if (dropped.length) throw new Error(`working tree snapshot dropped tracked files: ${dropped.slice(0, 10).join(", ")}`);
    git(repoRoot, ["update-ref", `refs/swarm/${runId}/base`, commit]);
    return commit;
  } finally {
    rmSync(index, { force: true });
    rmSync(`${index}.lock`, { force: true });
  }
}

/** What the frozen working-tree commit changes relative to HEAD, so a run can show what dirty state it started from. */
export function snapshotDiff(repoRoot: string, sha: string): { changed: string[]; deleted: string[] } {
  const lines = git(repoRoot, ["diff", "--name-status", "--no-renames", "HEAD", sha]).split("\n").filter(Boolean);
  const entries = lines.map((line) => {
    const [status, ...rest] = line.split("\t");
    return { status: status ?? "", file: rest.join("\t") };
  });
  return {
    changed: entries.filter((entry) => entry.status !== "D").map((entry) => entry.file),
    deleted: entries.filter((entry) => entry.status === "D").map((entry) => entry.file),
  };
}

/** Commits made by the tool: fixed identity, never signed (signing could prompt or fail unattended). */
export const GIT_IDENTITY = ["-c", "user.name=Swarm", "-c", "user.email=swarm@localhost", "-c", "commit.gpgsign=false"];

export function worktreeRoot(repoRoot: string): string {
  return path.resolve(repoRoot, git(repoRoot, ["rev-parse", "--git-common-dir"]), "swarm", "worktrees");
}

/** Linters and test runners need the repository's installed dependencies, which a fresh worktree lacks. */
export async function linkNodeModules(repoRoot: string, worktreePath: string): Promise<void> {
  const modules = path.join(repoRoot, "node_modules");
  if (!existsSync(modules) || existsSync(path.join(worktreePath, "node_modules"))) return;
  try {
    // Only link when node_modules is git-ignored, so the link can never end up in a commit.
    git(repoRoot, ["check-ignore", "-q", "node_modules"]);
    // A junction does not need the Windows developer-mode privilege that a directory symlink does.
    await symlink(modules, path.join(worktreePath, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  } catch {
    // Not ignored (or not linkable): leave the worktree without dependencies rather than risk committing them.
  }
}

export interface RetrySnapshot {
  /** The failed attempt's snapshot branch. */
  branch: string;
  /** The commit the failed attempt started from; out-of-scope files are reset to it. */
  baseSha: string;
  /** Files the failed attempt changed outside its writeScope. */
  paths: string[];
}

/**
 * One isolated worktree and branch per attempt. `mergeBranches` are the passed branches of the task's
 * transitive dependencies in topological order; the returned baseSha is the commit the worker starts from.
 * With `retry`, the attempt starts from the failed snapshot, with its out-of-scope files reset, so the
 * work the worker already did inside its scope is kept.
 */
export async function createTaskWorktree(repoRoot: string, runId: string, taskId: string, baseSha: string, mergeBranches: string[] = [], options: { linkNodeModules?: boolean; retry?: RetrySnapshot } = {}): Promise<{ path: string; branch: string; attemptId: string; baseSha: string }> {
  const attemptId = randomUUID().slice(0, 8);
  const branch = `swarm/${runId}/${taskId}/${attemptId}`;
  const worktreePath = path.join(worktreeRoot(repoRoot), runId, `${taskId}-${attemptId}`);
  const retry = options.retry;
  await mkdir(path.dirname(worktreePath), { recursive: true });
  git(repoRoot, ["worktree", "add", "-b", branch, worktreePath, retry?.branch ?? baseSha]);
  try {
    if (options.linkNodeModules) await linkNodeModules(repoRoot, worktreePath);
    if (retry) {
      for (const file of retry.paths) {
        try {
          git(worktreePath, ["checkout", retry.baseSha, "--", file]);
        } catch {
          try {
            git(worktreePath, ["rm", "--cached", "--ignore-unmatch", "--", file]);
          } catch {
            // Not tracked in either tree.
          }
          rmSync(path.join(worktreePath, file), { force: true });
        }
      }
      // Put the cleaned tree on the attempt's starting commit, so the retry branch does not carry the
      // failed snapshot (with its out-of-scope files) into the integration merge.
      git(worktreePath, ["add", "-A"]);
      const tree = git(worktreePath, ["write-tree"]);
      const commit = execFileSync("git", [...GIT_IDENTITY, "commit-tree", tree, "-p", retry.baseSha, "-m", "swarm: retry from cleaned snapshot"], { cwd: worktreePath, encoding: "utf8" }).trim();
      git(worktreePath, ["reset", "--hard", commit]);
    } else {
      for (const dependency of mergeBranches) git(worktreePath, [...GIT_IDENTITY, "merge", "--no-edit", dependency]);
    }
    return { path: worktreePath, branch, attemptId, baseSha: git(worktreePath, ["rev-parse", "HEAD"]) };
  } catch (error) {
    // No event knows this worktree yet, so cleanup could never find it: remove it here.
    execFileSync("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoRoot, stdio: "ignore" });
    execFileSync("git", ["branch", "-D", branch], { cwd: repoRoot, stdio: "ignore" });
    throw error;
  }
}

/** Tracked changes against baseSha plus untracked files. Git-ignored files can never be committed, so they are not changes. */
export function changedFiles(worktreePath: string, baseSha: string): string[] {
  const diff = execFileSync("git", ["diff", "--name-only", "-z", baseSha], { cwd: worktreePath, encoding: "utf8" });
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: worktreePath, encoding: "utf8" });
  return [...new Set([...diff.split("\0"), ...untracked.split("\0")].filter(Boolean))];
}

/** Keep a failed attempt's work on its own never-merged branch, so a later `recovered` event can diff against it. */
export function snapshotWorktree(worktreePath: string): void {
  git(worktreePath, ["add", "-A"]);
  git(worktreePath, [...GIT_IDENTITY, "commit", "--allow-empty", "-m", "swarm: failed attempt snapshot"]);
}

export function commitTaskChanges(worktreePath: string, taskId: string, files: string[]): void {
  if (!files.length) return;
  execFileSync("git", ["add", "-f", "--", ...files.map((file) => `:(literal)${file}`)], { cwd: worktreePath, stdio: "ignore" });
  execFileSync("git", [...GIT_IDENTITY, "commit", "-m", `swarm: ${taskId}`], {
    cwd: worktreePath,
    stdio: "ignore",
  });
}

export function removeTaskWorktree(repoRoot: string, worktreePath: string): void {
  execFileSync("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoRoot, stdio: "ignore" });
}

export function gitCommand(cwd: string, args: string[]): string {
  return git(cwd, args);
}

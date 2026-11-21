import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathMatchesScope } from "../schema/plan.js";

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function resolveRelative(root: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("\0")) {
    throw new Error("path must be a non-empty relative path");
  }
  const normalized = relativePath.replaceAll("\\", "/");
  if (normalized.split("/").includes("..")) throw new Error("path traversal is not allowed");
  const target = path.resolve(root, normalized);
  if (!isInside(root, target)) throw new Error("path escapes worktree");
  return target;
}

export async function readWorktreeFile(rootPath: string, relativePath: string, range: { startLine?: number; maxLines?: number } = {}): Promise<string> {
  const root = await realpath(rootPath);
  const target = resolveRelative(root, relativePath);
  const actual = await realpath(target);
  if (!isInside(root, actual)) throw new Error("symlink escapes worktree");
  const content = await readFile(actual, "utf8");
  const lines = content.split("\n");
  const start = Math.max(1, Math.floor(range.startLine ?? 1));
  const limit = Math.floor(range.maxLines ?? lines.length);
  if (start === 1 && limit >= lines.length) return content;
  const end = Math.min(lines.length, start - 1 + Math.max(1, limit));
  return `${lines.slice(start - 1, end).join("\n")}\n… (lines ${start}-${end} of ${lines.length})`;
}

export async function listWorktreeDir(rootPath: string, relativePath = "."): Promise<string[]> {
  const root = await realpath(rootPath);
  const target = relativePath === "." ? root : resolveRelative(root, relativePath);
  const actual = await realpath(target);
  if (!isInside(root, actual)) throw new Error("symlink escapes worktree");
  return readdir(actual);
}

export async function writeWorktreeFile(rootPath: string, relativePath: string, content: string, writeScope: string[]): Promise<void> {
  const root = await realpath(rootPath);
  const target = resolveRelative(root, relativePath);
  const relative = path.relative(root, target).replaceAll(path.sep, "/");
  if (!pathMatchesScope(relative, writeScope)) throw new Error(`write outside writeScope: ${relative}`);

  const segments = relative.split("/");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error("symbolic links are not allowed in write paths");
      if (!info.isDirectory()) throw new Error("parent path is not a directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current);
    }
    const actual = await realpath(current);
    if (!isInside(root, actual)) throw new Error("symlink escapes worktree");
  }

  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error("symbolic links are not allowed in write paths");
    if (!info.isFile()) throw new Error("write target is not a regular file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFile(target, content, "utf8");
}

/** Delete one regular file inside writeScope. */
export async function deleteWorktreeFile(rootPath: string, relativePath: string, writeScope: string[]): Promise<void> {
  const root = await realpath(rootPath);
  const target = resolveRelative(root, relativePath);
  const relative = path.relative(root, target).replaceAll(path.sep, "/");
  if (!pathMatchesScope(relative, writeScope)) throw new Error(`delete outside writeScope: ${relative}`);
  const actual = await realpath(target);
  if (!isInside(root, actual)) throw new Error("symlink escapes worktree");
  const info = await lstat(actual);
  if (info.isSymbolicLink()) throw new Error("symbolic links are not allowed");
  if (!info.isFile()) throw new Error("delete target is not a regular file");
  await rm(actual);
}

/** Replace one unique occurrence of oldText. Ambiguous or missing text is refused so the model retries with more context. */
export async function editWorktreeFile(rootPath: string, relativePath: string, oldText: string, newText: string, writeScope: string[]): Promise<{ replaced: number }> {
  if (!oldText) throw new Error("old text must not be empty");
  const content = await readWorktreeFile(rootPath, relativePath);
  const first = content.indexOf(oldText);
  if (first < 0) throw new Error(`old text not found in ${relativePath}`);
  if (content.indexOf(oldText, first + 1) >= 0) throw new Error(`old text appears more than once in ${relativePath}; include more context`);
  await writeWorktreeFile(rootPath, relativePath, content.slice(0, first) + newText + content.slice(first + oldText.length), writeScope);
  return { replaced: 1 };
}

export function isPathInScope(relativePath: string, writeScope: string[]): boolean {
  return pathMatchesScope(relativePath, writeScope);
}

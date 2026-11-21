import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { afterEach, describe, it } from "node:test";
import path from "node:path";
import { createTaskWorktree, getBaseSha, removeTaskWorktree } from "../src/worker/worktree.js";
import { git, makeRepo, removeRepos } from "./helpers.js";

const worktrees: Array<{ repo: string; path: string }> = [];
afterEach(async () => {
  for (const entry of worktrees.splice(0)) removeTaskWorktree(entry.repo, entry.path);
  await removeRepos();
});

async function repoWithDependencies(): Promise<string> {
  const repo = await makeRepo();
  await writeFile(path.join(repo, ".gitignore"), ".swarm/\nnode_modules/\n");
  git(repo, "add", ".gitignore");
  git(repo, "commit", "-m", "ignore node_modules");
  await mkdir(path.join(repo, "node_modules", "dep"), { recursive: true });
  await writeFile(path.join(repo, "node_modules", "dep", "index.js"), "module.exports = 1\n");
  return repo;
}

describe("createTaskWorktree", () => {
  it("links the repository's node_modules when asked and node_modules is git-ignored", async () => {
    const repo = await repoWithDependencies();
    const worktree = await createTaskWorktree(repo, "r1", "t1", getBaseSha(repo), [], { linkNodeModules: true });
    worktrees.push({ repo, path: worktree.path });
    assert.ok((await lstat(path.join(worktree.path, "node_modules"))).isSymbolicLink());
    assert.ok(existsSync(path.join(worktree.path, "node_modules", "dep", "index.js")));
  });

  it("does not link node_modules by default", async () => {
    const repo = await repoWithDependencies();
    const worktree = await createTaskWorktree(repo, "r1", "t1", getBaseSha(repo));
    worktrees.push({ repo, path: worktree.path });
    assert.equal(existsSync(path.join(worktree.path, "node_modules")), false);
  });
});

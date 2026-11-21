import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { editWorktreeFile, listWorktreeDir, readWorktreeFile, writeWorktreeFile } from "../src/worker/paths.js";

const roots: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "swarm-paths-"));
  roots.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("worktree paths", () => {
  it("writes only within scope and reads/list directories", async () => {
    const root = await tempDir();
    await writeWorktreeFile(root, "src/a.ts", "ok", ["src/**/*.ts"]);
    assert.equal(await readWorktreeFile(root, "src/a.ts"), "ok");
    assert.deepEqual(await listWorktreeDir(root, "src"), ["a.ts"]);
    await assert.rejects(writeWorktreeFile(root, "README.md", "no", ["src/**"]), /writeScope/);
  });

  it("edits one unique occurrence and refuses ambiguous, missing or out-of-scope text", async () => {
    const root = await tempDir();
    await writeWorktreeFile(root, "src/a.ts", "one\ntwo\nthree\n", ["src/**"]);
    assert.deepEqual(await editWorktreeFile(root, "src/a.ts", "two", "TWO", ["src/**"]), { replaced: 1 });
    assert.equal(await readWorktreeFile(root, "src/a.ts"), "one\nTWO\nthree\n");
    await assert.rejects(editWorktreeFile(root, "src/a.ts", "absent", "x", ["src/**"]), /not found/);
    await assert.rejects(editWorktreeFile(root, "src/a.ts", "e", "x", ["src/**"]), /more than once/);
    await assert.rejects(editWorktreeFile(root, "src/a.ts", "TWO", "x", ["other/**"]), /writeScope/);
    await assert.rejects(editWorktreeFile(root, "src/a.ts", "", "x", ["src/**"]), /must not be empty/);
  });

  it("reads a line range and says how much of the file it left out", async () => {
    const root = await tempDir();
    await writeWorktreeFile(root, "big.txt", "l1\nl2\nl3\nl4\n", ["big.txt"]);
    assert.equal(await readWorktreeFile(root, "big.txt", { startLine: 2, maxLines: 2 }), "l2\nl3\n… (lines 2-3 of 5)");
    assert.equal(await readWorktreeFile(root, "big.txt", { maxLines: 2 }), "l1\nl2\n… (lines 1-2 of 5)");
  });

  it("blocks path traversal and symlink escapes", async () => {
    const root = await tempDir();
    const outside = await tempDir();
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(outside, path.join(root, "linked"));
    await assert.rejects(readWorktreeFile(root, "../secret.txt"), /traversal/);
    await assert.rejects(readWorktreeFile(root, "linked/secret.txt"), /symlink/);
    await assert.rejects(writeWorktreeFile(root, "linked/new.txt", "x", ["linked/**"]), /symbolic links/);
  });
});

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../src/worker/commands.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("runCommand", () => {
  it("runs allowlisted argv without a shell", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "swarm-command-"));
    roots.push(cwd);
    const result = await runCommand("node -p 1", cwd, { allow: ["node"], deny: [], timeoutMs: 5000, outputLimitBytes: 100 });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /1/);
  });

  it("rejects shell syntax and non-allowlisted executables", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "swarm-command-"));
    roots.push(cwd);
    const policy = { allow: ["node"], deny: [], timeoutMs: 5000, outputLimitBytes: 100 };
    assert.throws(() => runCommand("node -p 1; node -p 2", cwd, policy), /shell syntax/);
    assert.throws(() => runCommand("curl example.test", cwd, policy), /not allowed/);
  });

  it("groups quoted arguments without running a shell", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "swarm-command-"));
    roots.push(cwd);
    const policy = { allow: ["node"], deny: [], timeoutMs: 5000, outputLimitBytes: 100 };
    const result = await runCommand('node -p "1 + 1"', cwd, policy);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), "2");
    assert.throws(() => runCommand('node -p "unterminated', cwd, policy), /unterminated quote/);
    assert.throws(() => runCommand("node -p 1 | node -p 2", cwd, policy), /shell syntax/);
  });

  it("passes configured environment variables through to commands", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "swarm-command-"));
    roots.push(cwd);
    process.env.SWARM_TEST_PASS = "ok";
    try {
      const policy = { allow: ["node"], deny: [], env: ["SWARM_TEST_PASS"], timeoutMs: 5000, outputLimitBytes: 100 };
      const result = await runCommand("node -p process.env.SWARM_TEST_PASS", cwd, policy);
      assert.equal(result.stdout.trim(), "ok");
    } finally {
      delete process.env.SWARM_TEST_PASS;
    }
  });

  it("does not pass arbitrary environment variables to workers", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "swarm-command-"));
    roots.push(cwd);
    process.env.SWARM_TEST_SECRET = "must-not-leak";
    try {
      const result = await runCommand("node -p process.env.SWARM_TEST_SECRET", cwd, { allow: ["node"], deny: [], timeoutMs: 5000, outputLimitBytes: 100 });
      assert.equal(result.stdout.trim(), "undefined");
      const envTest = await runCommand("node -p process.env.HOME", cwd, { allow: ["node"], deny: [], timeoutMs: 5000, outputLimitBytes: 100 });
      // A scratch HOME: package manager caches must not land in the worktree or the real home.
      assert.notEqual(envTest.stdout.trim(), cwd);
      assert.notEqual(envTest.stdout.trim(), os.homedir());
      assert.match(envTest.stdout.trim(), /swarm-home-/);
    } finally {
      delete process.env.SWARM_TEST_SECRET;
    }
  });
});

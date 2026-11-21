import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadEnvFile, parseEnvFile, removeEnvValue, setEnvValue } from "../src/cli/env-file.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("env file", () => {
  it("parses comments and quotes, and does not override the shell environment", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "swarm-env-"));
    roots.push(dir);
    const file = path.join(dir, ".env");
    await writeFile(file, "# comment\nSWARM_ENV_ONE=one\nSWARM_ENV_TWO=\"two words\"\nSWARM_ENV_THREE='three'\n");
    assert.deepEqual(parseEnvFile(await readFile(file, "utf8")), {
      SWARM_ENV_ONE: "one",
      SWARM_ENV_TWO: "two words",
      SWARM_ENV_THREE: "three",
    });
    process.env.SWARM_ENV_ONE = "shell";
    try {
      await setEnvValue(file, "SWARM_ENV_ONE", "file");
      loadEnvFile(file);
      assert.equal(process.env.SWARM_ENV_ONE, "shell");
    } finally {
      delete process.env.SWARM_ENV_ONE;
      delete process.env.SWARM_ENV_TWO;
      delete process.env.SWARM_ENV_THREE;
    }
  });

  it("writes, replaces and removes a value", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "swarm-env-"));
    roots.push(dir);
    const file = path.join(dir, ".env");
    await setEnvValue(file, "SWARM_ENV_TOKEN", "secret");
    await setEnvValue(file, "SWARM_ENV_OTHER", "x");
    await setEnvValue(file, "SWARM_ENV_TOKEN", "new-secret");
    const text = await readFile(file, "utf8");
    assert.match(text, /SWARM_ENV_TOKEN=new-secret/);
    assert.doesNotMatch(text, /SWARM_ENV_TOKEN=secret/);
    assert.match(text, /SWARM_ENV_OTHER=x/);
    await removeEnvValue(file, "SWARM_ENV_TOKEN");
    assert.doesNotMatch(await readFile(file, "utf8"), /SWARM_ENV_TOKEN=/);
    await assert.rejects(setEnvValue(file, "SWARM_ENV_TOKEN", ""), /must not be empty/);
    await assert.rejects(setEnvValue(file, "bad-name", "x"), /invalid environment variable name/);
  });
});

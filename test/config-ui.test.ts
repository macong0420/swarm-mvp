import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, describe, it } from "node:test";
import path from "node:path";
import { startConfigServer } from "../src/cli/config-ui.js";
import type { ConfigServer } from "../src/cli/config-ui.js";
import { configSchema } from "../src/schema/config.js";
import { makeRepo, removeRepos } from "./helpers.js";

const servers: ConfigServer[] = [];
afterEach(async () => {
  delete process.env.SWARM_TEST_API_KEY;
  delete process.env.SWARM_TEST_KEY2;
  delete process.env.SWARM_TEST_KEY_B;
  delete process.env.SWARM_TEST_KEY_C;
  delete process.env.SWARM_TEST_EXTRA;
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await removeRepos();
});

describe("config UI", () => {
  it("serves the page, saves a validated config and runs checks", async () => {
    const repo = await makeRepo();
    const server = await startConfigServer({ repoRoot: repo, port: 0 });
    servers.push(server);

    const html = await (await fetch(`${server.url}/`)).text();
    assert.match(html, /指挥模型/);
    assert.match(html, /按任务类型路由/);

    const initial = await (await fetch(`${server.url}/api/config`)).json() as { exists: boolean; configPath: string };
    assert.equal(initial.exists, false);
    assert.match(initial.configPath, /\.swarm\/config\.json$/);

    const next = configSchema.parse({
      planner: { provider: "anthropic", baseURL: "http://127.0.0.1:4000", model: "planner-x", apiKeyEnv: "SWARM_TEST_API_KEY" },
      worker: { baseURL: "http://127.0.0.1:4000/v1", model: "worker-y", apiKeyEnv: "SWARM_TEST_KEY_B", routes: { test: { model: "tester", maxTurns: 3, apiKeyEnv: "SWARM_TEST_KEY_C" } } },
      task: { maxTurns: 7 },
      pricing: { "worker-y": { inputPerMillion: 1, outputPerMillion: 2 } },
    });

    const forbidden = await fetch(`${server.url}/api/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: next }),
    });
    assert.equal(forbidden.status, 403);

    const saved = await fetch(`${server.url}/api/config`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-swarm-token": server.token },
      body: JSON.stringify({ config: next }),
    });
    assert.equal(saved.status, 200);
    const savedData = await saved.json() as { config: { planner: { model: string }; worker: { model: string; routes: { test: { maxTurns: number } } }; task: { maxTurns: number } } };
    assert.equal(savedData.config.planner.model, "planner-x");
    assert.equal(savedData.config.worker.model, "worker-y");
    assert.equal(savedData.config.worker.routes.test.maxTurns, 3);
    assert.equal(savedData.config.task.maxTurns, 7);

    const file = JSON.parse(await readFile(path.join(repo, ".swarm", "config.json"), "utf8")) as typeof savedData.config;
    assert.equal(file.planner.model, "planner-x");
    const ignore = await readFile(path.join(repo, ".gitignore"), "utf8");
    assert.match(ignore, /^\.swarm\/$/m);

    const noKeyToken = await fetch(`${server.url}/api/key`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "SWARM_TEST_API_KEY", value: "secret-value" }),
    });
    assert.equal(noKeyToken.status, 403);

    const keySaved = await fetch(`${server.url}/api/key`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-swarm-token": server.token },
      body: JSON.stringify({ name: "SWARM_TEST_API_KEY", value: "secret-value" }),
    });
    assert.equal(keySaved.status, 200);
    assert.match(await readFile(path.join(repo, ".swarm", ".env"), "utf8"), /SWARM_TEST_API_KEY=secret-value/);
    const withKey = await (await fetch(`${server.url}/api/config`)).json() as { envSource: Record<string, string> };
    assert.equal(withKey.envSource.SWARM_TEST_API_KEY, "file");
    assert.equal(withKey.envSource.SWARM_TEST_KEY_B, "missing");
    assert.equal(withKey.envSource.SWARM_TEST_KEY_C, "missing");

    const extra = await fetch(`${server.url}/api/key`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-swarm-token": server.token },
      body: JSON.stringify({ name: "SWARM_TEST_EXTRA", value: "extra-value" }),
    });
    assert.equal(extra.status, 200);
    const withExtra = await (await fetch(`${server.url}/api/config`)).json() as { envSource: Record<string, string> };
    assert.equal(withExtra.envSource.SWARM_TEST_EXTRA, "file");

    const keyCleared = await fetch(`${server.url}/api/key`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-swarm-token": server.token },
      body: JSON.stringify({ name: "SWARM_TEST_API_KEY", value: "" }),
    });
    assert.equal(keyCleared.status, 200);
    assert.doesNotMatch(await readFile(path.join(repo, ".swarm", ".env"), "utf8"), /SWARM_TEST_API_KEY=/);
    const afterClear = await (await fetch(`${server.url}/api/config`)).json() as { envSource: Record<string, string> };
    assert.equal(afterClear.envSource.SWARM_TEST_API_KEY, "missing");

    const checked = await fetch(`${server.url}/api/check`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-swarm-token": server.token },
      body: JSON.stringify({ config: savedData.config }),
    });
    assert.equal(checked.status, 200);
    const checks = await checked.json() as { checks: Array<{ name: string }> };
    assert.ok(checks.checks.some((check) => check.name === "planner.model"));

    const invalid = await fetch(`${server.url}/api/config`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-swarm-token": server.token },
      body: JSON.stringify({ config: { ...next, maxConcurrency: 0 } }),
    });
    assert.equal(invalid.status, 400);
  });

  it("adds .swarm/ to .gitignore before storing a key", async () => {
    const repo = await makeRepo({ ".gitignore": "node_modules/\n" });
    const server = await startConfigServer({ repoRoot: repo, port: 0 });
    servers.push(server);
    const response = await fetch(`${server.url}/api/key`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-swarm-token": server.token },
      body: JSON.stringify({ name: "SWARM_TEST_KEY2", value: "x" }),
    });
    assert.equal(response.status, 200);
    assert.match(await readFile(path.join(repo, ".gitignore"), "utf8"), /^\.swarm\/$/m);
  });
});

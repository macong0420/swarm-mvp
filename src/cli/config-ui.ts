import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { configSchema, defaultConfig } from "../schema/config.js";
import type { SwarmConfig } from "../schema/config.js";
import { doctor } from "./doctor.js";
import { loadEnvFile, parseEnvFile, removeEnvValue, setEnvValue } from "./env-file.js";

export interface ConfigServer {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

const MAX_BODY = 1_000_000;

function send(response: ServerResponse, status: number, type: string, body: string): void {
  response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  response.end(body);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
      if (body.length > MAX_BODY) {
        reject(new Error("request body is too large"));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function keyNames(config: SwarmConfig): string[] {
  return [...new Set([
    config.planner.apiKeyEnv,
    config.worker.apiKeyEnv,
    config.integration.apiKeyEnv ?? "",
    ...Object.values(config.worker.routes).map((route) => route.apiKeyEnv ?? ""),
  ])].filter(Boolean);
}

async function envSource(repoRoot: string, config: SwarmConfig, initialEnv: Set<string>): Promise<Record<string, "env" | "file" | "missing">> {
  const filename = path.join(repoRoot, ".swarm", ".env");
  const fileKeys = new Set(Object.keys(parseEnvFile(await readFile(filename, "utf8").catch(() => ""))));
  const source: Record<string, "env" | "file" | "missing"> = {};
  for (const name of new Set([...keyNames(config), ...fileKeys])) {
    source[name] = fileKeys.has(name) ? "file" : initialEnv.has(name) ? "env" : process.env[name] ? "env" : "missing";
  }
  return source;
}

function envSetOf(source: Record<string, "env" | "file" | "missing">): Record<string, boolean> {
  return Object.fromEntries(Object.entries(source).map(([name, value]) => [name, value !== "missing"]));
}

async function readConfig(repoRoot: string): Promise<{ config: SwarmConfig; exists: boolean; error?: string }> {
  const filename = path.join(repoRoot, ".swarm", "config.json");
  try {
    const raw = await readFile(filename, "utf8");
    try {
      return { config: configSchema.parse(JSON.parse(raw) as unknown), exists: true };
    } catch (error) {
      return { config: defaultConfig, exists: true, error: error instanceof Error ? error.message : String(error) };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: defaultConfig, exists: false };
    throw error;
  }
}

async function ensureSwarmIgnored(repoRoot: string): Promise<void> {
  const ignoreFile = path.join(repoRoot, ".gitignore");
  const ignore = await readFile(ignoreFile, "utf8").catch(() => "");
  if (!/^\/?\.swarm\/?$/m.test(ignore)) await writeFile(ignoreFile, `${ignore}${ignore && !ignore.endsWith("\n") ? "\n" : ""}.swarm/\n`);
}

async function writeConfig(repoRoot: string, raw: unknown): Promise<SwarmConfig> {
  const config = configSchema.parse(raw);
  const directory = path.join(repoRoot, ".swarm");
  await mkdir(directory, { recursive: true });
  const filename = path.join(directory, "config.json");
  try {
    await copyFile(filename, `${filename}.bak`);
  } catch {
    // First save.
  }
  const temporary = `${filename}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`);
  await rename(temporary, filename);
  await ensureSwarmIgnored(repoRoot);
  return config;
}

/** Local, read/write configuration page. The POST endpoints require a per-session token. */
export async function startConfigServer(options: { repoRoot: string; port?: number; host?: string }): Promise<ConfigServer> {
  const token = randomUUID();
  const host = options.host ?? "127.0.0.1";
  const initialEnv = new Set(Object.keys(process.env));
  loadEnvFile(path.join(options.repoRoot, ".swarm", ".env"));
  const server = createServer((request, response) => {
    void handle(request, response);
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    try {
      if (request.method === "GET" && url.pathname === "/") {
        return send(response, 200, "text/html; charset=utf-8", page(token));
      }
      if (request.method === "GET" && url.pathname === "/api/config") {
        const result = await readConfig(options.repoRoot);
        const source = await envSource(options.repoRoot, result.config, initialEnv);
        return send(response, 200, "application/json; charset=utf-8", JSON.stringify({
          config: result.config,
          exists: result.exists,
          ...(result.error ? { error: result.error } : {}),
          envSet: envSetOf(source),
          envSource: source,
          configPath: path.join(options.repoRoot, ".swarm", "config.json"),
        }));
      }
      if (request.method === "POST" && url.pathname === "/api/key") {
        if (request.headers["x-swarm-token"] !== token) {
          return send(response, 403, "application/json; charset=utf-8", JSON.stringify({ error: "forbidden" }));
        }
        const parsed = JSON.parse(await readBody(request)) as { name?: unknown; value?: unknown };
        const name = typeof parsed.name === "string" ? parsed.name : "";
        const value = typeof parsed.value === "string" ? parsed.value : "";
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("invalid environment variable name");
        const filename = path.join(options.repoRoot, ".swarm", ".env");
        await ensureSwarmIgnored(options.repoRoot);
        if (value === "") {
          await removeEnvValue(filename, name);
          if (!initialEnv.has(name)) delete process.env[name];
        } else {
          await setEnvValue(filename, name, value);
          process.env[name] = value;
        }
        const result = await readConfig(options.repoRoot);
        const source = await envSource(options.repoRoot, result.config, initialEnv);
        return send(response, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true, envSet: envSetOf(source), envSource: source }));
      }
      if (request.method === "POST" && (url.pathname === "/api/config" || url.pathname === "/api/check")) {
        if (request.headers["x-swarm-token"] !== token) {
          return send(response, 403, "application/json; charset=utf-8", JSON.stringify({ error: "forbidden" }));
        }
        const parsed = JSON.parse(await readBody(request)) as { config?: unknown };
        if (url.pathname === "/api/check") {
          const config = configSchema.parse(parsed.config);
          return send(response, 200, "application/json; charset=utf-8", JSON.stringify({ checks: doctor(options.repoRoot, config, null) }));
        }
        const config = await writeConfig(options.repoRoot, parsed.config);
        const source = await envSource(options.repoRoot, config, initialEnv);
        return send(response, 200, "application/json; charset=utf-8", JSON.stringify({ config, envSet: envSetOf(source), envSource: source }));
      }
      return send(response, 404, "application/json; charset=utf-8", JSON.stringify({ error: "not found" }));
    } catch (error) {
      return send(response, 400, "application/json; charset=utf-8", JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 7788, host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port ?? 7788;
  return {
    url: `http://${host}:${port}`,
    port,
    token,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function page(token: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>蜂群配置 / Swarm config</title>
<style>
:root{--bg:#f6f7f9;--panel:#ffffff;--line:#dfe3e8;--text:#1f2933;--dim:#6b7785;--accent:#2563eb;--ok:#15803d;--warn:#b45309;--bad:#b91c1c;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
@media (prefers-color-scheme: dark){:root{--bg:#0b0f14;--panel:#111823;--line:#263241;--text:#e5e7eb;--dim:#8b98a9;--accent:#60a5fa;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
header{position:sticky;top:0;z-index:2;display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid var(--line);background:var(--bg)}
h1{font-size:16px;margin:0}
h1 span{color:var(--dim);font-weight:400;font-size:13px}
main{max-width:1200px;margin:0 auto;padding:0 20px 48px}
.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
button{font:inherit;border:1px solid var(--accent);background:var(--accent);color:#fff;border-radius:8px;padding:7px 14px;cursor:pointer}
button.secondary{background:transparent;color:var(--accent)}
button.danger{background:transparent;border-color:var(--bad);color:var(--bad);padding:4px 9px}
button:disabled{opacity:.45;cursor:not-allowed}
.status{color:var(--dim);font-size:12.5px}
.status.ok{color:var(--ok)}.status.bad{color:var(--bad)}
.banner{margin:14px 20px 0;padding:10px 14px;border:1px solid var(--bad);background:rgba(185,28,28,.08);color:var(--bad);border-radius:8px;white-space:pre-wrap}
.path{color:var(--dim);font-family:var(--mono);font-size:12px;margin:14px 0 0}
.checks{display:grid;gap:4px;margin:10px 0 0}
.check-item{font-family:var(--mono);font-size:12px;padding:4px 8px;border-radius:6px;background:var(--panel);border:1px solid var(--line)}
.check-item.ok{border-left:4px solid var(--ok)}.check-item.warn{border-left:4px solid var(--warn)}.check-item.error{border-left:4px solid var(--bad)}
section{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-top:14px}
section h2{font-size:13px;margin:0 0 10px;letter-spacing:.03em;text-transform:uppercase;color:var(--dim)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px 14px}
.field{display:flex;flex-direction:column;gap:4px;font-size:13px}
.field span{font-weight:600}
.field small{color:var(--dim);font-size:11.5px;font-weight:400}
input,select,textarea{font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:7px;padding:6px 8px;width:100%}
input[type=checkbox]{width:auto;margin-right:6px}
label.check{display:flex;align-items:center;gap:4px;font-weight:600;font-size:13px;padding-top:20px}
.badge{font-size:11px;border-radius:999px;padding:1px 8px;margin-top:2px;width:max-content}
.badge.ok{background:rgba(21,128,61,.12);color:var(--ok)}.badge.bad{background:rgba(185,28,28,.12);color:var(--bad)}
.muted{color:var(--dim);font-size:12.5px;margin:0 0 10px}
.route-card,.price-row{border:1px solid var(--line);border-radius:10px;padding:10px;margin-top:8px}
.route-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-family:var(--mono)}
.routes,.pricing{display:grid;gap:8px}
.add-row{display:flex;gap:8px;margin-top:10px;align-items:center}
.add-row input,.add-row select{max-width:260px}
.keys{display:grid;gap:8px}
.key-row{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;align-items:center;border:1px solid var(--line);border-radius:10px;padding:10px}
.key-row strong{font-family:var(--mono);font-size:13px;margin-right:8px}
.key-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.key-actions input{max-width:260px}
.key-usage{color:var(--dim);font-size:11.5px;margin-left:8px}
.price-row{display:grid;grid-template-columns:2fr 1fr 1fr auto;gap:8px;align-items:center}
.advanced{margin-top:14px}
.advanced summary{cursor:pointer;color:var(--dim);font-size:13px}
.advanced textarea{min-height:260px;font-family:var(--mono);font-size:12px;margin-top:8px}
@media (max-width:640px){header{position:static}.price-row{grid-template-columns:1fr 1fr}.price-row input:first-child{grid-column:1/-1}}
</style>
</head>
<body>
<header>
  <h1>🐝 蜂群配置 <span>Swarm configuration</span></h1>
  <div class="actions">
    <span id="status" class="status"></span>
    <button id="check" class="secondary" type="button">检查配置</button>
    <button id="save" type="button">保存</button>
  </div>
</header>
<div id="banner" class="banner" hidden></div>
<main>
  <p class="path" id="path"></p>
  <div id="checks" class="checks"></div>
  <form id="form"></form>
  <details class="advanced">
    <summary>高级 JSON / Advanced JSON</summary>
    <textarea id="json" spellcheck="false"></textarea>
    <div class="add-row"><button id="applyJson" class="secondary" type="button">应用 JSON</button></div>
  </details>
</main>
<script>
var TOKEN = '${token}';
var KINDS = ['implement', 'test', 'refactor', 'docs', 'investigate'];
var PRESETS = {
  planner: {
    anthropic: {label: 'Anthropic 官方', provider: 'anthropic', baseURL: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY'},
    openai: {label: 'OpenAI 官方', provider: 'openai', baseURL: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY'},
    deepseek: {label: 'DeepSeek', provider: 'openai', baseURL: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY'},
    ollama: {label: 'Ollama 本地', provider: 'openai', baseURL: 'http://127.0.0.1:11434/v1', apiKeyEnv: 'OLLAMA_API_KEY'},
    local: {label: '本地网关 / Local gateway', provider: 'anthropic', baseURL: 'http://127.0.0.1:4000', apiKeyEnv: 'LOCAL_GATEWAY_API_KEY'}
  },
  worker: {
    anthropic: {label: 'Anthropic 官方', provider: 'anthropic', baseURL: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY'},
    openai: {label: 'OpenAI 官方', provider: 'openai', baseURL: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY'},
    deepseek: {label: 'DeepSeek', provider: 'openai', baseURL: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY'},
    ollama: {label: 'Ollama 本地', provider: 'openai', baseURL: 'http://127.0.0.1:11434/v1', apiKeyEnv: 'OLLAMA_API_KEY'},
    local: {label: '本地网关 / Local gateway', provider: 'openai', baseURL: 'http://127.0.0.1:4000/v1', apiKeyEnv: 'LOCAL_GATEWAY_API_KEY'}
  }
};
var SECTIONS = [
  {title: '指挥模型 / Planner', preset: 'planner', fields: [
    {path: 'planner.provider', label: 'Provider', type: 'select', options: [['anthropic', 'Anthropic Messages'], ['openai', 'OpenAI-compatible']]},
    {path: 'planner.baseURL', label: 'Base URL', hint: 'Anthropic 不带 /v1；OpenAI 兼容通常带 /v1'},
    {path: 'planner.model', label: 'Model', hint: '负责拆分任务和升级决策'},
    {path: 'planner.fallbackModel', label: 'Fallback model', hint: '可选，最终错误时使用'},
    {path: 'planner.apiKeyEnv', label: 'API key 环境变量', env: true, hint: '填变量名，不填密钥本身'},
    {path: 'planner.maxOutputTokens', label: 'Max output tokens', type: 'number'},
    {path: 'planner.reasoningEffort', label: 'Reasoning effort', hint: '例如 high / low，可留空'},
    {path: 'planner.maxToolTurns', label: '仓库检查轮次', type: 'number'},
    {path: 'planner.maxReadLines', label: '单次读取行数', type: 'number'},
    {path: 'planner.maxSearchHits', label: '搜索命中上限', type: 'number'}
  ]},
  {title: '干活模型 / Worker', preset: 'worker', fields: [
    {path: 'worker.provider', label: 'Provider', type: 'select', options: [['openai', 'OpenAI-compatible'], ['anthropic', 'Anthropic Messages']]},
    {path: 'worker.baseURL', label: 'Base URL'},
    {path: 'worker.model', label: 'Model', hint: '默认执行任务的模型'},
    {path: 'worker.fallbackModel', label: 'Fallback model', hint: '可选'},
    {path: 'worker.apiKeyEnv', label: 'API key 环境变量', env: true},
    {path: 'worker.maxOutputTokens', label: 'Max output tokens', type: 'number'},
    {path: 'worker.reasoningEffort', label: 'Reasoning effort'},
    {path: 'worker.maxReadLines', label: '单次读取行数', type: 'number'}
  ]},
  {title: '集成修复 / Integration fix', fields: [
    {path: 'integration.provider', label: 'Provider', type: 'select', options: [['', '继承 Planner'], ['anthropic', 'Anthropic'], ['openai', 'OpenAI-compatible']]},
    {path: 'integration.model', label: 'Model', hint: '留空继承 Planner'},
    {path: 'integration.fallbackModel', label: 'Fallback model'},
    {path: 'integration.baseURL', label: 'Base URL', hint: '留空继承 Planner'},
    {path: 'integration.apiKeyEnv', label: 'API key 环境变量', env: true, hint: '留空继承 Planner'},
    {path: 'integration.maxOutputTokens', label: 'Max output tokens', type: 'number'},
    {path: 'integration.reasoningEffort', label: 'Reasoning effort'},
    {path: 'integration.maxTurns', label: 'Max turns', type: 'number'},
    {path: 'integration.maxTokens', label: 'Max tokens', type: 'number'},
    {path: 'integration.maxWallSec', label: 'Max wall seconds', type: 'number'},
    {path: 'integration.verifyAfterFix', label: '修复后复验全局验收', type: 'boolean'}
  ]},
  {title: '模型调用 / Model calls', fields: [
    {path: 'modelCall.timeoutSec', label: '单次超时（秒）', type: 'number'},
    {path: 'modelCall.maxRetries', label: 'SDK 重试次数', type: 'number'},
    {path: 'modelCall.stream', label: 'Anthropic 流式调用', type: 'boolean'},
    {path: 'modelCall.cacheSystemPrompt', label: 'Anthropic 系统提示缓存', type: 'boolean'}
  ]},
  {title: '并发与重试 / Concurrency & retries', fields: [
    {path: 'maxConcurrency', label: '最大并发任务', type: 'number'},
    {path: 'maxLogicRetries', label: '逻辑失败重试', type: 'number'},
    {path: 'maxPlanRetries', label: '计划被拒重试', type: 'number'},
    {path: 'maxTransientRetries', label: '临时失败重试', type: 'number'},
    {path: 'retryBaseMs', label: '退避基数（毫秒）', type: 'number'},
    {path: 'heartbeatSec', label: '心跳间隔（秒）', type: 'number'},
    {path: 'leaseSec', label: '租约（秒）', type: 'number'}
  ]},
  {title: '任务预算 / Task budgets', fields: [
    {path: 'task.maxTurns', label: '每任务最大轮次', type: 'number'},
    {path: 'task.maxTokens', label: '每任务最大 token', type: 'number'},
    {path: 'task.maxWallSec', label: '每任务最大墙钟（秒）', type: 'number'},
    {path: 'task.maxFiles', label: '计划文件数上限', type: 'number'},
    {path: 'task.maxLines', label: '计划行数上限', type: 'number'},
    {path: 'task.maxContextChars', label: '上下文压缩阈值（字符，0 关闭）', type: 'number'}
  ]},
  {title: '运行预算与保留 / Run & retention', fields: [
    {path: 'run.maxCostUsd', label: '单轮成本上限（USD）', type: 'number'},
    {path: 'run.baseline', label: '运行前记录基线验收', type: 'boolean'},
    {path: 'run.baselinePolicy', label: '基线策略', type: 'select', options: [['strict', 'strict（全部阻塞）'], ['ignore-existing', 'ignore-existing（原有失败不阻塞）']]},
    {path: 'worktree.linkNodeModules', label: '链接 node_modules 到 worktree', type: 'boolean'},
    {path: 'failedWorktreeTtlMinutes', label: '失败 worktree 保留（分钟）', type: 'number'},
    {path: 'keepBranchesMinutes', label: '完成 run 分支保留（分钟，0 永久）', type: 'number'}
  ]},
  {title: '命令策略 / Command policy', fields: [
    {path: 'commandPolicy.allow', label: '允许的可执行文件', type: 'list', hint: '逗号分隔，例如 git, node, pnpm'},
    {path: 'commandPolicy.deny', label: '拒绝的子串', type: 'list', hint: '逗号分隔，例如 push, reset --hard, install'},
    {path: 'commandPolicy.env', label: '放行的环境变量', type: 'list', hint: '例如 COREPACK_HOME, PNPM_HOME'},
    {path: 'commandPolicy.timeoutMs', label: '命令超时（毫秒）', type: 'number'},
    {path: 'commandPolicy.outputLimitBytes', label: '输出上限（字节）', type: 'number'}
  ]}
];
var state = {config: null, envSet: {}, envSource: {}, exists: false, configPath: ''};
function $(id) { return document.getElementById(id); }
function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]; }); }
function getPath(object, path) { return path.split('.').reduce(function (current, key) { return current == null ? undefined : current[key]; }, object); }
function setPath(object, path, value) { var parts = path.split('.'); var current = object; for (var i = 0; i < parts.length - 1; i++) { if (current[parts[i]] == null || typeof current[parts[i]] !== 'object') current[parts[i]] = {}; current = current[parts[i]]; } current[parts[parts.length - 1]] = value; }
function delPath(object, path) { var parts = path.split('.'); var current = object; for (var i = 0; i < parts.length - 1; i++) { current = current == null ? undefined : current[parts[i]]; } if (current && typeof current === 'object') delete current[parts[parts.length - 1]]; }
function envBadge(name) { if (!name) return ''; var source = state.envSource[name]; var label = source === 'file' ? '已写入 .swarm/.env' : source === 'env' ? '环境变量已设置' : '未设置'; return '<span class="badge ' + (source ? 'ok' : 'bad') + '">' + label + ' ' + esc(name) + '</span>'; }
function refreshEnvBadges() {
  Array.prototype.forEach.call(document.querySelectorAll('[data-path$=".apiKeyEnv"], [data-field="apiKeyEnv"]'), function (input) {
    var holder = input.closest('.field');
    if (!holder) return;
    var badge = holder.querySelector('.badge');
    var html = envBadge(input.value.trim());
    if (badge) { if (html) badge.outerHTML = html; else badge.remove(); }
    else if (html) holder.insertAdjacentHTML('beforeend', html);
  });
}
function fieldHtml(field) {
  var value = getPath(state.config, field.path);
  var control;
  if (field.type === 'select') {
    control = '<select data-path="' + field.path + '" data-type="string">' + field.options.map(function (option) { return '<option value="' + esc(option[0]) + '"' + (String(value == null ? '' : value) === option[0] ? ' selected' : '') + '>' + esc(option[1]) + '</option>'; }).join('') + '</select>';
  } else if (field.type === 'boolean') {
    control = '<label class="check"><input data-path="' + field.path + '" data-type="boolean" type="checkbox"' + (value ? ' checked' : '') + '> ' + esc(field.label) + '</label>';
    return control + (field.hint ? '<small>' + esc(field.hint) + '</small>' : '');
  } else if (field.type === 'number') {
    control = '<input data-path="' + field.path + '" data-type="number" type="number" min="0" step="1" value="' + esc(value == null ? '' : value) + '">';
  } else if (field.type === 'list') {
    control = '<input data-path="' + field.path + '" data-type="list" value="' + esc((value || []).join(', ')) + '">';
  } else {
    control = '<input data-path="' + field.path + '" data-type="string" value="' + esc(value == null ? '' : value) + '">';
  }
  return '<label class="field"><span>' + esc(field.label) + '</span>' + control + (field.hint ? '<small>' + esc(field.hint) + '</small>' : '') + (field.env ? envBadge(value) : '') + '</label>';
}
function render() {
  $('form').innerHTML = SECTIONS.map(function (section) {
    var preset = section.preset
      ? '<div class="add-row"><select data-preset-role="' + section.preset + '"><option value="">快速填入常用端点…</option>' + Object.keys(PRESETS[section.preset]).map(function (name) { return '<option value="' + name + '">' + esc(PRESETS[section.preset][name].label) + '</option>'; }).join('') + '</select><span class="muted">模型名请按供应商文档填写</span></div>'
      : '';
    return '<section><h2>' + esc(section.title) + '</h2>' + preset + '<div class="grid">' + section.fields.map(fieldHtml).join('') + '</div></section>';
  }).join('') +
    '<section><h2>密钥 / API keys</h2><p class="muted">密钥只写入 .swarm/.env（0600），不会写入 config.json 或事件日志；shell 环境变量优先。不同 Planner / Worker / Integration / 路由可以填不同的变量名。</p><div id="keys" class="keys"></div><div class="add-row"><input id="newKeyName" placeholder="环境变量名，例如 OPENAI_API_KEY"><input id="newKeyValue" type="password" placeholder="密钥值（不会显示）" autocomplete="new-password"><button id="addKey" class="secondary" type="button">添加密钥</button></div></section>' +
    '<section><h2>按任务类型路由 / Task routes</h2><p class="muted">为 implement / test / refactor / docs / investigate 分别指定模型和预算；留空的字段继承 Worker 默认。</p><div id="routes" class="routes"></div><div class="add-row"><select id="newRouteKind"></select><button id="addRoute" class="secondary" type="button">添加路由</button></div></section>' +
    '<section><h2>定价 / Pricing</h2><p class="muted">按模型名配置每百万 token 的输入/输出价格；未配置的模型按免费处理并触发告警。</p><div id="pricing" class="pricing"></div><div class="add-row"><input id="newPriceModel" placeholder="模型名"><button id="addPrice" class="secondary" type="button">添加价格</button></div></section>';
  renderRoutes();
  renderPricing();
  renderKeys();
  $('addKey').onclick = addKey;
  $('addRoute').onclick = addRoute;
  $('addPrice').onclick = addPrice;
  $('json').value = JSON.stringify(state.config, null, 2);
  $('path').textContent = state.configPath + (state.exists ? '' : '（尚未创建，保存后生成）');
}
function renderRoutes() {
  var routes = state.config.worker.routes || {};
  var kinds = Object.keys(routes);
  $('routes').innerHTML = kinds.map(function (kind) {
    var route = routes[kind] || {};
    return '<div class="route-card" data-kind="' + esc(kind) + '"><div class="route-head"><strong>' + esc(kind) + '</strong><button class="danger" type="button" data-remove-route="' + esc(kind) + '">删除</button></div><div class="grid">' +
      '<label class="field"><span>Provider</span><select data-field="provider">' + ['', 'openai', 'anthropic'].map(function (provider) { return '<option value="' + provider + '"' + ((route.provider || '') === provider ? ' selected' : '') + '>' + (provider || '继承 Worker') + '</option>'; }).join('') + '</select></label>' +
      '<label class="field"><span>Model</span><input data-field="model" value="' + esc(route.model || '') + '"></label>' +
      '<label class="field"><span>Fallback model</span><input data-field="fallbackModel" value="' + esc(route.fallbackModel || '') + '"></label>' +
      '<label class="field"><span>Base URL</span><input data-field="baseURL" value="' + esc(route.baseURL || '') + '"></label>' +
      '<label class="field"><span>API key 环境变量</span><input data-field="apiKeyEnv" value="' + esc(route.apiKeyEnv || '') + '">' + envBadge(route.apiKeyEnv || '') + '</label>' +
      '<label class="field"><span>Max output tokens</span><input data-field="maxOutputTokens" type="number" value="' + esc(route.maxOutputTokens == null ? '' : route.maxOutputTokens) + '"></label>' +
      '<label class="field"><span>Reasoning effort</span><input data-field="reasoningEffort" value="' + esc(route.reasoningEffort || '') + '"></label>' +
      '<label class="field"><span>Max turns</span><input data-field="maxTurns" type="number" value="' + esc(route.maxTurns == null ? '' : route.maxTurns) + '"></label>' +
      '<label class="field"><span>Max tokens</span><input data-field="maxTokens" type="number" value="' + esc(route.maxTokens == null ? '' : route.maxTokens) + '"></label>' +
      '<label class="field"><span>Max wall seconds</span><input data-field="maxWallSec" type="number" value="' + esc(route.maxWallSec == null ? '' : route.maxWallSec) + '"></label>' +
      '</div></div>';
  }).join('') || '<p class="muted">还没有路由，所有任务使用 Worker 默认模型。</p>';
  var missing = KINDS.filter(function (kind) { return !(kind in routes); });
  $('newRouteKind').innerHTML = missing.map(function (kind) { return '<option value="' + kind + '">' + kind + '</option>'; }).join('');
  $('addRoute').disabled = missing.length === 0;
}
function renderPricing() {
  var pricing = state.config.pricing || {};
  $('pricing').innerHTML = Object.keys(pricing).map(function (model) {
    var price = pricing[model] || {};
    return '<div class="price-row" data-price="' + esc(model) + '"><input data-price-model value="' + esc(model) + '"><input data-price-input type="number" step="0.0001" value="' + esc(price.inputPerMillion == null ? 0 : price.inputPerMillion) + '" placeholder="输入 / 百万"><input data-price-output type="number" step="0.0001" value="' + esc(price.outputPerMillion == null ? 0 : price.outputPerMillion) + '" placeholder="输出 / 百万"><button class="danger" type="button" data-remove-price="' + esc(model) + '">删除</button></div>';
  }).join('') || '<p class="muted">还没有定价；未定价模型按免费处理。</p>';
}
function keyUsage() {
  var usage = {};
  function add(name, label) { if (!name) return; usage[name] = usage[name] || []; if (usage[name].indexOf(label) < 0) usage[name].push(label); }
  add(state.config.planner.apiKeyEnv, 'Planner');
  add(state.config.worker.apiKeyEnv, 'Worker');
  add(state.config.integration.apiKeyEnv, 'Integration');
  var routes = state.config.worker.routes || {};
  Object.keys(routes).forEach(function (kind) { add(routes[kind].apiKeyEnv, 'Route: ' + kind); });
  return usage;
}
function renderKeys() {
  var usage = keyUsage();
  var names = Object.keys(state.envSource);
  $('keys').innerHTML = names.length ? names.map(function (name) {
    var source = state.envSource[name];
    var label = source === 'file' ? '已写入 .swarm/.env' : source === 'env' ? '环境变量已设置' : '未设置';
    var used = usage[name] && usage[name].length ? usage[name].join(' / ') : '未引用';
    return '<div class="key-row"><div><strong>' + esc(name) + '</strong><span class="badge ' + (source ? 'ok' : 'bad') + '">' + label + '</span><small class="key-usage">' + esc(used) + '</small></div><div class="key-actions"><input type="password" data-key-input="' + esc(name) + '" placeholder="输入新密钥（不会显示）" autocomplete="new-password"><button class="secondary" type="button" data-save-key="' + esc(name) + '">保存密钥</button><button class="danger" type="button" data-clear-key="' + esc(name) + '">清除</button></div></div>';
  }).join('') : '<p class="muted">还没有密钥变量；在下面添加，或先在上面的配置里填写 API key 环境变量名。</p>';
}
async function writeKey(name, value) {
  var response = await fetch('/api/key', {method: 'POST', headers: {'content-type': 'application/json', 'x-swarm-token': TOKEN}, body: JSON.stringify({name: name, value: value})});
  var data = await response.json();
  if (!response.ok) throw new Error(data.error || ('HTTP ' + response.status));
  state.envSet = data.envSet || state.envSet;
  state.envSource = data.envSource || state.envSource;
  renderKeys();
  refreshEnvBadges();
}
async function saveKey(name) {
  var input = document.querySelector('[data-key-input="' + name + '"]');
  var value = input ? input.value : '';
  if (!value) { setStatus('请输入密钥', 'bad'); return; }
  await writeKey(name, value);
  if (input) input.value = '';
  setStatus('密钥已写入 .swarm/.env', 'ok');
}
async function clearKey(name) {
  await writeKey(name, '');
  setStatus('已清除 .swarm/.env 中的密钥', 'ok');
}
async function addKey() {
  var name = $('newKeyName').value.trim();
  var value = $('newKeyValue').value;
  if (!name || !value) { setStatus('请填写变量名和密钥', 'bad'); return; }
  await writeKey(name, value);
  $('newKeyName').value = '';
  $('newKeyValue').value = '';
  setStatus('密钥已写入 .swarm/.env', 'ok');
}
function applyField(element) {
  var path = element.dataset.path;
  var type = element.dataset.type;
  if (type === 'boolean') { setPath(state.config, path, element.checked); return; }
  var raw = element.value.trim();
  if (type === 'number') { if (raw === '') delPath(state.config, path); else setPath(state.config, path, Number(raw)); return; }
  if (type === 'list') { setPath(state.config, path, raw ? raw.split(',').map(function (item) { return item.trim(); }).filter(Boolean) : []); return; }
  if (raw === '') delPath(state.config, path); else setPath(state.config, path, raw);
}
function collectForm() {
  Array.prototype.forEach.call(document.querySelectorAll('[data-path]'), applyField);
  var routes = {};
  Array.prototype.forEach.call(document.querySelectorAll('.route-card'), function (card) {
    var route = {};
    Array.prototype.forEach.call(card.querySelectorAll('[data-field]'), function (field) {
      var raw = field.value.trim();
      if (raw === '') return;
      route[field.dataset.field] = field.type === 'number' ? Number(raw) : raw;
    });
    if (Object.keys(route).length) routes[card.dataset.kind] = route;
  });
  state.config.worker.routes = routes;
  var pricing = {};
  Array.prototype.forEach.call(document.querySelectorAll('.price-row'), function (row) {
    var model = row.querySelector('[data-price-model]').value.trim();
    var input = Number(row.querySelector('[data-price-input]').value);
    var output = Number(row.querySelector('[data-price-output]').value);
    if (model && Number.isFinite(input) && Number.isFinite(output)) pricing[model] = {inputPerMillion: input, outputPerMillion: output};
  });
  state.config.pricing = pricing;
}
function addRoute() { collectForm(); var kind = $('newRouteKind').value; if (!kind) return; state.config.worker.routes = state.config.worker.routes || {}; state.config.worker.routes[kind] = {}; render(); }
function addPrice() { collectForm(); var model = $('newPriceModel').value.trim(); if (!model) return; state.config.pricing = state.config.pricing || {}; state.config.pricing[model] = {inputPerMillion: 0, outputPerMillion: 0}; render(); }
function applyPreset(role, name) {
  var preset = PRESETS[role] && PRESETS[role][name];
  if (!preset) return;
  collectForm();
  var target = state.config[role];
  target.provider = preset.provider;
  target.baseURL = preset.baseURL;
  target.apiKeyEnv = preset.apiKeyEnv;
  render();
  setStatus('已填入 ' + preset.label + ' 端点，请填写模型名并保存');
}
function setStatus(message, kind) { var status = $('status'); status.textContent = message; status.className = 'status' + (kind ? ' ' + kind : ''); }
function setBanner(message) { var banner = $('banner'); banner.hidden = !message; banner.textContent = message || ''; }
function showError(error) { setBanner(error instanceof Error ? error.message : String(error)); setStatus('失败', 'bad'); }
async function save() {
  collectForm();
  var response = await fetch('/api/config', {method: 'POST', headers: {'content-type': 'application/json', 'x-swarm-token': TOKEN}, body: JSON.stringify({config: state.config})});
  var data = await response.json();
  if (!response.ok) throw new Error(data.error || ('HTTP ' + response.status));
  state.config = data.config; state.envSet = data.envSet || state.envSet; state.envSource = data.envSource || state.envSource; state.exists = true;
  setBanner(''); render(); setStatus('已保存', 'ok');
}
async function check() {
  collectForm();
  var response = await fetch('/api/check', {method: 'POST', headers: {'content-type': 'application/json', 'x-swarm-token': TOKEN}, body: JSON.stringify({config: state.config})});
  var data = await response.json();
  if (!response.ok) throw new Error(data.error || ('HTTP ' + response.status));
  $('checks').innerHTML = (data.checks || []).map(function (item) { return '<div class="check-item ' + item.level + '">' + item.level.toUpperCase() + ' ' + esc(item.name) + ': ' + esc(item.detail) + '</div>'; }).join('');
  setStatus('检查完成', data.checks.some(function (item) { return item.level === 'error'; }) ? 'bad' : 'ok');
}
async function load() {
  var response = await fetch('/api/config');
  var data = await response.json();
  if (!response.ok) throw new Error(data.error || ('HTTP ' + response.status));
  state.config = data.config; state.envSet = data.envSet || {}; state.envSource = data.envSource || {}; state.exists = data.exists; state.configPath = data.configPath;
  if (data.error) setBanner('现有配置无法解析：' + data.error);
  render();
}
$('save').onclick = function () { save().catch(showError); };
$('check').onclick = function () { check().catch(showError); };
$('form').onsubmit = function (event) { event.preventDefault(); };
$('form').addEventListener('click', function (event) {
  var target = event.target;
  if (target.dataset.removeRoute) { collectForm(); delete state.config.worker.routes[target.dataset.removeRoute]; render(); }
  if (target.dataset.removePrice) { collectForm(); delete state.config.pricing[target.dataset.removePrice]; render(); }
  if (target.dataset.saveKey) { saveKey(target.dataset.saveKey).catch(showError); }
  if (target.dataset.clearKey) { clearKey(target.dataset.clearKey).catch(showError); }
});
$('form').addEventListener('change', function (event) {
  var role = event.target.dataset.presetRole;
  if (role) applyPreset(role, event.target.value);
});
$('applyJson').onclick = function () {
  try { state.config = JSON.parse($('json').value); setBanner(''); render(); setStatus('JSON 已应用，尚未保存'); } catch (error) { showError(error); }
};
load().catch(showError);
</script>
</body>
</html>`;
}

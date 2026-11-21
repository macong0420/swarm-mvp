import { createServer } from "node:http";
import path from "node:path";
import type { TaskStatus } from "../core/state.js";
import { replay } from "../core/state.js";
import { EventStore } from "../store/events.js";
import type { StoredEvent } from "../store/events.js";
import { summarizeRun } from "./report.js";

export interface VizAttempt {
  attempt: number;
  role: string;
  startedAt: string;
  endedAt: string | null;
  outcome: string | null;
}

export interface VizTask {
  id: string;
  title: string;
  state: TaskStatus;
  dependsOn: string[];
  writeScope: string[];
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number | null;
  elapsedMs: number;
  failureReason: string | null;
  escalation: string | null;
  branch: string | null;
  timeline: VizAttempt[];
}

export interface VizData {
  runId: string;
  request: string;
  goal: string | null;
  state: string;
  reason: string | null;
  integrationBranch: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  now: string;
  elapsedMs: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number | null;
  tasks: VizTask[];
  events: Array<{ id: number; ts: string; type: string; taskId: string | null; attempt: number | null; detail: string }>;
  stats: {
    plannerCalls: number;
    workerCalls: number;
    acceptanceRuns: number;
    acceptanceFailures: number;
    failures: Record<string, number>;
    merges: number;
  };
}

function eventDetail(payload: Record<string, unknown>): string {
  if (payload.from !== undefined && payload.to !== undefined) return `${String(payload.from)} → ${String(payload.to)}`;
  for (const key of ["errorSummary", "reason", "detail", "command", "tool", "model", "action", "kind", "path"]) {
    const value = payload[key];
    if (typeof value === "string" && value) return value.replace(/\s+/g, " ").slice(0, 160);
  }
  return "";
}

function attemptTimeline(taskLog: StoredEvent[], finishedAt: string | null, finalState: TaskStatus): VizAttempt[] {
  const timeline: VizAttempt[] = [];
  let open: VizAttempt | null = null;
  for (const event of taskLog) {
    if (event.type === "worker_started") {
      open = { attempt: event.attempt ?? 0, role: String(event.payload.role ?? "worker"), startedAt: event.ts, endedAt: null, outcome: null };
      timeline.push(open);
    } else if (event.type === "task_state_changed" && event.payload.from === "running" && open) {
      open.endedAt = event.ts;
      open.outcome = String(event.payload.to ?? "");
      open = null;
    }
  }
  if (open && finishedAt) {
    open.endedAt = finishedAt;
    open.outcome = finalState;
  }
  return timeline;
}

/** Everything the visualization page shows, derived from the event log alone. */
export function buildVizData(events: EventStore, runId: string): VizData {
  const all = events.list({ runId });
  if (!all.length) throw new Error(`unknown run: ${runId}`);
  const state = replay(runId, all);
  const summary = summarizeRun(events, runId);
  const startedAt = all.find((event) => event.type === "run_started")?.ts ?? null;
  const terminal = [...all].reverse().find((event) => event.type === "run_finished" || event.type === "run_reopened");
  const finished = terminal?.type === "run_finished" ? terminal : undefined;
  const finishedAt = finished?.ts ?? null;

  const byTask = new Map<string, StoredEvent[]>();
  for (const event of all) {
    if (!event.taskId) continue;
    byTask.set(event.taskId, [...(byTask.get(event.taskId) ?? []), event]);
  }

  const tasks: VizTask[] = [...state.tasks.values()].map((task) => {
    const planTask = state.plan?.tasks.find((entry) => entry.id === task.id);
    const totals = summary.tasks.find((entry) => entry.taskId === task.id);
    return {
      id: task.id,
      title: planTask?.title ?? task.id,
      state: task.state,
      dependsOn: planTask?.dependsOn ?? [],
      writeScope: planTask?.writeScope ?? [],
      attempts: task.attempts,
      inputTokens: totals?.inputTokens ?? 0,
      outputTokens: totals?.outputTokens ?? 0,
      estimatedCostUsd: totals?.estimatedCostUsd ?? null,
      elapsedMs: totals?.elapsedMs ?? 0,
      failureReason: totals?.failureReason ?? null,
      escalation: task.escalation ?? null,
      branch: task.branch ?? null,
      timeline: attemptTimeline(byTask.get(task.id) ?? [], finishedAt, task.state),
    };
  });

  const stats: VizData["stats"] = { plannerCalls: 0, workerCalls: 0, acceptanceRuns: 0, acceptanceFailures: 0, failures: {}, merges: 0 };
  for (const event of all) {
    if (event.type === "model_call") {
      if (event.payload.phase === "worker") stats.workerCalls += 1;
      else stats.plannerCalls += 1;
    } else if (event.type === "acceptance_run") {
      stats.acceptanceRuns += 1;
      if (event.payload.exitCode !== 0) stats.acceptanceFailures += 1;
    } else if (event.type === "failure") {
      const cls = String(event.payload.class ?? "unknown");
      stats.failures[cls] = (stats.failures[cls] ?? 0) + 1;
    } else if (event.type === "task_state_changed" && event.payload.to === "merged") {
      stats.merges += 1;
    }
  }

  return {
    runId,
    request: state.request,
    goal: state.plan?.goal ?? null,
    state: String(summary.state),
    reason: summary.reason === null ? null : String(summary.reason),
    integrationBranch: typeof finished?.payload.integrationBranch === "string" ? finished.payload.integrationBranch : null,
    startedAt,
    finishedAt,
    now: new Date().toISOString(),
    elapsedMs: summary.elapsedMs,
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    estimatedCostUsd: summary.estimatedCostUsd,
    tasks,
    events: all.slice(-200).map((event) => ({ id: event.id, ts: event.ts, type: event.type, taskId: event.taskId, attempt: event.attempt, detail: eventDetail(event.payload) })),
    stats,
  };
}

export interface VizServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startVizServer(options: { repoRoot: string; runId: string; port?: number; host?: string }): Promise<VizServer> {
  const dbPath = path.join(options.repoRoot, ".swarm", "events.sqlite");
  const host = options.host ?? "127.0.0.1";
  const server = createServer((request, response) => {
    const send = (status: number, type: string, body: string): void => {
      response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      response.end(body);
    };
    try {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (pathname === "/") return send(200, "text/html; charset=utf-8", page(options.runId));
      if (pathname === "/api/run") {
        // A fresh store per request: the page always sees the latest appended events.
        const events = new EventStore(dbPath);
        try {
          return send(200, "application/json; charset=utf-8", JSON.stringify(buildVizData(events, options.runId)));
        } finally {
          events.close();
        }
      }
      return send(404, "application/json; charset=utf-8", JSON.stringify({ error: "not found" }));
    } catch (error) {
      return send(500, "application/json; charset=utf-8", JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 7777, host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port ?? 7777;
  return {
    url: `http://${host}:${port}`,
    port,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function page(runId: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>蜂群运行 ${runId.slice(0, 8)}</title>
<style>
:root{--bg:#0b0f14;--panel:#111823;--line:#1f2a37;--text:#e5e7eb;--dim:#8b98a9;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
header{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 16px;padding:14px 20px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:2}
h1{font-size:15px;margin:0;font-weight:600}
h2{font-size:13px;color:var(--dim);font-weight:600;margin:18px 0 8px;text-transform:uppercase;letter-spacing:.06em}
main{max-width:1200px;margin:0 auto;padding:0 20px 40px}
.meta{color:var(--dim);font-size:12.5px;font-family:var(--mono)}
#status{padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;background:#1e293b;color:#94a3b8}
#status[data-state="running"]{background:#0c2d4d;color:#7dd3fc}
#status[data-state="passed"]{background:#12351f;color:#4ade80}
#status[data-state="failed"]{background:#3a1517;color:#f87171}
#status[data-state="stopped"]{background:#3a2a12;color:#fbbf24}
#status[data-state="stale"]{background:#3a2a12;color:#fbbf24}
#banner{margin:12px 20px 0;padding:8px 12px;border:1px solid #7f1d1d;background:#2a1215;color:#fca5a5;border-radius:8px;font-size:13px}
.goal{color:var(--text);font-size:15px;margin-top:14px}
.reason{color:#f87171;font-size:13px;margin-top:4px}
.stats{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:6px 12px;display:flex;flex-direction:column;min-width:92px}
.stat-v{font-size:16px;font-weight:600;font-family:var(--mono)}
.stat-k{font-size:11.5px;color:var(--dim)}
.tasks{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px}
.task{background:var(--panel);border:1px solid var(--line);border-left-width:4px;border-radius:8px;padding:10px 12px}
.task[data-state="running"]{border-left-color:#3b82f6}
.task[data-state="ready"]{border-left-color:#22d3ee}
.task[data-state="passed"]{border-left-color:#22c55e}
.task[data-state="merged"]{border-left-color:#16a34a}
.task[data-state="failed_retryable"]{border-left-color:#f59e0b}
.task[data-state="failed_escalated"]{border-left-color:#ef4444}
.task[data-state="blocked"]{border-left-color:#9f1d2e}
.task[data-state="pending"]{border-left-color:#374151}
.task[data-state="cancelled"]{border-left-color:#374151;opacity:.6}
.task-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.chip{font-size:11px;font-weight:600;color:#0b0f14;border-radius:999px;padding:1px 8px;white-space:nowrap}
.task-id{font-family:var(--mono);font-size:12.5px;color:#7dd3fc}
.task-title{font-weight:500}
.task-meta{color:var(--dim);font-size:12px;margin-top:5px;font-family:var(--mono)}
.task-warn{color:#fbbf24;font-size:12px;margin-top:4px}
.task-fail{color:#fca5a5;font-size:12px;margin-top:4px;white-space:pre-wrap;max-height:80px;overflow:auto}
.timeline{position:relative}
.ticks{position:relative;height:18px;margin-left:188px;color:var(--dim);font-size:11px;font-family:var(--mono)}
.tick{position:absolute;transform:translateX(-50%);top:0;white-space:nowrap}
.tick:first-child{transform:none}
.lane-row{display:grid;grid-template-columns:180px 1fr;gap:8px;align-items:center;margin:5px 0}
.lane-label{font-family:var(--mono);font-size:12px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lane{position:relative;height:22px;background:#0f1620;border-radius:5px}
.bar{position:absolute;top:3px;bottom:3px;border-radius:4px;background:#475569;min-width:3px}
.bar[data-outcome="passed"],.bar[data-outcome="merged"]{background:#22c55e}
.bar[data-outcome="failed_retryable"]{background:#f59e0b}
.bar[data-outcome="failed_escalated"],.bar[data-outcome="blocked"]{background:#ef4444}
.bar[data-outcome="open"]{background:#3b82f6;animation:pulse 1.6s ease-in-out infinite}
@keyframes pulse{50%{opacity:.45}}
.feed{list-style:none;margin:0;padding:0;max-height:420px;overflow:auto;border:1px solid var(--line);border-radius:8px;background:var(--panel)}
.ev{display:flex;gap:10px;padding:5px 12px;border-bottom:1px solid #16202c;font-size:12.5px;align-items:baseline}
.ev:last-child{border-bottom:none}
.ev-time{font-family:var(--mono);color:var(--dim);flex:none}
.ev-type{font-family:var(--mono);flex:none;padding:0 7px;border-radius:4px;background:#1e293b;color:#cbd5e1}
.ev-type[data-cat="bad"]{background:#3a1517;color:#f87171}
.ev-type[data-cat="warn"]{background:#3a2a12;color:#fbbf24}
.ev-type[data-cat="good"]{background:#12351f;color:#4ade80}
.ev-task{font-family:var(--mono);color:#7dd3fc;flex:none}
.ev-detail{color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.empty{color:var(--dim);font-size:13px;padding:8px 0}
@media (max-width:640px){.lane-row{grid-template-columns:110px 1fr}.ticks{margin-left:118px}}
</style>
</head>
<body>
<header>
  <h1>🐝 智能蜂群 <span class="meta" id="run"></span></h1>
  <span id="status">加载中</span>
  <span class="meta" id="meta"></span>
</header>
<div id="banner" hidden></div>
<main>
  <div class="goal" id="goal"></div>
  <div class="reason" id="reason"></div>
  <div class="stats" id="stats"></div>
  <h2>任务</h2>
  <div class="tasks" id="tasks"></div>
  <h2>时间线（每次 attempt）</h2>
  <div class="timeline" id="timeline"></div>
  <h2>事件流</h2>
  <ol class="feed" id="feed"></ol>
</main>
<script>
var STATUS = {
  pending: ['待定', '#6b7280'],
  ready: ['就绪', '#22d3ee'],
  running: ['执行中', '#3b82f6'],
  passed: ['通过', '#22c55e'],
  merged: ['已合并', '#16a34a'],
  failed_retryable: ['失败·待重试', '#f59e0b'],
  failed_escalated: ['失败·已升级', '#ef4444'],
  blocked: ['阻塞', '#9f1d2e'],
  cancelled: ['已取消', '#6b7280']
};
var RUN_LABEL = { running: '运行中', stale: '已失联', passed: '运行通过', failed: '运行失败', stopped: '已停止' };
function el(tag, cls, text) {
  var node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}
function fmtMs(ms) {
  if (ms == null) return '—';
  var s = Math.round(ms / 1000);
  if (s < 60) return s + ' 秒';
  var m = Math.floor(s / 60);
  return m + ' 分 ' + (s % 60) + ' 秒';
}
function fmtTick(ms) {
  if (ms >= 60000) return fmtMs(ms);
  if (ms >= 10000) return Math.round(ms / 1000) + ' 秒';
  return (ms / 1000).toFixed(1) + ' 秒';
}
function fmtNum(n) { return n == null ? '—' : Number(n).toLocaleString('zh-CN'); }
function fmtCost(c) { return c == null ? '未定价' : '$' + c.toFixed(4); }
function fmtClock(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}
function chip(state) {
  var s = STATUS[state] || [state, '#6b7280'];
  var node = el('span', 'chip', s[0]);
  node.style.background = s[1];
  return node;
}
function render(data) {
  document.getElementById('run').textContent = 'run ' + data.runId.slice(0, 8);
  var status = document.getElementById('status');
  status.textContent = RUN_LABEL[data.state] || data.state;
  status.dataset.state = data.state;
  document.getElementById('meta').textContent = '耗时 ' + fmtMs(data.elapsedMs)
    + ' · 输入 ' + fmtNum(data.inputTokens) + ' tokens · 输出 ' + fmtNum(data.outputTokens)
    + ' · 成本 ' + fmtCost(data.estimatedCostUsd)
    + (data.integrationBranch ? ' · 集成分支 ' + data.integrationBranch : '');
  document.getElementById('goal').textContent = data.goal ? data.goal + ' — ' + data.request : data.request;
  document.getElementById('reason').textContent = data.reason || '';
  renderStats(data.stats);
  renderTasks(data.tasks);
  renderTimeline(data);
  renderFeed(data.events);
}
function renderStats(s) {
  var box = document.getElementById('stats');
  box.textContent = '';
  var items = [
    ['Planner 调用', s.plannerCalls],
    ['Worker 调用', s.workerCalls],
    ['验收执行', s.acceptanceRuns],
    ['验收失败', s.acceptanceFailures],
    ['已合并任务', s.merges]
  ];
  Object.keys(s.failures || {}).forEach(function (cls) { items.push(['失败·' + cls, s.failures[cls]]); });
  items.forEach(function (item) {
    var stat = el('div', 'stat');
    stat.appendChild(el('span', 'stat-v', String(item[1])));
    stat.appendChild(el('span', 'stat-k', item[0]));
    box.appendChild(stat);
  });
}
function renderTasks(tasks) {
  var box = document.getElementById('tasks');
  box.textContent = '';
  if (!tasks.length) { box.appendChild(el('div', 'empty', '还没有任务（规划中）')); return; }
  tasks.forEach(function (task) {
    var card = el('div', 'task');
    card.dataset.state = task.state;
    var head = el('div', 'task-head');
    head.appendChild(chip(task.state));
    head.appendChild(el('span', 'task-id', task.id));
    head.appendChild(el('span', 'task-title', task.title));
    card.appendChild(head);
    var meta = '尝试 ' + task.attempts + ' 次 · 用时 ' + fmtMs(task.elapsedMs)
      + ' · ' + fmtNum(task.inputTokens) + '/' + fmtNum(task.outputTokens) + ' tokens'
      + ' · ' + fmtCost(task.estimatedCostUsd)
      + (task.dependsOn.length ? ' · 依赖 ' + task.dependsOn.join(', ') : '');
    card.appendChild(el('div', 'task-meta', meta));
    if (task.escalation) card.appendChild(el('div', 'task-warn', '升级状态：' + task.escalation));
    if (task.failureReason) card.appendChild(el('div', 'task-fail', task.failureReason));
    box.appendChild(card);
  });
}
function renderTimeline(data) {
  var box = document.getElementById('timeline');
  box.textContent = '';
  var start = null;
  var end = null;
  data.tasks.forEach(function (task) {
    task.timeline.forEach(function (att) {
      var s = Date.parse(att.startedAt);
      var e = att.endedAt ? Date.parse(att.endedAt) : Date.parse(data.now);
      if (start == null || s < start) start = s;
      if (end == null || e > end) end = e;
    });
  });
  if (start == null) { box.appendChild(el('div', 'empty', '暂无执行记录')); return; }
  if (data.startedAt) start = Math.min(start, Date.parse(data.startedAt));
  end = Math.max(end, start + 1);
  var span = end - start;
  var ticks = el('div', 'ticks');
  [0, 0.25, 0.5, 0.75, 1].forEach(function (f) {
    var tick = el('span', 'tick', fmtTick(f * span));
    tick.style.left = (f * 100) + '%';
    ticks.appendChild(tick);
  });
  box.appendChild(ticks);
  data.tasks.forEach(function (task) {
    var row = el('div', 'lane-row');
    var label = el('div', 'lane-label', task.id);
    label.title = task.title;
    row.appendChild(label);
    var lane = el('div', 'lane');
    task.timeline.forEach(function (att) {
      var s = Date.parse(att.startedAt);
      var e = att.endedAt ? Date.parse(att.endedAt) : Date.parse(data.now);
      var bar = el('div', 'bar');
      bar.style.left = ((s - start) / span * 100) + '%';
      bar.style.width = Math.max((e - s) / span * 100, 0.3) + '%';
      bar.dataset.outcome = att.endedAt ? (att.outcome || '') : 'open';
      bar.title = 'attempt ' + att.attempt + ' · ' + att.role + ' · ' + fmtClock(att.startedAt)
        + (att.endedAt ? ' → ' + fmtClock(att.endedAt) + '（' + (att.outcome || '') + '）' : ' → 执行中');
      lane.appendChild(bar);
    });
    row.appendChild(lane);
    box.appendChild(row);
  });
}
function category(type) {
  if (type === 'failure' || type === 'scope_violation' || type === 'merge_conflict') return 'bad';
  if (type === 'escalated_to_planner' || type === 'plan_rejected' || type === 'retry_scheduled') return 'warn';
  if (type === 'task_state_changed' || type === 'run_started' || type === 'run_finished' || type === 'plan_accepted' || type === 'recovered') return 'good';
  return 'dim';
}
function renderFeed(events) {
  var feed = document.getElementById('feed');
  feed.textContent = '';
  events.slice().reverse().forEach(function (event) {
    var li = el('li', 'ev');
    li.appendChild(el('span', 'ev-time', fmtClock(event.ts)));
    var type = el('span', 'ev-type', event.type);
    type.dataset.cat = category(event.type);
    li.appendChild(type);
    if (event.taskId) li.appendChild(el('span', 'ev-task', event.taskId));
    if (event.detail) li.appendChild(el('span', 'ev-detail', event.detail));
    feed.appendChild(li);
  });
}
function setBanner(message) {
  var banner = document.getElementById('banner');
  banner.hidden = !message;
  banner.textContent = message ? '无法连接事件服务：' + message + '（自动重试中）' : '';
}
async function refresh() {
  try {
    var response = await fetch('/api/run', { cache: 'no-store' });
    var data = await response.json();
    if (!response.ok) throw new Error(data.error || ('HTTP ' + response.status));
    render(data);
    setBanner('');
  } catch (error) {
    setBanner(error.message);
  }
}
refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>
`;
}

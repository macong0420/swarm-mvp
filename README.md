# Swarm

[English](#english) · [中文](#中文)

Swarm is a local-first CLI for planning and executing coding tasks in parallel Git worktrees. A planner splits a request into a task DAG, workers run the tasks concurrently, acceptance commands gate each result, and what passes is merged into an integration branch that you review and merge yourself.

> **Security / 安全**
> Swarm runs model-generated commands as your user. It is **not an OS sandbox**. Run it only against repositories you trust, preferably inside the included Docker image or a VM. Review the integration branch before merging. See [SECURITY.md](SECURITY.md).
>
> Swarm 会以你的用户身份执行模型生成的命令，**不是操作系统沙箱**。只对可信仓库运行，推荐使用 Docker/VM；合并前务必审查集成分支。详见 [SECURITY.md](SECURITY.md)。

Status: `0.1.0` alpha · Linux/macOS supported · Windows experimental · MIT license.

---

## English

### Why Swarm

A single coding agent works one step at a time. Swarm turns a request into independent tasks, runs them in parallel in isolated worktrees, and verifies each one with real commands before anything is merged. The planner is the commander (指挥); workers do the work (干活); you can route different kinds of tasks to different models and budgets.

### Features

- **Plan before you spend.** `swarm plan` produces a reviewable task DAG; `swarm run --plan` executes an approved plan without calling the planner again.
- **Visual configuration.** `swarm config` opens a local page for the planner/worker models, per-task-kind routes, integration-fix model, budgets (`maxTurns`, tokens, wall clock), command policy, pricing and API keys.
- **Multiple providers and keys.** Planner, worker, integration fix and each task route can use a different provider, endpoint, model and `apiKeyEnv`.
- **Isolated attempts.** Every attempt gets its own worktree and branch; file writes are checked against `writeScope`; a lease and fencing decide which attempt may settle a task.
- **Real verification.** Task and global acceptance commands run in the worktree with the project's dependencies linked. Baseline acceptance distinguishes regressions from failures that were already there.
- **Recovery.** Transient retries, logic retries, scope-violation salvage, `retry_with` model escalation, split/implement/abandon escalation, resume of failed/stopped runs, `--max-cost`.
- **Integration safety.** Dependency-ordered merges, conflict resolution with retries, an integration diff guard, optional post-fix verification, and partial delivery when only some tasks pass.
- **Event-sourced state.** One append-only SQLite log drives `status`, `runs`, `logs`, `viz`, replay and resume.
- **Local-only.** No telemetry; keys are read from the environment or `.swarm/.env`, never written to the config or event log.

### Requirements

- Node.js 20+
- Git
- Linux or macOS (Windows is experimental; use WSL2 or Docker)
- A model endpoint: Anthropic Messages API or any OpenAI-compatible chat-completions endpoint

### Install

```sh
npm install -g swarm-mvp
# or run without installing:
npx swarm-mvp --help
```

From a checkout:

```sh
git clone https://github.com/macong0420/swarm-mvp.git
cd swarm-mvp
npm install
npm run build
npm link        # optional: makes `swarm` available globally
```

### Quickstart

Run from the repository you want to change. It must be a Git repository with at least one commit; uncommitted changes are included via a snapshot and are never modified.

```sh
cd your-repo
swarm init                 # writes .swarm/config.json and ignores .swarm/
swarm config               # local page: models, routes, budgets, API keys
swarm plan "add a slugify helper with tests" > plan.json
# review plan.json, then execute it as approved:
swarm run "add a slugify helper with tests" --plan plan.json
swarm status
swarm viz                  # live read-only page at http://127.0.0.1:7777
```

Try the scripted smoke run without a model:

```sh
swarm run "smoke test" --dry-run
```

The result is a branch such as `swarm/<runId>/integration`. Swarm never merges it into your branches; review the diff and merge it yourself.

### Visual configuration

`swarm config [--port 7788]` starts a page bound to `127.0.0.1`. It edits the current repository's `.swarm/config.json`, keeps a `.bak`, and validates before writing.

- **Planner (指挥)** — provider, endpoint, model, fallback, key variable, output/effort, repository-inspection limits.
- **Worker (干活)** — default worker model and endpoint.
- **Task routes** — per kind (`implement`, `test`, `refactor`, `docs`, `investigate`): model, fallback, endpoint, key variable, `maxTurns`, `maxTokens`, `maxWallSec`.
- **Integration fix** — model and budget for merge-conflict and global-acceptance repairs.
- **Budgets and retries** — concurrency, logic/plan/transient retries, backoff, heartbeat, lease, task budgets, run cost, baseline policy, worktree/branch retention.
- **Command policy** — allowed executables, denied substrings, extra environment variables, timeout and output limit.
- **Pricing** — per model, input/output per million tokens.
- **API keys** — see below.
- **Check configuration** — runs the same preflight as `swarm doctor` without calling a model.

Common endpoint presets (Anthropic, OpenAI, DeepSeek, Ollama, a local gateway) fill the provider, endpoint and key variable; you still type the model name your provider uses.

### Models, routes and API keys

The planner is the commander; workers do the work. They do not have to share a model or a key.

```json
{
  "planner": {
    "provider": "anthropic",
    "baseURL": "https://api.anthropic.com",
    "model": "your-planner-model",
    "apiKeyEnv": "ANTHROPIC_API_KEY"
  },
  "worker": {
    "provider": "openai",
    "baseURL": "https://api.deepseek.com/v1",
    "model": "your-worker-model",
    "apiKeyEnv": "DEEPSEEK_API_KEY",
    "routes": {
      "test": { "model": "your-test-model", "maxTurns": 40, "apiKeyEnv": "OPENAI_API_KEY" }
    }
  },
  "integration": { "model": "your-fix-model", "maxTurns": 30 },
  "pricing": {
    "your-planner-model": { "inputPerMillion": 0, "outputPerMillion": 0 },
    "your-worker-model": { "inputPerMillion": 0, "outputPerMillion": 0 }
  }
}
```

- `apiKeyEnv` stores a **variable name**, not the key. The value comes from the shell or from `.swarm/.env`.
- The config page can store keys in `.swarm/.env` (mode `0600`, git-ignored). Shell environment variables win.
- Keys are never written to `.swarm/config.json` or the event log; known key values are redacted from event payloads.
- `swarm config` lists every referenced key variable plus every key already in `.swarm/.env`, labels which role/route uses it, and lets you add arbitrary keys.
- For CI, export the variables; do not commit `.swarm/.env`.
- A model without a `pricing` entry counts as free; the run summary warns when the cost guard cannot price a model.

### How a run works

1. **Snapshot.** If the working tree differs from `HEAD`, Swarm freezes it into a commit (tracked files, uncommitted changes, line endings preserved; `.swarm/` excluded) without touching `HEAD`, the index or your files.
2. **Plan.** The planner sees a capped file list, package manifests, the README and `AGENTS.md`/`CLAUDE.md`, and may inspect files with read-only tools. The plan is validated by code: schema, cycles, write-scope overlap, estimates, acceptance commands and required files.
3. **Baseline.** Global acceptance runs once on the base commit, so integration can tell a regression from a failure that was already there.
4. **Workers.** Ready tasks run in parallel, each in a worktree that already contains its dependencies. Workers use `read_file`, `edit_file`, `write_file`, `delete_file`, `list_dir`, allowlisted commands and `finish`.
5. **Gates.** Acceptance commands run in the attempt worktree; the scheduler checks the diff against `writeScope` and commits only for the attempt holding the lease.
6. **Failures.** Transient errors retry with backoff; logic failures retry with the previous failure; scope violations keep in-scope work and reset only the out-of-scope files; exhausted tasks escalate to split, implement, retry with a stronger model, or abandon.
7. **Integration.** Passed branches merge in dependency order into `swarm/<runId>/integration`. Conflicts are resolved by the planner with retries; a diff guard rejects files outside every task's write scope; global acceptance runs; a failed global check gets bounded fix attempts and a post-fix verification.
8. **Delivery.** The run prints the integration branch and the `git merge` command. If only some tasks pass, the passed ones are still integrated into a partial branch.

State lives in `.swarm/events.sqlite` (append-only). `status`, `runs`, `logs`, `viz` and `resume` all replay the same events.

### CLI

| Command | Purpose |
| --- | --- |
| `swarm init` | Create `.swarm/config.json`, ignore `.swarm/`. |
| `swarm config [--port 7788]` | Visual configuration page. |
| `swarm plan "<request>"` | Plan only; prints the plan JSON and planning cost. |
| `swarm run "<request>" [--plan file] [--dry-run] [--max-concurrency N] [--max-cost USD] [--json]` | Execute a new run. |
| `swarm run --resume <runId> [--max-cost USD]` | Continue or retry a failed/stopped run. |
| `swarm retry <runId> [--max-cost USD]` | Shortcut for resuming a failed/stopped run. |
| `swarm runs [--json]` | List runs, including `stale` ones. |
| `swarm status [runId] [--json]` | Run and per-task summary, including `@integration` costs. |
| `swarm logs [runId] [--task id] [--type event]` | Raw event log. |
| `swarm viz [runId] [--port 7777]` | Live read-only run page. |
| `swarm cleanup` | Remove expired worktrees/branches and opted-in finished branches. |
| `swarm doctor [--json]` | Preflight: Git, Node, config, keys, pricing, dependencies, commands. |

`Ctrl+C` cancels a running run: workers are killed, tasks are cancelled, and the run finishes as `stopped` so it can be resumed. `--json` is available on the reporting commands.

Full command and flag reference: [docs/cli.md](docs/cli.md).

### Real-repository checklist

- Plan first; review the acceptance commands. Include the repository's real gates (`lint`, `type-check`, the installed test runner), not only the new tests.
- Set `worktree.linkNodeModules: true` when `node_modules` is git-ignored; task and integration worktrees then share dependencies.
- Pass package-manager cache variables through `commandPolicy.env` (for example `COREPACK_HOME`, `PNPM_HOME`); commands run with a scratch `HOME`.
- The base commit includes uncommitted changes. `run_started.baseDiff` lists what the snapshot changed or deleted; commit or stash unrelated changes before merging.
- Do not merge an integration branch blindly. Review `git diff <your-branch> swarm/<runId>/integration` first.
- Keep lint fixes targeted. Acceptance should reject a blanket `/* eslint-disable */`; name the rule when suppression is unavoidable.
- Watch `@integration` / `@merge-*` rows in `swarm status`; integration fixes can be the most expensive model calls.
- Set `keepBranchesMinutes` for long-lived repositories; `0` keeps passed branches forever.
- A run whose scheduler process is gone shows as `stale`; resume it or start a new run.

### Docker

The container is the recommended isolation boundary: the CLI, workers, commands and worktrees all run inside it.

```sh
docker build -t swarm-mvp .
docker run --rm -it -v "$PWD:/work" -w /work \
  -e ANTHROPIC_API_KEY \
  swarm-mvp run "smoke test" --dry-run
```

Mount the repository (including `.git`) and pass the key variables your config names. Add `worktree.linkNodeModules: true` when the mounted repository has `node_modules`.

### Security model

- Commands are plain argv, without a shell; executables must be in `commandPolicy.allow`; shell operators are refused; each command has a timeout and output limit.
- The default deny list blocks `push`, `reset --hard`, `clean -fd`, `remote` and `install`. Extend it for your environment.
- File tools reject path traversal and symlinks that escape the worktree; writes are checked against `writeScope`.
- Worker commands receive a small environment allowlist plus `commandPolicy.env`; the model key is not passed to commands.
- Keys are stored in the shell or `.swarm/.env` (`0600`), not in the config or event log; known key values are redacted from event payloads.
- The config page binds to `127.0.0.1`; write/check endpoints require a per-session token.
- **None of this is an OS sandbox.** A trusted executable such as `npm` or `pnpm` can run arbitrary project code. Use Docker or a VM for untrusted repositories.

### Development

```sh
npm install
npm run build
npm run typecheck
npm test
npm run e2e
npm run coverage
npm run pack:check
```

The test suite covers the scheduler, worktrees, command policy, event replay, resume, integration, baseline, configuration page, key storage and failure paths. CI runs Linux/macOS on Node 20/22/24; Windows is an experimental job. See [CONTRIBUTING.md](CONTRIBUTING.md).

### Documentation

- [docs/architecture.md](docs/architecture.md) — layers, scheduling, recovery, integration.
- [docs/events.md](docs/events.md) — append-only event dictionary.
- [docs/config.md](docs/config.md) — every configuration field and key handling.
- [docs/cli.md](docs/cli.md) — commands, flags, exit codes.
- [docs/troubleshooting.md](docs/troubleshooting.md) — common failures.
- [docs/release.md](docs/release.md) — packaging and publishing.
- [ROADMAP.md](ROADMAP.md) — what is done and what is next.

### Limitations and roadmap

- The OpenAI-compatible adapter is non-streaming; Anthropic streaming is opt-in.
- Context compaction shortens old messages but does not reset the cumulative task token budget.
- Incremental integration, distributed workers and automatic PR creation are not implemented.
- Windows is experimental; use WSL2 or Docker.
- The command allowlist is not an OS sandbox.

### License

MIT. See [LICENSE](LICENSE).

---

## 中文

### 为什么用 Swarm

单个编码代理一次只能做一步。Swarm 把一个需求拆成有依赖关系的任务 DAG，在隔离的 Git worktree 里并行执行，每个任务都必须通过真实命令验收后才进入集成分支。Planner 负责“指挥”，Worker 负责“干活”；不同任务类型可以路由到不同模型和预算。

### 功能

- **先看计划再花钱。** `swarm plan` 产出可审阅的任务 DAG；`swarm run --plan` 执行已批准的计划，不再调用 planner。
- **可视化配置。** `swarm config` 打开本地配置页：指挥/干活模型、按任务类型的路由、集成修复模型、`maxTurns`/token/墙钟预算、命令策略、定价和 API key。
- **多供应商、多 key。** Planner、Worker、集成修复和每个任务路由都可以使用不同的 provider、endpoint、模型和 `apiKeyEnv`。
- **隔离执行。** 每次 attempt 有独立 worktree 和分支；文件写入受 `writeScope` 校验；lease + fencing 决定哪个 attempt 可以结算任务。
- **真实验收。** 任务和全局验收命令在链接了依赖的 worktree 中运行；基线验收区分“回归”和“仓库原本就失败”。
- **可恢复。** 临时重试、逻辑重试、scope violation 保留范围内成果、`retry_with` 换更强模型、split/implement/abandon 升级、失败/停止的 run 可 resume、`--max-cost`。
- **集成安全。** 按依赖顺序合并、冲突修复可重试、集成 diff 守卫、修复后可选复验、部分任务失败时仍交付已通过的部分。
- **事件溯源。** 只追加的 SQLite 事件日志驱动 `status`、`runs`、`logs`、`viz`、replay 和 resume。
- **本地优先。** 没有遥测；key 只从环境变量或 `.swarm/.env` 读取，不写入 config 或事件日志。

### 环境要求

- Node.js 20+
- Git
- Linux 或 macOS（Windows 实验性，建议 WSL2 或 Docker）
- 模型端点：Anthropic Messages API，或任意 OpenAI 兼容 chat-completions 端点

### 安装

```sh
npm install -g swarm-mvp
# 或直接运行：
npx swarm-mvp --help
```

从源码：

```sh
git clone https://github.com/macong0420/swarm-mvp.git
cd swarm-mvp
npm install
npm run build
npm link        # 可选：全局安装 `swarm`
```

### 快速开始

在要修改的仓库里运行。仓库必须有至少一个 commit；未提交改动会通过快照包含进来，但你的文件不会被修改。

```sh
cd your-repo
swarm init                 # 生成 .swarm/config.json，并忽略 .swarm/
swarm config               # 本地页面：模型、路由、预算、API key
swarm plan "add a slugify helper with tests" > plan.json
# 审阅 plan.json 后，按已批准计划执行：
swarm run "add a slugify helper with tests" --plan plan.json
swarm status
swarm viz                  # 实时只读页面 http://127.0.0.1:7777
```

不调用模型的脚本化冒烟：

```sh
swarm run "smoke test" --dry-run
```

结果是 `swarm/<runId>/integration` 分支。Swarm 不会自动合并到你的分支；请先审阅 diff，再自己合并。

### 可视化配置

`swarm config [--port 7788]` 启动一个只绑定 `127.0.0.1` 的页面。它编辑当前仓库的 `.swarm/config.json`，保存前自动校验，并保留 `.bak`。

- **指挥模型 / Planner**：provider、endpoint、model、fallback、key 变量、输出/effort、仓库检查限制。
- **干活模型 / Worker**：默认 worker 模型和端点。
- **任务路由**：按 `implement`、`test`、`refactor`、`docs`、`investigate` 分别配置模型、fallback、端点、key 变量、`maxTurns`、`maxTokens`、`maxWallSec`。
- **集成修复**：合并冲突和全局验收修复的模型与预算。
- **预算与重试**：并发、逻辑/计划/临时重试、退避、心跳、租约、任务预算、运行成本、基线策略、worktree/分支保留。
- **命令策略**：允许的可执行文件、拒绝子串、额外环境变量、超时、输出上限。
- **定价**：按模型配置每百万 token 的输入/输出价格。
- **API key**：见下一节。
- **检查配置**：执行与 `swarm doctor` 相同的预检，不调用模型。

常用端点预设（Anthropic、OpenAI、DeepSeek、Ollama、本地网关）会填入 provider、endpoint 和 key 变量名；模型名仍按供应商填写。

### 模型、路由与 API key

Planner 是指挥，Worker 是干活；它们不必共用模型或 key。

```json
{
  "planner": {
    "provider": "anthropic",
    "baseURL": "https://api.anthropic.com",
    "model": "your-planner-model",
    "apiKeyEnv": "ANTHROPIC_API_KEY"
  },
  "worker": {
    "provider": "openai",
    "baseURL": "https://api.deepseek.com/v1",
    "model": "your-worker-model",
    "apiKeyEnv": "DEEPSEEK_API_KEY",
    "routes": {
      "test": { "model": "your-test-model", "maxTurns": 40, "apiKeyEnv": "OPENAI_API_KEY" }
    }
  },
  "integration": { "model": "your-fix-model", "maxTurns": 30 },
  "pricing": {
    "your-planner-model": { "inputPerMillion": 0, "outputPerMillion": 0 },
    "your-worker-model": { "inputPerMillion": 0, "outputPerMillion": 0 }
  }
}
```

- `apiKeyEnv` 只存**变量名**，不存 key 值；值来自 shell 环境或 `.swarm/.env`。
- 配置页可以把 key 写入 `.swarm/.env`（权限 `0600`，git 忽略）；shell 环境变量优先。
- key 不会写入 `.swarm/config.json` 或事件日志；已知 key 值会在事件 payload 中脱敏。
- 配置页会列出所有被引用的 key 变量，以及 `.swarm/.env` 里已有的全部 key（未引用的标为“未引用”），并标注每个变量被哪个角色/路由使用；也可以手动添加任意 key。
- CI 里直接 export 环境变量；不要提交 `.swarm/.env`。
- 没有 `pricing` 条目的模型按免费处理；运行摘要会在成本闸门无法计价时告警。

### 一次 run 的流程

1. **快照。** 工作区与 `HEAD` 不同时，Swarm 把它冻结成一个 commit（已跟踪文件、未提交改动、保留行尾；排除 `.swarm/`），不碰 `HEAD`、索引或你的文件。
2. **规划。** Planner 看到受限文件列表、包清单、README、`AGENTS.md`/`CLAUDE.md`，可用只读工具检查仓库。计划由代码校验：schema、环、writeScope 重叠、估算、验收命令、所需文件。
3. **基线。** 在 base commit 上先跑一次全局验收，集成时区分回归和原有失败。
4. **执行。** 就绪任务并行运行，每个 worktree 已包含其依赖。Worker 使用 `read_file`、`edit_file`、`write_file`、`delete_file`、`list_dir`、白名单命令和 `finish`。
5. **验收。** 验收命令在 attempt worktree 中运行；调度器按 `writeScope` 检查 diff，只对持有 lease 的 attempt 提交。
6. **失败处理。** 临时错误退避重试；逻辑失败带上次失败重试；scope violation 保留范围内成果，只重置越界文件；重试耗尽后升级为 split、implement、换更强模型重试或 abandon。
7. **集成。** 通过的任务按依赖顺序合并到 `swarm/<runId>/integration`；冲突由 planner 修复并可重试；diff 守卫拒绝任何任务 writeScope 之外的文件；全局验收失败时有界修复并复验。
8. **交付。** run 输出集成分支和 `git merge` 命令；只有部分任务通过时，已通过的任务仍会进入 partial 分支。

状态在 `.swarm/events.sqlite`（只追加）；`status`、`runs`、`logs`、`viz`、resume 都回放同一份事件。

### 命令

| 命令 | 用途 |
| --- | --- |
| `swarm init` | 创建 `.swarm/config.json`，忽略 `.swarm/`。 |
| `swarm config [--port 7788]` | 可视化配置页。 |
| `swarm plan "<需求>"` | 只规划；输出计划 JSON 和规划成本。 |
| `swarm run "<需求>" [--plan file] [--dry-run] [--max-concurrency N] [--max-cost USD] [--json]` | 执行新 run。 |
| `swarm run --resume <runId> [--max-cost USD]` | 继续或重试失败/停止的 run。 |
| `swarm retry <runId> [--max-cost USD]` | resume 失败/停止 run 的快捷方式。 |
| `swarm runs [--json]` | 列出 run（包括 `stale`）。 |
| `swarm status [runId] [--json]` | run 和任务摘要，包括 `@integration` 成本。 |
| `swarm logs [runId] [--task id] [--type event]` | 原始事件日志。 |
| `swarm viz [runId] [--port 7777]` | 实时只读运行页面。 |
| `swarm cleanup` | 清理过期 worktree/分支和按配置回收的完成分支。 |
| `swarm doctor [--json]` | 预检 Git、Node、配置、key、定价、依赖和命令。 |

`Ctrl+C` 会取消正在执行的 run：杀掉 worker、取消任务，run 以 `stopped` 结束，之后可以 resume。报告类命令支持 `--json`。

完整命令和参数见 [docs/cli.md](docs/cli.md)。

### 真实仓库清单

- 先 `plan`，审阅验收命令。必须包含仓库真实门禁（`lint`、`type-check`、已安装的测试框架），不能只跑新测试。
- `node_modules` 被 git 忽略时设置 `worktree.linkNodeModules: true`，任务和集成 worktree 会共享依赖。
- 通过 `commandPolicy.env` 放行包管理器缓存变量（如 `COREPACK_HOME`、`PNPM_HOME`），因为命令使用临时 `HOME`。
- base commit 包含未提交改动；`run_started.baseDiff` 会列出快照相对 HEAD 的变更/删除。合并前先提交或 stash 无关改动。
- 不要盲目合并集成分支；先看 `git diff <your-branch> swarm/<runId>/integration`。
- lint 修复要针对性；验收应拒绝全量 `/* eslint-disable */`，必须禁用时写明规则。
- 关注 `swarm status` 里的 `@integration`/`@merge-*` 行；集成修复可能是最贵的模型调用。
- 长期仓库设置 `keepBranchesMinutes`；`0` 表示永久保留通过分支。
- 调度进程已消失的 run 显示为 `stale`；可以 resume 或重新开 run。

### Docker

容器是推荐的隔离边界：CLI、worker、命令和 worktree 都在容器内运行。

```sh
docker build -t swarm-mvp .
docker run --rm -it -v "$PWD:/work" -w /work \
  -e ANTHROPIC_API_KEY \
  swarm-mvp run "smoke test" --dry-run
```

挂载仓库（包括 `.git`），传入配置里使用的 key 变量。挂载仓库有 `node_modules` 时建议设置 `worktree.linkNodeModules: true`。

### 安全模型

- 命令是纯 argv，不经过 shell；可执行文件必须在 `commandPolicy.allow` 中；拒绝 shell 操作符；每条命令有超时和输出上限。
- 默认 deny 列表阻止 `push`、`reset --hard`、`clean -fd`、`remote`、`install`；按环境自行扩展。
- 文件工具拒绝路径穿越和逃出 worktree 的符号链接；写入受 `writeScope` 校验。
- Worker 命令只拿到很小的环境变量白名单加 `commandPolicy.env`；模型 key 不会传给命令。
- key 存在 shell 或 `.swarm/.env`（`0600`），不写入 config/事件日志；已知 key 值会脱敏。
- 配置页只绑定 `127.0.0.1`；写/检查接口需要页面内嵌的会话 token。
- **这些都不是操作系统沙箱。** `npm`/`pnpm` 等可信可执行文件仍可运行任意项目代码；不可信仓库请用 Docker 或 VM。

### 开发

```sh
npm install
npm run build
npm run typecheck
npm test
npm run e2e
npm run coverage
npm run pack:check
```

测试覆盖调度器、worktree、命令策略、事件回放、resume、集成、基线、配置页、key 存储和失败路径。CI 在 Linux/macOS 上跑 Node 20/22/24；Windows 是实验性 job。见 [CONTRIBUTING.md](CONTRIBUTING.md)。

### 文档

- [docs/architecture.md](docs/architecture.md) — 分层、调度、恢复、集成。
- [docs/events.md](docs/events.md) — 只追加事件字典。
- [docs/config.md](docs/config.md) — 全部配置字段和 key 处理。
- [docs/cli.md](docs/cli.md) — 命令、参数、退出码。
- [docs/troubleshooting.md](docs/troubleshooting.md) — 常见故障。
- [docs/release.md](docs/release.md) — 打包与发布。
- [ROADMAP.md](ROADMAP.md) — 已完成与后续计划。

### 限制与路线图

- OpenAI 兼容 adapter 仍是非流式；Anthropic 流式是可选开启。
- 上下文压缩只缩短旧消息，不会重置任务累计 token 预算。
- 增量集成、分布式 worker、自动创建 PR 尚未实现。
- Windows 为实验性；建议 WSL2 或 Docker。
- 命令白名单不是操作系统沙箱。

### 许可证

MIT，见 [LICENSE](LICENSE)。

# CLI reference

Install globally (`npm i -g swarm-mvp`) or run from a checkout (`npm run swarm -- ...`). Every command runs against the Git repository containing the current directory.

## `swarm init`

Creates `.swarm/config.json` with every option at its default and adds `.swarm/` to `.gitignore`. Refuses to overwrite an existing config.

## `swarm config [--port 7788]`

Starts a local configuration page at `http://127.0.0.1:7788` (change it with `--port`). Edit the planner (指挥) model, the worker (干活) model, per-task-kind routes, the integration-fix model, max turns/tokens/wall-clock budgets, concurrency, command policy and pricing. The **密钥 / API keys** section writes keys to `.swarm/.env` (0600, git-ignored), never to the config or event log; shell environment variables win. **保存** writes `.swarm/config.json` (keeping a `.bak`); **检查配置** runs the same preflight as `swarm doctor` without calling a model. The page is bound to `127.0.0.1` and the write endpoints require a per-session token.

## `swarm plan "<request>"`

Asks the planner for a plan without creating a run. Prints the plan JSON to stdout and the estimated planning cost to stderr. `--json` prints `{ plan, estimatedCostUsd }`.

## `swarm run "<request>" [options]`

Plans (unless a plan is supplied) and executes the task DAG.

| Flag | Meaning |
| --- | --- |
| `--plan <file>` | Execute an approved plan (bare Plan or the `plan --json` wrapper) without calling the planner. |
| `--dry-run` | Use scripted models: three tasks, two parallel, one dependent. |
| `--resume <runId>` | Continue an unfinished run, or retry a run that finished `failed`/`stopped`. |
| `--max-concurrency N` | Override `maxConcurrency` for this run. |
| `--max-cost USD` | Override `run.maxCostUsd`; on resume, raise the recorded budget. |
| `--json` | Print the full `RunResult` as JSON. |

Exit code is `0` only for a passed run. `Ctrl+C` aborts the run: running workers are killed, their tasks are cancelled, and the run finishes as `stopped` so it can be resumed.

## `swarm retry <runId> [--max-cost USD]`

Resume a run that finished `failed` or `stopped`; equivalent to `run --resume` with a shorter command.

## `swarm runs [--json]`

List runs in event-log order with state, tokens and estimated cost. A run whose scheduler process is gone is shown as `stale`.

## `swarm status [runId] [--json]`

Run summary and per-task rows. `@integration` and `@merge-*` rows show the cost of integration fixes, which are not plan tasks.

## `swarm logs [runId] [--task <id>] [--type <event>] [--json]`

Raw event log, filtered by run, task and type. See `docs/events.md`.

## `swarm viz [runId] [--port 7777]`

Read-only local page that polls the event log every 2 seconds. Serves the latest run unless a run id is given.

## `swarm cleanup [--json]`

Remove expired failed worktrees/branches and, when `keepBranchesMinutes` is set, branches of finished runs. Never touches your branches.

## `swarm doctor [--json]`

Preflight: Git, Node, config parsing, key variables, model names, pricing coverage, `node_modules` and allowed executables. It does not call the model.

## Configuration

See `docs/config.md`. The config is strict JSON at `.swarm/config.json`; a run records its effective configuration in `run_started` and a resumed run keeps that snapshot.

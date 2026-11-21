# Troubleshooting

## `environment variable ... is not set`

Set the variable named by `planner.apiKeyEnv` / `worker.apiKeyEnv` (and any route's `apiKeyEnv`) before running. Keys are never written to the config. The easiest local option is `swarm config` → **密钥 / API keys**, which writes `.swarm/.env` (0600, git-ignored); a shell environment variable still wins. In CI, export the variable.

## 401 / 403 from a gateway

The key is valid for a different route or the gateway rejected the model. Check `baseURL`, the model name and whether the gateway serves the Anthropic or OpenAI-compatible format. `swarm doctor` checks presence, not credentials.

## `command is not allowed`

Add the executable to `commandPolicy.allow`. Do not add a shell; commands are plain argv text. If you need quoted arguments, use single or double quotes; pipes, redirects and semicolons are refused.

## `eslint`/test command not found in a worktree

Set `worktree.linkNodeModules: true` when `node_modules` is git-ignored. Task and integration worktrees then share the installed dependencies. For pnpm/Corepack, pass `COREPACK_HOME` and `PNPM_HOME` through `commandPolicy.env` so the scratch `HOME` does not trigger a download.

## Lint passes locally but the run fails

The plan's acceptance did not include the repository's lint/type-check command. Re-plan with `swarm plan` and include a lint check that covers the changed files; the planner prompt asks for it, but review the plan.

## Merge conflict

The planner resolves conflicted files in the integration worktree and retries up to `maxLogicRetries` times. If it cannot, the run fails with the conflicted file list. Resolve it by hand on the task branch or split the tasks so their write scopes do not overlap.

## Cost guard stopped the run

`swarm status` shows the estimated cost. Raise the budget with `swarm run --resume <runId> --max-cost <usd>`. A model with no `pricing` entry counts as free and will make the guard ineffective; the run summary warns when that happens.

## Run shows `stale`

The scheduler process recorded in the event log is gone. Resume it (`swarm run --resume <runId>`) or start a new run. Stale attempts are reclaimed after their lease expires.

## The integration branch contains unexpected changes

The base commit is your working tree, uncommitted changes included. `run_started.baseDiff` lists what the snapshot changed or deleted. Commit or stash unrelated changes before running, and review `git diff <your-branch> swarm/<runId>/integration` before merging. The snapshot guard refuses to run if a tracked file still present in the working tree disappears from the snapshot.

## Windows

Windows is experimental. `npm`/`pnpm` are `.cmd` shims, `node_modules` symlinks may need developer mode, and signal handling differs. Use WSL2 or Docker on Windows until the Windows CI job is green.

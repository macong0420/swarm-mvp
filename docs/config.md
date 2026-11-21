# Configuration

`swarm init` writes `.swarm/config.json` with every option at its default and adds `.swarm/` to `.gitignore` if it is missing. The file is strict JSON and is validated on load. `swarm config` opens a local page for the same file: planner/worker models, per-kind routes, integration-fix model, budgets, command policy and pricing. A run records its effective configuration in `run_started`; a resumed run keeps using that snapshot.

| Field | Default | Meaning |
| --- | --- | --- |
| `planner.provider` | `anthropic` | `anthropic` (Messages API) or `openai` (any OpenAI-compatible chat completions endpoint). |
| `planner.baseURL` / `model` / `apiKeyEnv` | `https://api.anthropic.com` / empty / `ANTHROPIC_API_KEY` | Planner endpoint, model name, and the name of the environment variable holding the key. `model` must be set before a real run. |
| `planner.maxOutputTokens` / `reasoningEffort` | 16000 / unset | Output cap per planner call; optional effort level, sent only when set. |
| `planner.maxToolTurns` | 8 | Repository inspection turns (`list_dir`, `read_file`, `search`) the planner gets before it must answer. 0 disables inspection. |
| `planner.maxReadLines` / `maxSearchHits` | 400 / 50 | Line cap per planner file read and match cap per search. |
| `worker.provider` / `baseURL` / `model` / `apiKeyEnv` | `openai` / empty / empty / `DEEPSEEK_API_KEY` | Worker adapter (`openai` for any OpenAI-compatible endpoint, or `anthropic`), endpoint, model name, key variable. For OpenAI-compatible endpoints include the `/v1` path. `baseURL` and `model` must be set before a real run. |
| `worker.maxOutputTokens` / `reasoningEffort` | unset / unset | Sent only when set; an Anthropic worker falls back to `planner.maxOutputTokens` when `maxOutputTokens` is unset. |
| `worker.maxReadLines` | 2000 | Hard cap on lines returned by one `read_file`; larger files need `startLine`/`maxLines`. |
| `worker.routes` | `{}` | Per task `kind` (`implement`, `test`, `refactor`, `docs`, `investigate`): `provider`, `model`, `fallbackModel`, `baseURL`, `apiKeyEnv`, `maxOutputTokens`, `reasoningEffort`, `maxTurns`, `maxTokens`, `maxWallSec`. Each field overrides the worker/task default for tasks of that kind; unknown kinds use the defaults. |
| `planner.fallbackModel` / `worker.fallbackModel` / `routes.*.fallbackModel` | unset | A second model on the same provider and endpoint, used when the primary call fails with a final (non-transient) error. Transient errors still go through the task retry policy. |
| `modelCall.timeoutSec` / `maxRetries` | 300 / 3 | Per-request timeout and the SDK's automatic retries (rate limits, 5xx, connection errors) before the call counts as a transient failure. |
| `modelCall.stream` | `false` | Use the Anthropic streaming API and wait for the final message. The OpenAI-compatible adapter remains non-streaming. |
| `modelCall.cacheSystemPrompt` | `false` | Mark the Anthropic system prompt as ephemeral cacheable. Opt-in because gateways differ in their prompt-cache support. |
| `maxConcurrency` | 4 | Tasks running at once. `swarm run --max-concurrency N` overrides it for one run. |
| `maxLogicRetries` | 2 | Retries after logic or scope failures before the task is escalated to the planner. Also the number of extra attempts for a global-acceptance fix. |
| `maxTransientRetries` | 5 | Retries after transient failures before escalation. |
| `retryBaseMs` | 1000 | First transient backoff; doubles with each transient failure of the task. |
| `maxPlanRetries` | 3 | Times a rejected plan or escalation decision is sent back to the planner. |
| `heartbeatSec` | 15 | Worker heartbeat interval. Keep it well below `leaseSec`. |
| `leaseSec` | 60 | How long an attempt stays valid without a heartbeat. |
| `task.maxTurns` | 20 | Model turns per attempt. |
| `task.maxTokens` | 30000 | Input plus output tokens per attempt. |
| `task.maxWallSec` | 900 | Wall-clock seconds per attempt. |
| `task.maxContextChars` | 0 | When > 0, older tool/user output is replaced with a placeholder once the conversation exceeds this many characters. Tool-call pairing is preserved; the cumulative token budget still applies. |
| `task.maxFiles` / `task.maxLines` | 5 / 300 | Upper bound for a planned task's estimate. |
| `integration.provider` / `model` / `fallbackModel` / `baseURL` / `apiKeyEnv` | planner defaults | Model and endpoint for the global-acceptance and merge-conflict fix. |
| `integration.maxOutputTokens` / `reasoningEffort` | planner defaults | Sent only when set. |
| `integration.maxTurns` / `maxTokens` / `maxWallSec` | 30 / 200000 / 900 | Budget for one integration fix, independent of the task budget. |
| `integration.verifyAfterFix` | `true` | Rerun global acceptance after the fix commit; a fix that only passed before committing fails the run. |
| `run.maxCostUsd` | 10 | Estimated cost at which the run stops. |
| `run.baseline` | `true` | Run `globalAcceptance` once on the base commit before any task, and record the exit codes (`baseline_recorded`). |
| `run.baselinePolicy` | `strict` | `strict`: every global acceptance failure blocks. `ignore-existing`: a command that already failed at baseline and still fails is reported as a warning instead of blocking. |
| `worktree.linkNodeModules` | `false` | Symlink the repository's `node_modules` into every attempt worktree and the integration worktree (only when it is git-ignored), so linters and tests can run there. Workers share the installed dependencies; forbid `pnpm install`/`npm install` via `commandPolicy.deny`. |
| `failedWorktreeTtlMinutes` | 60 | How long a failed attempt's worktree and branch are kept. |
| `keepBranchesMinutes` | 0 | Minutes after a finished run when `cleanup` removes its passed task branches and integration branch. 0 keeps them forever. |
| `commandPolicy.allow` | `["npm", "node"]` | Executables workers and acceptance commands may run. Everything else is refused. |
| `commandPolicy.deny` | `["push", "reset --hard", "clean -fd", "remote", "install"]` | Substrings that reject a command even if its executable is allowed. The default blocks the most common destructive git operations and package installs. |
| `commandPolicy.env` | `[]` | Extra environment variable names commands may inherit. The base set is `PATH`, `TMPDIR`, `TMP`, `TEMP`, `SYSTEMROOT`, `LANG` plus a scratch `HOME`; nothing else is passed. For pnpm/Corepack repositories include `COREPACK_HOME` and `PNPM_HOME` so the scratch home does not trigger a package-manager download. |
| `commandPolicy.timeoutMs` / `outputLimitBytes` | 120000 / 20000 | Per-command timeout and captured output size. |
| `pricing` | `{}` | Per model name: `inputPerMillion`, `outputPerMillion` in USD. Models without an entry count as free. |

Model names are never built into the code; whatever the endpoint calls the model goes into `model`, and the same name is the key in `pricing`. Keys are read from the environment at run time and are never written to the config, the event log, or worker commands.

## API keys

`apiKeyEnv` holds a variable **name**, never the key itself. Two convenient sources:

- Export the variable in your shell (`export ANTHROPIC_AUTH_TOKEN=...`). This wins over the file.
- Open `swarm config` and paste the key in the **密钥 / API keys** section. It is written to `.swarm/.env` with owner-only permissions and is git-ignored; the CLI loads that file at startup for `plan`, `run`, `doctor` and worker processes. The page never returns the value, and the file is separate from `.swarm/config.json` and the event log.

For CI, pass keys as environment variables. `swarm config` also shows whether each variable is set by the shell, by `.swarm/.env`, or missing.

Each role and route has its own `apiKeyEnv`, so one repository can use several providers and keys:

```json
{
  "planner": { "provider": "anthropic", "model": "…", "apiKeyEnv": "ANTHROPIC_API_KEY" },
  "worker": {
    "provider": "openai",
    "model": "…",
    "apiKeyEnv": "DEEPSEEK_API_KEY",
    "routes": { "test": { "model": "…", "apiKeyEnv": "OPENAI_API_KEY" } }
  }
}
```

The configuration page lists every referenced variable plus every key already present in `.swarm/.env` (unreferenced ones are marked `未引用`), and the add row lets you store arbitrary keys. Labels next to each name show which role or route uses it.

## Example: official endpoints

```json
{
  "planner": {
    "provider": "anthropic",
    "baseURL": "https://api.anthropic.com",
    "model": "your-planner-model",
    "apiKeyEnv": "ANTHROPIC_API_KEY",
    "reasoningEffort": "high"
  },
  "worker": {
    "provider": "openai",
    "baseURL": "https://api.deepseek.com/v1",
    "model": "your-worker-model",
    "apiKeyEnv": "DEEPSEEK_API_KEY",
    "reasoningEffort": "low"
  },
  "pricing": {
    "your-planner-model": { "inputPerMillion": 0, "outputPerMillion": 0 },
    "your-worker-model": { "inputPerMillion": 0, "outputPerMillion": 0 }
  }
}
```

The Anthropic `baseURL` has no `/v1`; the OpenAI-compatible one does. Fill `pricing` with your provider's prices; a model without an entry counts as free and the run summary warns.

To send one kind of task to a different model or budget, add `routes` to the worker block, for example `"routes": { "test": { "model": "your-test-model", "maxTurns": 40 } }`. Tasks without a route use `worker.model` and the `task` budgets.

## Other OpenAI-compatible providers

Workers with `provider: "openai"` can point at any chat-completions endpoint, including local or third-party services that expose an OpenAI-compatible API:

- Ollama: `baseURL: "http://127.0.0.1:11434/v1"`, `model: "qwen2.5-coder"`, `apiKeyEnv` set to any non-empty variable.
- Gemini's OpenAI compatibility endpoint, or a gateway/proxy that fronts several providers.
- A local proxy that exposes the OpenAI-compatible format.

The adapter sends tools and `reasoning_effort` only when configured; a provider that does not support a field may reject the request. `fallbackModel` is tried only on a final error, on the same endpoint.

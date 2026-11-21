# Security

## Supported versions

This is an early `0.x` project. Security fixes land on `main`; there are no long-term support branches yet.

## Trust model

**Swarm runs model-generated code as your user. It is not an OS sandbox.**

- Planner tools read repository files. Worker tools read and write files inside a worktree and run commands from `commandPolicy.allow`.
- An allowed executable such as `npm`, `pnpm`, `node` or `git` can run arbitrary project scripts or change repository state. The allowlist and the shell-syntax check reduce accidents; they do not contain a malicious repository.
- Model output can be influenced by repository content (README, AGENTS.md, source comments, command output). Treat every repository you run against as trusted input.
- Run inside a container or VM for untrusted code. The included Dockerfile is the recommended isolation boundary: the CLI, workers, commands and worktrees all run inside the container, with the repository mounted.
- The default `commandPolicy.deny` rejects common destructive git operations (`push`, `reset --hard`, `clean -fd`, `remote`) and package installs (`install`). Review and extend it for your environment.

## Secrets

- API keys are read from the environment variable named by `apiKeyEnv`; they are never written to `.swarm/config.json`.
- `swarm config` can write a key to `.swarm/.env` with owner-only permissions. That file is git-ignored and separate from the config and event log; shell environment variables take precedence. The page never returns a stored value.
- Worker commands receive a small environment allowlist (`PATH`, `TMPDIR`, `TMP`, `TEMP`, `SYSTEMROOT`, `LANG`, a scratch `HOME`) plus the names in `commandPolicy.env`. The model key is not passed to commands.
- Known key values are redacted from event payloads before they are stored. This is a best-effort string replacement; it cannot catch transformed or encoded secrets.
- `.swarm/events.sqlite` is created with owner-only permissions where the platform supports it. It can still contain prompts, command output and repository content. Treat it as sensitive and do not commit it (`.swarm/` is added to `.gitignore` by `swarm init`).
- `swarm config` binds to `127.0.0.1` only; the write and check endpoints require a per-session token that is embedded in the page. It edits `.swarm/config.json`, not your source files, and keeps a `.bak` of the previous config.

## Reporting a vulnerability

Open a private security advisory on the repository (GitHub → Security → Advisories) or contact the maintainers directly. Do not open a public issue for an exploitable problem. Include the version, the repository shape needed to reproduce, and whether the issue is in the scheduler, a worker tool, a command-policy check or a model adapter.

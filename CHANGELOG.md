# Changelog

## 0.1.0

- Planner/worker task DAG in isolated Git worktrees, with an append-only SQLite event log.
- `swarm plan` preview, `swarm run --plan`, `swarm status`, `swarm runs`, `swarm logs`, `swarm viz`, `swarm config`, `swarm cleanup`.
- Visual configuration page for planner/worker models, per-kind routes, integration model, budgets, command policy and pricing.
- API keys can be pasted in the configuration page and stored in `.swarm/.env` (0600, git-ignored); shell environment variables win.
- Per-task-kind worker routes, baseline acceptance, partial integration, resumable failed/stopped runs, `retry_with`, scope-violation salvage and branch retention.
- Transient retries for planning and escalation, `--max-cost` on resume, redacted event payloads.
- Per-integration model and budget, integration diff guard, post-fix acceptance rerun.
- `swarm doctor`, `swarm retry`, Ctrl+C cancellation.
- Optional Anthropic streaming, context compaction, provider fallback and system-prompt caching.
- Dockerfile, GitHub Actions CI (Linux/macOS, Windows experimental), community and release docs.
- Node.js 20+; Linux/macOS supported, Windows experimental.

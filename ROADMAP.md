# Roadmap

## 0.1 — usable alpha

- [x] Plan preview and execution of an approved plan
- [x] Visual configuration page for models, routes and budgets
- [x] Per-task-kind model routes
- [x] Baseline acceptance and partial integration
- [x] Resume failed/stopped runs, `retry_with`, `--max-cost`
- [x] Snapshot fidelity and integration dependency parity
- [x] Event redaction, package metadata, CI, security docs

## 0.2 — safe for other people

- [x] Dedicated integration-fix budget/model
- [ ] Cost alerts for an expensive integration fix
- [x] `swarm doctor` preflight and Ctrl+C cancellation
- [x] Integration diff guard and final acceptance rerun
- [x] Windows marked experimental (junction for `node_modules`, Windows CI job)
- [x] Dockerfile and container-first usage

## 0.3 — scale

- [x] Anthropic streaming (OpenAI-compatible adapter remains non-streaming)
- [x] Opt-in context compaction
- [x] Provider fallback on final errors
- [ ] Per-provider rate limits
- [ ] Incremental integration
- [ ] Distributed workers
- [ ] PR creation and CI integration
- [x] Ollama/Gemini-compatible usage docs and opt-in prompt caching
- [ ] Model capability table

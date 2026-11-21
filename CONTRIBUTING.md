# Contributing

Thanks for helping. This is a small TypeScript project; keep changes focused.

## Setup

```sh
npm install
npm run build
npm test
```

Requires Node.js 20+ and Git.

## Before opening a pull request

```sh
npm run typecheck
npm test
```

- Keep the event-sourced design: all run state changes go through `emit`, and `replay` must reconstruct the same state.
- New scheduler, worktree, command-policy or integration behavior needs a test in `test/`.
- Do not commit secrets, `.swarm/` databases, generated worktrees or `dist/`.
- Update `docs/architecture.md`, `docs/events.md` or `docs/config.md` when you change the contract.
- Match the existing style: small modules, explicit types, no new dependency unless the standard library or an installed one cannot do the job.

## Reporting bugs

Use the issue template. Include the run id, the relevant events (`swarm logs <runId>`), the repository shape and whether the failure is transient, logic, scope or integration. Never paste API keys.

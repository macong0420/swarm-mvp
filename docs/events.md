# Event Dictionary

Rows in `.swarm/events.sqlite` are append-only: `id, ts, runId, taskId, attempt, type, payload`. `id` defines replay order; `ts` is UTC ISO-8601; `payload` is a JSON object. SQLite triggers reject updates and deletes. Lease and retry times are epoch milliseconds.

Task ids starting with `@` are not plan tasks: `@merge-<taskId>` is the planner resolving a merge conflict, `@integration` is the planner fixing a global acceptance failure.

| Type | Payload |
| --- | --- |
| `run_started` | `request`, `baseSha`, `dirty` (the working tree was frozen into `baseSha`), effective `config` snapshot, `baseDiff` (`changed`/`deleted` files versus HEAD) when dirty |
| `scheduler_started` | `pid`, `resumed` — a process started driving the run |
| `plan_proposed` | Full Plan as returned by the planner |
| `plan_rejected` | `reason`; `phase: "escalation"` when a split was rejected |
| `plan_accepted` | Full validated Plan |
| `task_state_changed` | `from`, `to`; `attemptId` for `running` and `passed`; `branch` for `passed`; `reason` for `cancelled` |
| `worker_started` | `attemptId`, `branch`, `worktreePath`, `baseSha` (the attempt's starting commit), `leaseUntil`, `role` (`worker` or `planner`) |
| `lease_renewed` | `attemptId`, `leaseUntil` |
| `model_call` | `phase` (`planning`, `escalation`, `worker`, `planner`), `model`, `elapsedMs`, `usage` (`inputTokens`, `outputTokens`); `turn` and `attemptId` inside an attempt |
| `tool_call` | `tool`, summarized `arguments` and `resultSummary`; `attemptId` inside an attempt, `phase` (`planning` or `escalation`) when the planner inspected the repository |
| `scope_violation` | Rejected write: `path`, `reason`. Rejected attempt: `files` |
| `acceptance_run` | `command`, `exitCode`, `timedOut`, `outputSummary`; `scope: "global"` or `"baseline"` for global/baseline acceptance |
| `failure` | `class` (`transient`, `logic`, `scope_violation`, `upstream`), `errorSummary`, `relatedFiles`, `attempt`, `attemptId`. Global acceptance: `scope: "global_acceptance"`, `suspectTasks`, `mergeRange`, `preexistingCommands` when some failures were already at baseline |
| `retry_scheduled` | `class`, `delayMs`, `notBefore` |
| `escalated_to_planner` | `kind` (`task`, `merge_conflict`, `global_acceptance`) and its details |
| `escalation_decision` | `action` (`split`, `implement`, `retry_with`, `abandon`), `reason`; `model` and `reasoningEffort` for `retry_with` |
| `baseline_recorded` | `results`: per global acceptance command `{ command, exitCode, timedOut }` from the base commit |
| `baseline_failed` | `errorSummary` — the baseline worktree or a command could not run; no baseline is used |
| `baseline_failure` | `commands`, `outputSummary` — global acceptance commands that failed at baseline and still fail under `baselinePolicy: ignore-existing` (reported, not blocking) |
| `replan` | Full rewritten Plan, `replaced` task id, `subtasks` ids, `reason` |
| `recovered` | `retries`, `failedAttemptId`, `failedBranch`, `passedBranch`, `diffSummary` (`git diff --stat` failed → passed) |
| `merge_attempted` | `branch`, `into` |
| `merge_conflict` | `branch`, `into`, conflicted `files`, `errorSummary` |
| `run_finished` | `state` (`passed`, `failed`, `stopped`), `reason`, `integrationBranch` (on `failed` it may be a partial branch with only the passed tasks), final `tasks`, `warnings` when any |
| `run_reopened` | `from` (`failed` or `stopped`), `resetTasks` ids — a finished run was resumed; unfinished plan tasks were reset to `pending` with a fresh retry budget |
| `run_config_updated` | `maxCostUsd` — the resume raised the cost budget recorded at run start |
| `conflict_resolved` | `task` (the merge target), `files`, `commit` — the planner resolved a merge conflict |
| `integration_fix_committed` | `commit`, `files` — the planner fixed a global acceptance failure |
| `integration_guard_failed` | `files` — the merged integration changed files outside every task's `writeScope` |
| `worktree_cleanup_failed` | `attemptId`, `errorSummary`; the task result still stands |

Event payloads never contain API key values.

# M4 run report

A real request, run on 2026-11-17 through a model gateway: planner `planner-model` (Anthropic Messages API), workers `worker-model` (OpenAI-compatible), `maxConcurrency` 4.

**Repository:** `textkit`, an empty ES-module package (README, `package.json`).

**Request:** add `slugify`, `truncate` and `wordCount`, each in its own module with its own `node:test` file, then `src/index.js` re-exporting all three, with a test.

## Result of the passing run

Run `23ecb0e8`: **passed** in 136 s. Four tasks, three of them in parallel, every task passed on its first attempt.

| Task | Depends on | Attempts | Started | Passed | Input tokens | Output tokens | Est. cost |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `implement_slugify` | – | 1 | 9.7 s | 43.3 s | 5,858 | 774 | $0.0013 |
| `implement_truncate` | – | 1 | 9.7 s | 105.5 s | 11,622 | 2,246 | $0.0031 |
| `implement_wordCount` | – | 1 | 9.8 s | 75.8 s | 11,092 | 1,431 | $0.0025 |
| `implement_index` | all three | 1 | 105.7 s | 136.1 s | 10,506 | 717 | $0.0020 |

| | |
| --- | --- |
| Tasks | 4 planned, 4 passed, 4 merged; success rate 100 % (4 of 4 attempts) |
| Planning | 1 planner call, accepted first time, 9.6 s |
| Model calls | 1 planner (1,022 in / 880 out), 22 worker (39,078 in / 5,168 out) |
| Total tokens | 40,100 input, 6,048 output |
| Estimated cost | $0.031 (planner $0.022, workers $0.009) |
| Wall clock | 136 s; the three parallel tasks ran from 9.7 s to 105.5 s, the dependent task for 30 s, integration under 1 s |
| Failures, scope violations | 0, 0 |
| Acceptance | 8 command runs (4 task, 4 global), all exit 0 |

Checked independently of the tool: on `swarm/23ecb0e8-…/integration`, `node --test` reports 33 tests, 33 passed; the user's `main` branch and working tree were unchanged. The branch adds 8 files, 263 lines.

## Problems met on the way

This was the third run of the same request. The first two failed, both because of plans that could not be executed. Both causes are now rejected by plan validation, before any task runs.

1. **Run 1 (failed, 405 s, $0.26).** The planner verified implementation tasks with `node -e "..."`. The command policy runs plain argv without a shell and refuses quotes, so those tasks failed every attempt. The failure handling itself worked as designed: retries ran out, the planner was asked, it re-split two tasks with commands that could run (both then passed first time), tried the third task itself, failed the same way, abandoned it, and the tasks behind it were blocked.
   *Fix:* a plan is rejected if the command policy would refuse any of its acceptance commands.
2. **Run 2 (stopped by hand after about 12 minutes, about $0.33).** With inline code ruled out, the planner verified each implementation task with a test file that a later task was to write. The file did not exist in the task's worktree and was outside its `writeScope`, so workers went in circles until the per-task token limit. The planner's re-splits did not help, because the failure it was shown said only "token budget exceeded".
   *Fix:* a plan is rejected if an acceptance command names a file that neither exists in the repository nor is written by the task or its dependencies; and the token-limit failure now carries the last acceptance failure.
3. **An alternate worker route returned 401** ("Invalid token") from its upstream provider. The run used the main worker route instead. This is a gateway credential, not something the tool can fix.
4. **Per-task token limit.** The default `task.maxTokens` of 30,000 counts every turn's input again, so a task that needs about 15 turns reaches it. The passing run stayed well below (at most 13,900 per task), but larger tasks will need a higher limit.

Total spent on real model calls for M4, including the two failed runs and connection checks: about $0.65 by the same estimate.

## Follow-up: working-tree start, planner repository access, partial edits

After the M4 run, three limits were fixed and checked with real models on 2026-11-18, in the same `textkit` example repository.

- **Starting from the working tree.** The previous integration result was restored into the working tree as *uncommitted* changes (8 staged files), then the run started from there. `run_started` recorded `dirty: true` with `baseSha` `f003cb3…`, a snapshot commit kept alive by `refs/swarm/<runId>/base`. The user's `HEAD`, index and files were unchanged afterwards. The snapshot leaves `.swarm/` out even when it is not git-ignored.
- **The planner sees the repository.** During planning it read `src/truncate.js` and `test/truncate.test.js` through the new read-only tools (`tool_call`, phase `planning`) before writing a two-task plan.
- **Workers edit instead of rewriting.** The run used `read_file` 8 times and `edit_file` 4 times, and `write_file` not at all.

Request: change `truncate()` so that `max` of 1–3 returns the first `max` characters without an ellipsis, and add tests for `max=2` and `max=3`. Both tasks passed on the first attempt; the run took 61 s and cost $0.119 (54,140 input / 5,196 output tokens). On the integration branch, `truncate("abcdef", 2)` is `"ab"`, `max=3` gives `"abc"`, `max=5` gives `"ab..."`, and `node --test` reports 35 tests, all passing.

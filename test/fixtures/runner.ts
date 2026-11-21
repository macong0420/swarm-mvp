// A separate scheduler process for the kill-and-resume test: starts a run from JSON options on argv.
import { startRun } from "../../src/core/run.js";

await startRun(JSON.parse(process.argv[2]!));

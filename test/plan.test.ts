import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validatePlan } from "../src/schema/plan.js";

const task = (id: string, writeScope: string[], dependsOn: string[] = []) => ({
  id,
  title: `Implement ${id}`,
  description: "Do one focused change.",
  writeScope,
  readContext: [],
  dependsOn,
  acceptance: { commands: ["node -p 1"] },
  estimate: { files: 1, lines: 10 },
});
const limits = { maxFiles: 5, maxLines: 300 };
const plan = (...tasks: ReturnType<typeof task>[]) => ({ goal: "test", globalAcceptance: [], tasks });

describe("validatePlan", () => {
  it("accepts disjoint parallel tasks", () => {
    assert.equal(validatePlan(plan(task("a", ["src/a/**"]), task("b", ["src/b/**"])), limits).tasks.length, 2);
  });

  it("rejects unknown dependencies and cycles", () => {
    assert.throws(() => validatePlan(plan(task("a", ["a/**"], ["missing"])), limits), /unknown dependency/);
    assert.throws(() => validatePlan(plan(task("a", ["a/**"], ["b"]), task("b", ["b/**"], ["a"])), limits), /cycle/);
  });

  it("rejects overlapping scopes for independent tasks but permits ordered overlap", () => {
    assert.throws(() => validatePlan(plan(task("a", ["src/**"]), task("b", ["src/lib/**"])), limits), /overlap/);
    assert.equal(validatePlan(plan(task("a", ["src/**"]), task("b", ["src/lib/**"], ["a"])), limits).tasks.length, 2);
  });

  it("rejects unsafe scopes and excessive estimates", () => {
    assert.throws(() => validatePlan(plan(task("a", ["../outside"])), limits), /unsafe/);
    const oversized = { ...task("a", ["src/a"]), estimate: { files: 6, lines: 10 } };
    assert.throws(() => validatePlan(plan(oversized), limits), /estimate/);
  });

  it("rejects empty title, writeScope and acceptance commands", () => {
    assert.throws(() => validatePlan(plan({ ...task("a", ["src/a"]), title: " " }), limits));
    assert.throws(() => validatePlan(plan(task("a", [])), limits));
    assert.throws(() => validatePlan(plan({ ...task("a", ["src/a"]), acceptance: { commands: [] } }), limits));
  });

  it("requires a single-goal title", () => {
    assert.throws(() => validatePlan(plan({ ...task("a", ["src/a"]), title: "One and two" }), limits), /one goal/);
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import { GoalManager } from "./manager.js";
import { failed, succeeded } from "../operations/types.js";

const bot = { entity: { position: { distanceTo: () => 0 } }, inventory: { items: () => [] } } as any;

test("goal manager completes from a typed successful operation", () => {
  const goals = new GoalManager();
  goals.setGoal({ type: "strategic", description: "build", completion: { kind: "operation_succeeded" }, source: "llm" });
  assert.equal(goals.evaluateOperation(bot, failed("NOPE", "failed")), null);
  const completed = goals.evaluateOperation(bot, succeeded("DONE", "done"));
  assert.equal(completed?.status, "completed");
  assert.equal(goals.getActive(), null);
});

test("goal manager does not use a step counter", () => {
  const goals = new GoalManager();
  const goal = goals.setGoal({ type: "emergency", description: "escape", completion: { kind: "not_in_water" }, source: "system" });
  assert.ok(!("steps" in goal));
});

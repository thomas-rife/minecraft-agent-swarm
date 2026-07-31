import test from "node:test";
import assert from "node:assert/strict";
import { ObjectivePlanner } from "./objective-planner.js";
import { resetSharedWorldRegistry } from "../world/registry.js";

function botWith(items: Array<{ name: string; count: number }> = []) {
  return {
    food: 20,
    inventory: {
      items: () => items.map((item, index) => ({ ...item, type: index + 1 })),
    },
  } as any;
}

test("farm goal preserves its parent while expanding the wood prerequisite", () => {
  resetSharedWorldRegistry();
  const planner = new ObjectivePlanner();
  planner.enqueue({
    thought: "I want sustainable food",
    action: "pursue_goal",
    params: {},
    goal: "Establish a working wheat farm",
  });
  const leaf = planner.next(botWith());
  assert.equal(leaf?.action, "gather_wood");
  assert.equal(leaf?.objectiveAction, "build_farm");
  assert.equal(leaf?.goal, "Establish a working wheat farm");
  assert.equal(leaf?.completesObjective, false);
  assert.equal(leaf?.params.count, 2);
});

test("farm goal crafts its hoe before invoking the farm skill", () => {
  resetSharedWorldRegistry();
  const planner = new ObjectivePlanner();
  planner.enqueue({
    thought: "",
    action: "pursue_goal",
    params: {},
    goal: "Build a wheat farm",
  });
  const leaf = planner.next(
    botWith([
      { name: "oak_planks", count: 2 },
      { name: "stick", count: 2 },
      { name: "crafting_table", count: 1 },
    ]),
  );
  assert.equal(leaf?.action, "craft");
  assert.equal(leaf?.params.item, "wooden_hoe");
  assert.equal(leaf?.completesObjective, false);
});

test("farm budgets the missing crafting table before attempting the hoe", () => {
  resetSharedWorldRegistry();
  const planner = new ObjectivePlanner();
  planner.enqueue({
    thought: "",
    action: "pursue_goal",
    params: {},
    goal: "Build a wheat farm",
  });
  const leaf = planner.next(
    botWith([
      { name: "oak_planks", count: 2 },
      { name: "stick", count: 2 },
    ]),
  );
  assert.equal(leaf?.action, "gather_wood");
  assert.equal(leaf?.params.count, 1);
  assert.equal(leaf?.objectiveAction, "build_farm");
});

test("generic planks are canonicalized before execution and verification", () => {
  resetSharedWorldRegistry();
  const planner = new ObjectivePlanner();
  planner.enqueue({
    thought: "",
    action: "craft",
    params: { item: "planks", count: 1 },
    goal: "Make building boards",
  });
  const leaf = planner.next(botWith([{ name: "birch_log", count: 1 }]));
  assert.equal(leaf?.action, "craft");
  assert.equal(leaf?.params.item, "birch_planks");
  assert.equal(leaf?.completesObjective, true);
});

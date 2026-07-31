import test from "node:test";
import assert from "node:assert/strict";
import { ObjectivePlanner } from "./objective-planner.js";
import { resetSharedWorldRegistry, upsertSharedStructure } from "../world/registry.js";

function botWith(items: Array<{ name: string; count: number }> = [], food = 20) {
  return {
    food,
    inventory: { items: () => items },
  } as any;
}

test("bootstrap stash deterministically gathers its complete material chain", () => {
  resetSharedWorldRegistry();
  const planner = new ObjectivePlanner();
  planner.ensureBootstrapStash();
  const next = planner.next(botWith());
  assert.equal(next?.action, "gather_wood");
  assert.equal(next?.params.count, 5);
});

test("bootstrap stash starts its depth-first crafting chain after gathering wood", () => {
  resetSharedWorldRegistry();
  const planner = new ObjectivePlanner();
  planner.ensureBootstrapStash();
  const next = planner.next(botWith([{ name: "oak_log", count: 5 }]));
  assert.equal(next?.action, "craft");
  assert.equal(next?.params.item, "oak_planks");
  assert.equal(next?.completesObjective, false);
});

test("an empty verified stash falls back to local resource acquisition", () => {
  resetSharedWorldRegistry();
  upsertSharedStructure({
    id: "shared-stash",
    type: "stash",
    status: "verified",
    position: { x: 0, y: 64, z: 0 },
    provenance: "world_observation",
    evidence: { items: [] },
  });
  const planner = new ObjectivePlanner();
  planner.enqueue({ thought: "", action: "withdraw_stash", params: { item: "oak_log", count: 4 } });
  const next = planner.next(botWith());
  assert.equal(next?.action, "gather_wood");
  assert.equal(next?.params.count, 4);
});

test("strip mining starts at the deepest raw-material prerequisite", () => {
  resetSharedWorldRegistry();
  const planner = new ObjectivePlanner();
  planner.enqueue({ thought: "", action: "strip_mine", params: {} });
  assert.equal(planner.next(botWith())?.action, "gather_wood");
});

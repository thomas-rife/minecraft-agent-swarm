import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FARM_WOOD_TARGET,
  GENERIC_WOOD_RESERVE,
  HOUSE_WOOD_TARGET,
  STICK_RESERVE,
  TORCH_RESERVE,
  assessGoal,
  assessWoodGatherDecision,
  inventoryCounts,
  woodPlankEquivalent,
} from "./goal-requirements.js";

const counts = (...items: Array<[string, number]>) => inventoryCounts(items.map(([name, count]) => ({ name, count })));

test("wood equivalence combines every log/plank type but not irreversible sticks", () => {
  assert.equal(woodPlankEquivalent(counts(["oak_log", 3], ["spruce_planks", 5], ["stick", 64])), 17);
});

test("generic gather goal completes at the reserve and can become incomplete after resources are spent", () => {
  const full = assessGoal("Gather wood for later", counts(["birch_log", 8]));
  assert.equal(full.wood?.targetPlankEquivalent, GENERIC_WOOD_RESERVE);
  assert.equal(full.goalComplete, true);

  const depleted = assessGoal("Gather wood for later", counts(["birch_log", 2]));
  assert.equal(depleted.goalComplete, false);
  assert.equal(depleted.wood?.deficitLogs, 6);
});

test("explicit log and plank amounts override the generic reserve", () => {
  assert.equal(assessGoal("Collect 12 logs", counts(["oak_log", 11])).wood?.targetPlankEquivalent, 48);
  assert.equal(assessGoal("Collect 12 logs", counts(["oak_log", 12])).goalComplete, true);
  assert.equal(assessGoal("Get 20 planks", counts(["oak_log", 5])).goalComplete, true);
});

test("house wood is a prerequisite and never completes the build by itself", () => {
  const ready = assessGoal("Gather wood and build a house", counts(["oak_planks", HOUSE_WOOD_TARGET]));
  assert.equal(ready.wood?.satisfied, true);
  assert.equal(ready.goalComplete, false);

  const built = assessGoal("Build a house", counts(), {
    action: "build_house",
    result: 'HOUSE BUILT! "Starter House" at 1, 64, 1.',
  });
  assert.equal(built.goalComplete, true);

  const partial = assessGoal("Build a house", counts(), {
    action: "build_house",
    result: "House partially built (80/174 blocks).",
  });
  assert.equal(partial.goalComplete, false);

  const resumed = assessGoal("Finish the house", counts(["oak_planks", 100]), {
    woodTargetOverride: 100,
  });
  assert.equal(resumed.wood?.satisfied, true);
  assert.equal(resumed.goalComplete, false);
});

test("a finished hoe satisfies farm wood prep but only planted crops complete the farm", () => {
  const prepared = assessGoal("Build the farm", counts(["wooden_hoe", 1]));
  assert.equal(prepared.wood?.targetPlankEquivalent, FARM_WOOD_TARGET);
  assert.equal(prepared.wood?.satisfied, true);
  assert.equal(prepared.goalComplete, false);

  const planted = assessGoal("Build the farm", counts(["wooden_hoe", 1]), {
    action: "build_farm",
    result: "Farm planted! 9 wheat seeds near water at 183, 186.",
  });
  assert.equal(planted.goalComplete, true);
});

test("finished outputs beat raw-material thresholds", () => {
  assert.equal(assessGoal("Craft a crafting table", counts(), { nearbyCraftingTable: true }).goalComplete, true);
  assert.equal(assessGoal("Craft wooden_pickaxe", counts(["wooden_pickaxe", 1])).goalComplete, true);
});

test("stash requirement accounts for chests and an existing crafting table", () => {
  assert.equal(assessGoal("Set up the stash", counts()).wood?.targetPlankEquivalent, 20);
  assert.equal(
    assessGoal("Set up the stash", counts(["chest", 1]), { nearbyCraftingTable: true }).wood?.targetPlankEquivalent,
    8,
  );
  assert.equal(
    assessGoal("Set up the stash", counts(), { action: "setup_stash", result: "Stash already exists — chest found." })
      .goalComplete,
    true,
  );
});

test("non-wood tools only reserve wood for their sticks/table", () => {
  const ironPick = assessGoal("Craft an iron pickaxe", counts(["crafting_table", 1], ["stick", 2]));
  assert.equal(ironPick.wood?.targetPlankEquivalent, 0);
  assert.equal(ironPick.wood?.satisfied, true);
  assert.equal(ironPick.goalComplete, false);
});

test("non-wood blockers do not cause more gathering", () => {
  const torches = assessGoal("Make torches", counts(["stick", 8]));
  assert.equal(torches.goalComplete, false);
  assert.equal(torches.wood?.satisfied, true);

  const compound = assessGoal("Gather wood and coal", counts(["oak_log", 64]));
  assert.equal(compound.goalComplete, false);
  assert.equal(compound.wood?.satisfied, true);
});

test("existing stick stacks complete vague and explicit stick output goals", () => {
  const vague = assessGoal("Craft some sticks to use for torches", counts(["stick", 64]));
  assert.equal(vague.item?.target, STICK_RESERVE);
  assert.equal(vague.item?.satisfied, true);
  assert.equal(vague.goalComplete, true);

  assert.equal(assessGoal("Craft 16 sticks", counts(["stick", 12])).goalComplete, false);
  assert.equal(assessGoal("Craft 16 sticks", counts(["stick", 16])).goalComplete, true);
});

test("existing torches complete supply goals but not placement projects", () => {
  const supply = assessGoal("Craft torches to ensure safety", counts(["torch", 10]));
  assert.equal(supply.item?.target, TORCH_RESERVE);
  assert.equal(supply.goalComplete, true);

  const explicit = assessGoal("Craft 16 torches", counts(["torch", 10]));
  assert.equal(explicit.item?.deficit, 6);
  assert.equal(explicit.goalComplete, false);

  const placement = assessGoal("Craft torches and light the cave", counts(["torch", 64]));
  assert.equal(placement.item?.satisfied, true);
  assert.equal(placement.goalComplete, false);
});

test("compound stick goals do not complete from sticks alone", () => {
  const compound = assessGoal("Craft sticks and gather coal", counts(["stick", 64]));
  assert.equal(compound.item?.satisfied, true);
  assert.equal(compound.goalComplete, false);
});

test("unknown goals are never guessed complete", () => {
  assert.deepEqual(assessGoal("Improve the village defenses", counts(["oak_log", 64])), {
    goalComplete: false,
  });
  assert.equal(assessGoal("Return home", counts(["oak_log", 64])).wood, undefined);
  assert.equal(assessGoal("Deposit supplies in the stash", counts(["oak_log", 64])).wood, undefined);
  assert.equal(assessGoal("Collect 5 more logs", counts(["oak_log", 64])).goalComplete, false);
  assert.equal(assessGoal("Reach the stash and gather more resources", counts(["oak_log", 64])).wood, undefined);
});

test("every direct wood-gather decision receives a stopping target", () => {
  const unrelated = assessWoodGatherDecision("Mine more iron ore", counts(["oak_log", 8]));
  assert.equal(unrelated.goalComplete, false);
  assert.equal(unrelated.wood?.targetPlankEquivalent, GENERIC_WOOD_RESERVE);
  assert.equal(unrelated.wood?.satisfied, true);

  const lowReserve = assessWoodGatherDecision("Explore nearby", counts(["oak_log", 2]));
  assert.equal(lowReserve.wood?.satisfied, false);
  assert.equal(lowReserve.wood?.deficitLogs, 6);
});

test("compound resource goals retain explicit wood quantities", () => {
  const short = assessWoodGatherDecision("Gather 64 logs and coal", counts(["oak_log", 40], ["coal", 64]));
  assert.equal(short.wood?.targetPlankEquivalent, 256);
  assert.equal(short.wood?.satisfied, false);

  const ready = assessWoodGatherDecision("Gather 64 logs and coal", counts(["oak_log", 64]));
  assert.equal(ready.wood?.satisfied, true);
  assert.equal(ready.goalComplete, false);
});

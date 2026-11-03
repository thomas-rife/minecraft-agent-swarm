import assert from "node:assert/strict";
import test from "node:test";
import {
  PROGRESSION_TREE,
  evaluateProgression,
  recordVerifiedObjective,
  type ProgressionState,
} from "./progression-tree.js";

function completeStages(...ids: string[]): ProgressionState {
  return {
    completedObjectives: PROGRESSION_TREE.filter((stage) => ids.includes(stage.id)).flatMap((stage) =>
      stage.objectives.map((objective) => objective.id),
    ),
  };
}

test("a fresh team starts with only first shelter available", () => {
  assert.deepEqual(
    evaluateProgression({ completedObjectives: [] }).map((stage) => stage.status),
    ["available", "locked", "locked", "locked", "locked", "locked"],
  );
});

test("all starter objectives are required before stone survival unlocks", () => {
  let state: ProgressionState = { completedObjectives: [] };
  for (const objective of PROGRESSION_TREE[0].objectives.slice(0, -1))
    state = recordVerifiedObjective(state, objective.id);
  assert.equal(evaluateProgression(state)[1].status, "locked");
  state = recordVerifiedObjective(state, "starter_shelter");
  assert.equal(evaluateProgression(state)[1].status, "available");
});

test("base expansion and iron industry branch and retain earlier examples", () => {
  const view = evaluateProgression(completeStages("first_shelter", "stone_survival"));
  assert.equal(view[2].status, "available");
  assert.equal(view[3].status, "available");
  assert.ok(view[3].availableExamples.includes("mineWoodLog"));
  assert.ok(view[3].availableExamples.includes("craftStonePickaxe"));
  assert.ok(view[3].availableExamples.includes("craftIronPickaxe"));
  assert.ok(!view[3].availableExamples.includes("build_structure"));
  assert.deepEqual(view[4].availableExamples, []);
});

test("Nether preparation does not require the optional base expansion branch", () => {
  const view = evaluateProgression(completeStages("first_shelter", "stone_survival", "iron_industry"));
  assert.equal(view[2].status, "available");
  assert.equal(view[4].status, "available");
  assert.equal(view[5].status, "locked");
});

test("verified milestones are immutable and idempotent, with unknown and locked IDs rejected", () => {
  const original: ProgressionState = { completedObjectives: [] };
  const updated = recordVerifiedObjective(original, "wood_supply");
  assert.deepEqual(original.completedObjectives, []);
  assert.deepEqual(recordVerifiedObjective(updated, "wood_supply"), updated);
  assert.throws(() => recordVerifiedObjective(original, "blaze_rods"), /locked/);
  assert.throws(() => recordVerifiedObjective(original, "made_up"), /Unknown/);
});

test("the tree has unique IDs and existing JavaScript or registered built-in examples", async () => {
  const { existsSync } = await import("node:fs");
  const { skillRegistry } = await import("../skills/registry.js");
  const ids = PROGRESSION_TREE.flatMap((stage) => [stage.id, ...stage.objectives.map((objective) => objective.id)]);
  assert.equal(new Set(ids).size, ids.length);
  for (const stage of PROGRESSION_TREE) {
    for (const objective of stage.objectives) {
      for (const example of objective.examples) {
        assert.ok(
          skillRegistry.has(example) || existsSync(new URL(`../../skills/voyager/${example}.js`, import.meta.url)),
          example,
        );
      }
    }
  }
});

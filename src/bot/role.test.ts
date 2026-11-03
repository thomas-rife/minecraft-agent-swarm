import assert from "node:assert/strict";
import test from "node:test";
import {
  BOT_ROSTER,
  FARM_SITE,
  FLORA_CONFIG,
  MASON_CONFIG,
  SOLO_CONFIG,
  SETTLEMENT_ANCHOR,
  STASH_POS,
} from "./role.js";

test("Flora owns farming and can gather her own wood", () => {
  assert.equal(FLORA_CONFIG.allowedSkills.includes("build_farm"), true);
  assert.equal(FLORA_CONFIG.allowedActions.includes("gather_wood"), true);
  assert.equal(MASON_CONFIG.allowedSkills.includes("build_farm"), false);
});

test("Mason can build the deterministic settlement structures", () => {
  assert.equal(MASON_CONFIG.allowedSkills.includes("build_structure"), true);
  assert.match(MASON_CONFIG.priorities, /"structure":"warehouse"/);
  assert.match(MASON_CONFIG.priorities, /"structure":"workshop"/);
});

test("Solo has the specialties required to traverse the progression graph", () => {
  for (const skill of ["build_house", "strip_mine", "smelt_ores", "build_farm", "craft_gear", "neural_combat"])
    assert.ok(SOLO_CONFIG.allowedSkills.includes(skill), `missing solo skill ${skill}`);
  assert.equal(SOLO_CONFIG.memoryFile, "memory-solo.json");
  assert.equal(BOT_ROSTER[5], SOLO_CONFIG);
});

test("configured farm remains inside Flora's leash from the shared base", () => {
  const distance = Math.hypot(FARM_SITE.x - STASH_POS.x, FARM_SITE.z - STASH_POS.z);
  assert.ok(distance <= FLORA_CONFIG.leashRadius);
});

test("every bot safely spawns at the shared surface base", () => {
  for (const role of BOT_ROSTER) {
    assert.equal(role.safeSpawn?.x, STASH_POS.x);
    assert.equal(role.safeSpawn?.z, STASH_POS.z);
    assert.deepEqual(role.homePos, SETTLEMENT_ANCHOR);
  }
});

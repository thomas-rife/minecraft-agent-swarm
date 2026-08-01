import test from "node:test";
import assert from "node:assert/strict";
import { ALL_ACTIONS, ALL_STATIC_SKILLS, BOT_ROSTER, HOME_BASE, STASH_POS } from "./role.js";

test("the swarm has exactly Milo, Ava, and Peter", () => {
  assert.deepEqual(BOT_ROSTER.map((role) => role.name), ["Milo", "Ava", "Peter"]);
  assert.deepEqual(BOT_ROSTER.map((role) => role.username), ["Milo", "Ava", "Peter"]);
});

test("all bots share only the configured home and stash anchor", () => {
  assert.deepEqual(HOME_BASE, { x: 116, y: 66, z: 256 });
  assert.deepEqual(STASH_POS, HOME_BASE);
  for (const role of BOT_ROSTER) {
    assert.deepEqual(role.homePos, HOME_BASE, `${role.name} has the wrong home`);
    assert.deepEqual(role.safeSpawn, HOME_BASE, `${role.name} has the wrong spawn anchor`);
    assert.deepEqual(role.stashPos, HOME_BASE, `${role.name} has the wrong stash anchor`);
  }
});

test("roles affect priorities, not action or skill permissions", () => {
  for (const role of BOT_ROSTER) {
    assert.deepEqual(new Set(role.allowedActions), new Set(ALL_ACTIONS), `${role.name} has restricted actions`);
    assert.deepEqual(new Set(role.allowedSkills), new Set(ALL_STATIC_SKILLS), `${role.name} has restricted skills`);
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { BotMemoryStore } from "./memory.js";

// ── Helper: create a store backed by a temp file ────────────────────────────
// Each test gets a completely fresh store with its own temp file.

function tmpStore(): { store: BotMemoryStore; file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memtest-"));
  const file = path.join(dir, "test-memory.json");
  const store = new BotMemoryStore("test-memory.json");
  // Override the private memoryFile to point to our temp location
  (store as any).memoryFile = file;
  // Deep-initialize the internal memory to avoid shared-reference issues
  // with defaultMemory's arrays (shallow spread in constructor).
  (store as any).memory = {
    structures: [],
    deaths: [],
    oreDiscoveries: [],
    skillHistory: [],
    lessons: [],
    lastUpdated: new Date().toISOString(),
    brokenSkillNames: [],
    seasonGoal: undefined,
  };
  return {
    store,
    file,
    cleanup: () => {
      try {
        fs.unlinkSync(file);
      } catch {
        /* ignore cleanup errors */
      }
      try {
        fs.rmdirSync(dir);
      } catch {
        /* ignore cleanup errors */
      }
    },
  };
}

// ── Save and load ───────────────────────────────────────────────────────────

test("memory: verified progression and storage evidence survive restart without shared mutable arrays", () => {
  const { store, file, cleanup } = tmpStore();
  try {
    store.saveProgressionObjectives(["wood_supply", "crafting_station", "wood_supply"]);
    store.recordProgressionStorage("deposited");
    const reloaded = new BotMemoryStore("test-memory.json");
    (reloaded as any).memoryFile = file;
    reloaded.load();
    assert.deepEqual(reloaded.getProgressionObjectives(), ["crafting_station", "wood_supply"]);
    assert.equal(reloaded.getProgressionStorage().deposited, true);
    assert.equal(reloaded.getProgressionStorage().retrieved, false);
    const copy = reloaded.getProgressionObjectives();
    copy.push("starter_shelter");
    assert.equal(reloaded.getProgressionObjectives().length, 2);
  } finally {
    cleanup();
  }
});

test("memory: new stores never share mutable default arrays", () => {
  const first = new BotMemoryStore("isolated-a.json");
  const second = new BotMemoryStore("isolated-b.json");

  // Avoid writing into the project; the assertion concerns the in-memory
  // graphs created by each constructor.
  (first as any).save = () => {};
  first.addStructure("house", 1, 64, 1);
  first.recordSkillAttempt("build_house", true, 1, "done");

  assert.equal(first.getStats().structures, 1);
  assert.equal(first.getStats().skills, 1);
  assert.equal(second.getStats().structures, 0);
  assert.equal(second.getStats().skills, 0);
});

test("memory: save and load round-trip", () => {
  const { store, file, cleanup } = tmpStore();
  try {
    store.addStructure("house", 10, 64, 20, "cozy cabin");
    assert.ok(fs.existsSync(file), "Memory file should exist after save");

    const { store: store2 } = tmpStore();
    (store2 as any).memoryFile = file;
    const loaded = store2.load();
    assert.equal(loaded.structures.length, 1);
    assert.equal(loaded.structures[0].type, "house");
    assert.equal(loaded.structures[0].notes, "cozy cabin");
  } finally {
    cleanup();
  }
});

// ── Structures ──────────────────────────────────────────────────────────────

test("memory: addStructure records location and type", () => {
  const { store, cleanup } = tmpStore();
  try {
    const added = store.addStructure("farm", 50, 63, 100);
    assert.equal(added, true);
    assert.equal(store.getStats().structures, 1);
  } finally {
    cleanup();
  }
});

test("memory: addStructure rejects duplicate nearby structure", () => {
  const { store, cleanup } = tmpStore();
  try {
    store.addStructure("house", 10, 64, 20);
    const added = store.addStructure("house", 15, 64, 22); // within 10 blocks
    assert.equal(added, false);
    assert.equal(store.getStats().structures, 1);
  } finally {
    cleanup();
  }
});

test("memory: addStructure allows same type far away", () => {
  const { store, cleanup } = tmpStore();
  try {
    store.addStructure("house", 10, 64, 20);
    const added = store.addStructure("house", 100, 64, 200);
    assert.equal(added, true);
    assert.equal(store.getStats().structures, 2);
  } finally {
    cleanup();
  }
});

test("memory: hasStructureNearby finds nearby structure", () => {
  const { store, cleanup } = tmpStore();
  try {
    store.addStructure("mine", 50, 30, 50);
    assert.equal(store.hasStructureNearby("mine", 55, 30, 55), true);
    assert.equal(store.hasStructureNearby("mine", 200, 30, 200), false);
  } finally {
    cleanup();
  }
});

test("memory: getNearestStructure returns closest match", () => {
  const { store, cleanup } = tmpStore();
  try {
    store.addStructure("house", 10, 64, 10);
    store.addStructure("house", 100, 64, 100);
    const nearest = store.getNearestStructure("house", 15, 15);
    assert.ok(nearest);
    assert.equal(nearest.x, 10);
  } finally {
    cleanup();
  }
});

test("memory: getNearestStructure returns null when no match", () => {
  const { store, cleanup } = tmpStore();
  try {
    const nearest = store.getNearestStructure("house", 0, 0);
    assert.equal(nearest, null);
  } finally {
    cleanup();
  }
});

test("memory: farm candidates persist before a completed farm exists", () => {
  const { store, file, cleanup } = tmpStore();
  try {
    store.rememberFarmSite({ x: 113, y: 63, z: 191 }, { x: 112, y: 64, z: 190 });
    assert.equal(store.getFarmSites().length, 1);
    assert.equal(store.getFarmSites()[0]?.status, "discovered");
    assert.equal(store.getStats().structures, 0);

    const { store: reloaded } = tmpStore();
    (reloaded as any).memoryFile = file;
    reloaded.load();
    assert.deepEqual(reloaded.getFarmSites()[0]?.water, { x: 113, y: 63, z: 191 });
    assert.deepEqual(reloaded.getFarmSites()[0]?.approach, { x: 112, y: 64, z: 190 });
  } finally {
    cleanup();
  }
});

test("memory: repeatedly unreachable farm candidates become blocked but can be rediscovered", () => {
  const { store, cleanup } = tmpStore();
  try {
    const water = { x: 113, y: 63, z: 191 };
    const approach = { x: 112, y: 64, z: 190 };
    store.rememberFarmSite(water, approach);
    store.updateFarmSite(water, "discovered", "no path");
    store.updateFarmSite(water, "discovered", "no path");
    store.updateFarmSite(water, "discovered", "no path");
    assert.equal(store.getFarmSites()[0]?.status, "blocked");

    store.rememberFarmSite(water, { x: 114, y: 64, z: 190 });
    assert.equal(store.getFarmSites()[0]?.status, "discovered");
    assert.deepEqual(store.getFarmSites()[0]?.approach, { x: 114, y: 64, z: 190 });
  } finally {
    cleanup();
  }
});

test("memory: farm plot ledgers persist, merge duplicates, and cannot be mutated by callers", () => {
  const { store, file, cleanup } = tmpStore();
  try {
    const water = { x: 113, y: 63, z: 191 };
    store.rememberFarmSite(water, { x: 112, y: 64, z: 190 });
    store.recordFarmPlots(water, [
      { x: 112, y: 63, z: 191 },
      { x: 112, y: 63, z: 191 },
      { x: 114, y: 63, z: 191 },
    ]);
    assert.equal(store.getFarmSites()[0]?.status, "planted");
    assert.equal(store.getFarmSites()[0]?.plots?.length, 2);

    const external = store.getFarmSites()[0]?.plots?.[0];
    assert.ok(external);
    external.x = 999;
    assert.notEqual(store.getFarmSites()[0]?.plots?.[0]?.x, 999);

    const { store: reloaded } = tmpStore();
    (reloaded as any).memoryFile = file;
    reloaded.load();
    assert.equal(reloaded.getFarmSites()[0]?.plots?.length, 2);
  } finally {
    cleanup();
  }
});

test("memory: repeatedly invalid farm plots can be retired from the durable ledger", () => {
  const { store, cleanup } = tmpStore();
  try {
    const water = { x: 113, y: 63, z: 191 };
    const plot = { x: 112, y: 63, z: 191 };
    store.rememberFarmSite(water, { x: 112, y: 64, z: 190 });
    store.recordFarmPlots(water, [plot]);

    assert.equal(store.recordFarmPlotInvalid(water, plot), 1);
    assert.equal(store.recordFarmPlotInvalid(water, plot), 2);
    assert.equal(store.recordFarmPlotInvalid(water, plot), 3);
    assert.equal(store.removeFarmPlot(water, plot), true);
    assert.equal(store.getFarmSites()[0]?.plots?.length, 0);
  } finally {
    cleanup();
  }
});

test("memory: a transient path failure does not downgrade an established farm", () => {
  const { store, cleanup } = tmpStore();
  try {
    const water = { x: 113, y: 63, z: 191 };
    store.rememberFarmSite(water, { x: 112, y: 64, z: 190 });
    store.recordFarmPlots(water, [{ x: 112, y: 63, z: 191 }]);
    store.updateFarmSite(water, "discovered", "temporary path timeout");
    assert.equal(store.getFarmSites()[0]?.status, "planted");
    assert.equal(store.getFarmSites()[0]?.lastFailure, "temporary path timeout");
  } finally {
    cleanup();
  }
});

// ── Deaths ──────────────────────────────────────────────────────────────────

test("memory: recordDeath stores death with cause", () => {
  const { store, cleanup } = tmpStore();
  try {
    store.recordDeath(100, 64, 200, "zombie");
    assert.equal(store.getStats().deaths, 1);
  } finally {
    cleanup();
  }
});

test("memory: deaths are capped at 50 entries", () => {
  const { store, cleanup } = tmpStore();
  try {
    for (let i = 0; i < 55; i++) {
      store.recordDeath(i, 64, 0, `death_${i}`);
    }
    assert.equal(store.getStats().deaths, 50);
  } finally {
    cleanup();
  }
});

test("memory: shouldAvoidLocation detects death zone", () => {
  const { store, cleanup } = tmpStore();
  try {
    store.recordDeath(100, 64, 200, "creeper");
    assert.equal(store.shouldAvoidLocation(102, 64, 202), true);
    assert.equal(store.shouldAvoidLocation(500, 64, 500), false);
  } finally {
    cleanup();
  }
});

// ── Ore discoveries ─────────────────────────────────────────────────────────

test("memory: recordOre stores unique discoveries", () => {
  const { store, cleanup } = tmpStore();
  try {
    store.recordOre("diamond_ore", 10, 12, 10);
    store.recordOre("iron_ore", 20, 40, 20);
    assert.equal(store.getStats().ores, 2);
  } finally {
    cleanup();
  }
});

test("memory: recordOre deduplicates nearby same-type ore", () => {
  const { store, cleanup } = tmpStore();
  try {
    store.recordOre("diamond_ore", 10, 12, 10);
    store.recordOre("diamond_ore", 12, 12, 12); // within 5 blocks
    assert.equal(store.getStats().ores, 1);
  } finally {
    cleanup();
  }
});

test("memory: recordOre allows same type far away", () => {
  const { store, cleanup } = tmpStore();
  try {
    store.recordOre("diamond_ore", 10, 12, 10);
    store.recordOre("diamond_ore", 100, 12, 100); // far away
    assert.equal(store.getStats().ores, 2);
  } finally {
    cleanup();
  }
});

// ── Skill history ───────────────────────────────────────────────────────────

test("memory: recordSkillAttempt tracks success and failure", () => {
  const { store, cleanup } = tmpStore();
  try {
    store.recordSkillAttempt("build_house", true, 30, "built successfully");
    store.recordSkillAttempt("build_house", false, 10, "no materials");
    const rate = store.getSkillSuccessRate("build_house");
    assert.equal(rate.totalAttempts, 2);
    assert.equal(rate.successRate, 50);
  } finally {
    cleanup();
  }
});

test("memory: getSkillSuccessRate returns -1 for unknown skill", () => {
  const { store, cleanup } = tmpStore();
  try {
    const rate = store.getSkillSuccessRate("nonexistent_skill");
    assert.equal(rate.successRate, -1);
    assert.equal(rate.totalAttempts, 0);
  } finally {
    cleanup();
  }
});

test("memory: getSkillSuccessRate computes avg duration", () => {
  const { store, cleanup } = tmpStore();
  try {
    store.recordSkillAttempt("mine", true, 10, "ok");
    store.recordSkillAttempt("mine", true, 20, "ok");
    const rate = store.getSkillSuccessRate("mine");
    assert.equal(rate.avgDuration, 15);
  } finally {
    cleanup();
  }
});

test("memory: skill history capped at 100 entries", () => {
  const { store, cleanup } = tmpStore();
  try {
    for (let i = 0; i < 110; i++) {
      store.recordSkillAttempt("test_skill", true, 5, `attempt ${i}`);
    }
    assert.equal(store.getStats().skills, 100);
  } finally {
    cleanup();
  }
});

test("memory: skill with 5+ real failures is marked broken", () => {
  const { store, cleanup } = tmpStore();
  try {
    for (let i = 0; i < 6; i++) {
      store.recordSkillAttempt("dynamic_bad_skill", false, 5, "crashed hard");
    }
    const broken = store.getBrokenSkills();
    assert.ok(broken.has("dynamic_bad_skill"));
  } finally {
    cleanup();
  }
});

test("memory: precondition failures don't count as real failures for broken detection", () => {
  const { store, cleanup } = tmpStore();
  try {
    for (let i = 0; i < 6; i++) {
      store.recordSkillAttempt("dynamic_tree_skill", false, 5, "No trees found nearby");
    }
    const broken = store.getBrokenSkills();
    assert.ok(!broken.has("dynamic_tree_skill"));
  } finally {
    cleanup();
  }
});

test("memory: static skills only cool down and never enter the permanent blacklist", () => {
  const { store, file, cleanup } = tmpStore();
  try {
    for (let i = 0; i < 6; i++) {
      store.recordSkillAttempt("build_house", false, 5, "crashed");
    }
    const broken = store.getBrokenSkills();
    assert.ok(!broken.has("build_house"), "source-backed skills must remain repairable during a session");

    const { store: store2 } = tmpStore();
    (store2 as any).memoryFile = file;
    const loaded = store2.load();
    assert.ok(!loaded.brokenSkillNames.includes("build_house"), "build_house should be healed on load");
  } finally {
    cleanup();
  }
});

// ── Corrupted file handling ─────────────────────────────────────────────────

test("memory: corrupted JSON file is handled gracefully", () => {
  const { store, file, cleanup } = tmpStore();
  try {
    fs.writeFileSync(file, "NOT VALID JSON {{{");
    const loaded = store.load();
    assert.equal(loaded.structures.length, 0);
    assert.equal(loaded.deaths.length, 0);
  } finally {
    cleanup();
  }
});

test("memory: missing file returns default memory", () => {
  const { store, cleanup } = tmpStore();
  try {
    const loaded = store.load();
    assert.equal(loaded.structures.length, 0);
    assert.equal(loaded.skillHistory.length, 0);
  } finally {
    cleanup();
  }
});

// ── Lessons ─────────────────────────────────────────────────────────────────

test("memory: addLesson stores and caps at 20", () => {
  const { store, cleanup } = tmpStore();
  try {
    for (let i = 0; i < 25; i++) {
      store.addLesson(`Lesson ${i}`);
    }
    const ctx = store.getMemoryContext();
    assert.ok(ctx.includes("Lesson 24"));
    assert.ok(!ctx.includes("Lesson 0"));
  } finally {
    cleanup();
  }
});

// ── Season goal ─────────────────────────────────────────────────────────────

test("memory: season goal set and get", () => {
  const { store, cleanup } = tmpStore();
  try {
    assert.equal(store.getSeasonGoal(), undefined);
    store.setSeasonGoal("Build a castle");
    assert.equal(store.getSeasonGoal(), "Build a castle");
    store.clearSeasonGoal();
    assert.equal(store.getSeasonGoal(), undefined);
  } finally {
    cleanup();
  }
});

// ── Hierarchical objective commitment ──────────────────────────────────────

test("memory: objective and sub-objective survive a save/load round-trip", () => {
  const { store, file, cleanup } = tmpStore();
  try {
    store.chooseObjective("food_production", "The settlement needs renewable food.");
    store.chooseSubobjective("prepare_farm_supplies");

    const { store: reloaded } = tmpStore();
    (reloaded as any).memoryFile = file;
    reloaded.load();

    assert.equal(reloaded.getObjectiveCommitment()?.objectiveId, "food_production");
    assert.equal(reloaded.getObjectiveCommitment()?.subobjectiveId, "prepare_farm_supplies");
    assert.match(reloaded.getMemoryContext(), /food_production → prepare_farm_supplies/);

    reloaded.clearObjectiveSubobjective();
    assert.equal(reloaded.getObjectiveCommitment()?.objectiveId, "food_production");
    assert.equal(reloaded.getObjectiveCommitment()?.subobjectiveId, undefined);
  } finally {
    cleanup();
  }
});

// ── getMemoryContext ────────────────────────────────────────────────────────

test("memory: getMemoryContext returns 'No memory yet.' when empty", () => {
  const { store, cleanup } = tmpStore();
  try {
    const ctx = store.getMemoryContext();
    assert.equal(ctx, "No memory yet.");
  } finally {
    cleanup();
  }
});

test("memory: getMemoryContext includes recent actions", () => {
  const { store, cleanup } = tmpStore();
  try {
    store.recordSkillAttempt("gather_wood", true, 10, "got 5 logs");
    const ctx = store.getMemoryContext();
    assert.ok(ctx.includes("LAST"));
    assert.ok(ctx.includes("gather_wood"));
  } finally {
    cleanup();
  }
});

test("memory: getMemoryContext shows houses built", () => {
  const { store, cleanup } = tmpStore();
  try {
    store.addStructure("house", 10, 64, 20);
    const ctx = store.getMemoryContext();
    assert.ok(ctx.includes("HOUSES BUILT"));
  } finally {
    cleanup();
  }
});

// ── Static skill healing on load ────────────────────────────────────────────

test("memory: static skills are healed from brokenSkillNames on load", () => {
  const { store, file, cleanup } = tmpStore();
  try {
    const data = {
      structures: [],
      deaths: [],
      oreDiscoveries: [],
      skillHistory: [],
      lessons: [],
      lastUpdated: new Date().toISOString(),
      brokenSkillNames: ["build_house", "some_dynamic_skill"],
    };
    fs.writeFileSync(file, JSON.stringify(data));
    const loaded = store.load();
    assert.ok(!loaded.brokenSkillNames.includes("build_house"));
    assert.ok(loaded.brokenSkillNames.includes("some_dynamic_skill"));
  } finally {
    cleanup();
  }
});

// ── healBrokenSkillsFromRegistry ────────────────────────────────────────────

test("memory: healBrokenSkillsFromRegistry removes registered skills", () => {
  const { store, file, cleanup } = tmpStore();
  try {
    const data = {
      structures: [],
      deaths: [],
      oreDiscoveries: [],
      skillHistory: [],
      lessons: [],
      lastUpdated: new Date().toISOString(),
      brokenSkillNames: ["my_dynamic_skill", "other_skill"],
    };
    fs.writeFileSync(file, JSON.stringify(data));
    store.load();
    store.healBrokenSkillsFromRegistry(new Set(["my_dynamic_skill"]));
    const broken = store.getPersistentBrokenSkillNames();
    assert.ok(!broken.has("my_dynamic_skill"));
    assert.ok(broken.has("other_skill"));
  } finally {
    cleanup();
  }
});

test("memory: scoped survey and safety evidence persists without duplicate identifiers", () => {
  const { store, cleanup } = tmpStore();
  try {
    store.recordScoutSector("north", { x: 132, y: 70, z: 115 }, { x: 130, y: 72, z: 120 }, ["trees", "water", "trees"]);
    store.recordScoutSector("north", { x: 132, y: 70, z: 115 }, { x: 131, y: 71, z: 117 }, ["iron"]);
    store.recordSafetyZone("core", { x: 132, y: 70, z: 179 }, 8);
    store.recordSafetyZone("core", { x: 132, y: 70, z: 179 }, 12);

    assert.equal(store.getScoutSectors().length, 1);
    assert.deepEqual(store.getScoutSectors()[0].observations, ["iron"]);
    assert.equal(store.getSafetyZones().length, 1);
    assert.equal(store.getSafetyZones()[0].torchesPlaced, 12);
  } finally {
    cleanup();
  }
});

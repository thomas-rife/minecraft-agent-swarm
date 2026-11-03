import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProgressionView,
  reconcileProgression,
  renderProgressionReport,
  type ProgressionObservations,
} from "./progression-runtime.js";
import {
  buildObjectiveDecisionMenu,
  getAutomaticSubobjectiveDecision,
  reconcileObjectiveCommitment,
  type ObjectiveSnapshot,
} from "./objective-tree.js";

const observed: ProgressionObservations = {
  logs: 0,
  craftingStation: false,
  pickaxeRank: 0,
  shelter: false,
  expandedHouse: false,
  operatedFurnace: false,
  fuel: 0,
  renewableFood: false,
  sharedStorage: false,
  ironProtection: false,
  waterBucket: false,
};

function snapshot(overrides: Partial<ObjectiveSnapshot> = {}): ObjectiveSnapshot {
  return {
    botName: "Mason",
    role: "Builder",
    inventory: {},
    teamInventory: {},
    stashInventory: {},
    structures: { house: "missing", farm: "missing", warehouse: "missing", workshop: "missing", mine: "missing" },
    stashExists: false,
    stashFreeSlots: null,
    stashTotalSlots: null,
    shelterLit: false,
    ironToolEstablished: false,
    furnaceEstablished: false,
    usableFarmSite: false,
    nearbyWater: false,
    visibleTrees: true,
    nearbyCraftingTable: false,
    nearFarm: false,
    scoutedSectors: 0,
    safetyZones: new Set(),
    nearbyAnimals: {},
    animalPens: new Set(),
    farmLedgerReady: false,
    farmPlotsTotal: 0,
    farmPlotsNeedingRepair: 0,
    matureWheatNearby: 0,
    inventoryStacks: 0,
    inventoryItems: 0,
    recentlyFailed: new Set(),
    teamCommitments: [],
    ...overrides,
  };
}

test("live menu exposes starter stage and builder objective rather than legacy domains", () => {
  const state = { completedObjectives: [] };
  const menu = buildObjectiveDecisionMenu(buildProgressionView(snapshot(), state), []);
  assert.deepEqual(menu[0].allowedParams?.objective, ["first_shelter"]);
  const commitment = { objectiveId: "first_shelter" as const, reason: "Build", startedAt: "now", updatedAt: "now" };
  const branches = buildObjectiveDecisionMenu(buildProgressionView(snapshot(), state, commitment), []);
  assert.deepEqual(branches[0].allowedParams?.subobjective, ["progression:starter_shelter"]);
});

test("starter house dispatches an executable bounded material procedure", () => {
  const commitment = {
    objectiveId: "first_shelter" as const,
    subobjectiveId: "progression:starter_shelter",
    reason: "Build",
    startedAt: "now",
    updatedAt: "now",
  };
  const view = buildProgressionView(snapshot(), { completedObjectives: [] }, commitment);
  assert.equal(getAutomaticSubobjectiveDecision(view, [])?.action, "gather_wood");
});

test("missing house evidence keeps stone locked; verification unlocks it and survives supply loss", () => {
  let state = reconcileProgression(
    { completedObjectives: [] },
    { ...observed, logs: 16, craftingStation: true, pickaxeRank: 1 },
  );
  assert.equal(buildProgressionView(snapshot(), state).objectives[1].available, false);
  state = reconcileProgression(state, { ...observed, shelter: true });
  assert.equal(buildProgressionView(snapshot(), state).objectives[1].available, true);
  assert.deepEqual(reconcileProgression(state, observed), state);
  assert.match(renderProgressionReport(state), /First shelter: complete/);
});

test("new verified milestone releases its active procedure", () => {
  const state = { completedObjectives: ["starter_shelter"] };
  const commitment = {
    objectiveId: "first_shelter" as const,
    subobjectiveId: "progression:starter_shelter",
    reason: "Build",
    startedAt: "now",
    updatedAt: "now",
  };
  const result = reconcileObjectiveCommitment(buildProgressionView(snapshot(), state, commitment));
  assert.equal(result.commitment?.subobjectiveId, undefined);
  assert.match(result.reason ?? "", /complete/);
});

test("claims prevent two workers selecting the same objective", () => {
  const commitment = { objectiveId: "first_shelter" as const, reason: "Build", startedAt: "now", updatedAt: "now" };
  const view = buildProgressionView(
    snapshot({ teamCommitments: [{ name: "Other", subobjectiveId: "progression:starter_shelter" }] }),
    { completedObjectives: [] },
    commitment,
  );
  assert.equal(
    view.activeObjective?.subobjectives.find((sub) => sub.id === "progression:starter_shelter")?.relevant,
    false,
  );
});

test("no actionable stage does not expose arbitrary later skills", () => {
  const view = buildProgressionView(
    snapshot({
      recentlyFailed: new Set([
        "objective:progression:wood_supply",
        "objective:progression:crafting_station",
        "objective:progression:wooden_pickaxe",
        "objective:progression:starter_shelter",
      ]),
    }),
    { completedObjectives: [] },
  );
  const menu = buildObjectiveDecisionMenu(view, [
    {
      action: "invoke_skill",
      skill: "strip_mine",
      signature: 'invoke_skill {"skill":"strip_mine"}',
      description: "Mine",
    },
  ]);
  assert.deepEqual(
    menu.map((option) => option.action),
    ["idle"],
  );
});

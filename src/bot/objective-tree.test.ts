import assert from "node:assert/strict";
import test from "node:test";
import {
  buildObjectiveDecisionMenu,
  evaluateObjectiveTree,
  getAutomaticSubobjectiveDecision,
  reconcileObjectiveCommitment,
  type ObjectiveCommitment,
  type ObjectiveSnapshot,
} from "./objective-tree.js";
import type { ActionOption } from "./action-menu.js";
import { buildProgressionView } from "./progression-runtime.js";

function snapshot(overrides: Partial<ObjectiveSnapshot> = {}): ObjectiveSnapshot {
  return {
    botName: "Flora",
    role: "Farmer / Crafter",
    inventory: {},
    teamInventory: {},
    stashInventory: {},
    structures: {
      house: "missing",
      farm: "missing",
      warehouse: "missing",
      workshop: "missing",
      mine: "missing",
    },
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
    farmLocation: { x: 132, y: 70, z: 179 },
    houseLocation: undefined,
    mineLocation: undefined,
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

function commitment(objectiveId: ObjectiveCommitment["objectiveId"], subobjectiveId?: string): ObjectiveCommitment {
  return {
    objectiveId,
    subobjectiveId,
    reason: "The settlement needs it.",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const baseOptions: ActionOption[] = [
  {
    action: "explore",
    signature: 'explore {"direction":"north"}',
    description: "Explore.",
  },
  {
    action: "eat",
    signature: "eat {}",
    description: "Eat.",
  },
];

test("the LLM sees objectives first, not terminal Mineflayer skills", () => {
  const view = evaluateObjectiveTree(snapshot());
  const menu = buildObjectiveDecisionMenu(view, baseOptions);

  assert.deepEqual(
    menu.map((option) => option.action),
    ["eat", "choose_objective"],
  );
  assert.ok(
    menu.find((option) => option.action === "choose_objective")?.allowedParams?.objective.includes("food_production"),
  );
});

test("after choosing an objective, the LLM sees only its relevant sub-objectives", () => {
  const view = evaluateObjectiveTree(snapshot(), commitment("food_production"));
  const menu = buildObjectiveDecisionMenu(view, baseOptions);

  assert.deepEqual(
    menu.map((option) => option.action),
    ["eat", "choose_subobjective", "leave_objective"],
  );
  const allowed = menu.find((option) => option.action === "choose_subobjective")?.allowedParams?.subobjective ?? [];
  assert.ok(allowed.includes("prepare_farm_supplies"));
  assert.ok(allowed.includes("locate_farm_site"));
  assert.ok(!allowed.includes("deposit_surplus"));
});

test("an active sub-objective chooses its mechanical leaf without asking the LLM", () => {
  const view = evaluateObjectiveTree(
    snapshot({ visibleTrees: true }),
    commitment("food_production", "prepare_farm_supplies"),
  );
  const decision = getAutomaticSubobjectiveDecision(view, baseOptions);

  assert.equal(decision?.action, "gather_wood");
  assert.equal(decision?.params.count, 2);
});

test("farm-supply execution advances through crafting prerequisites from observed state", () => {
  const active = commitment("food_production", "prepare_farm_supplies");

  const sticks = getAutomaticSubobjectiveDecision(
    evaluateObjectiveTree(snapshot({ inventory: { oak_planks: 8 } }), active),
    baseOptions,
  );
  assert.deepEqual({ action: sticks?.action, item: sticks?.params.item }, { action: "craft", item: "stick" });

  const table = getAutomaticSubobjectiveDecision(
    evaluateObjectiveTree(snapshot({ inventory: { oak_planks: 8, stick: 4 } }), active),
    baseOptions,
  );
  assert.deepEqual({ action: table?.action, item: table?.params.item }, { action: "craft", item: "crafting_table" });

  const hoe = getAutomaticSubobjectiveDecision(
    evaluateObjectiveTree(snapshot({ inventory: { oak_planks: 8, stick: 4, crafting_table: 1 } }), active),
    baseOptions,
  );
  assert.deepEqual({ action: hoe?.action, item: hoe?.params.item }, { action: "craft", item: "wooden_hoe" });

  const seeds = getAutomaticSubobjectiveDecision(
    evaluateObjectiveTree(snapshot({ inventory: { oak_planks: 8, wooden_hoe: 1 } }), active),
    baseOptions,
  );
  assert.deepEqual(
    { action: seeds?.action, skill: seeds?.params.skill },
    { action: "invoke_skill", skill: "gather_seeds" },
  );
});

test("a build sub-objective directly invokes its fixed Mineflayer procedure", () => {
  const view = evaluateObjectiveTree(
    snapshot({ nearbyWater: true, usableFarmSite: true }),
    commitment("food_production", "establish_wheat_farm"),
  );
  const menu = buildObjectiveDecisionMenu(view, baseOptions);
  const decision = getAutomaticSubobjectiveDecision(view, baseOptions);

  assert.ok(!menu.some((option) => option.action === "choose_subobjective"));
  assert.equal(decision?.action, "invoke_skill");
  assert.equal(decision?.params.skill, "build_farm");
});

test("crafting station places a carried table locally even far from the settlement", () => {
  const state = snapshot({
    inventory: { crafting_table: 1, oak_log: 2, stick: 2 },
    teamInventory: { crafting_table: 1, oak_log: 2, stick: 2 },
    position: { x: 63, y: 65, z: 42 },
    settlementAnchor: { x: 132, y: 70, z: 179 },
  });
  const active = commitment("first_shelter", "progression:crafting_station");
  const view = buildProgressionView(state, { completedObjectives: ["wood_supply"] }, active);
  const decision = getAutomaticSubobjectiveDecision(view, baseOptions);
  assert.equal(decision?.action, "place_block");
  assert.deepEqual(decision?.params, { blockType: "crafting_table" });
});

test("death recovery rebuilds mining prerequisites without replaying the completed shelter", () => {
  const active = commitment("stone_survival", "progression:stone_pickaxe");
  const completedObjectives = ["wood_supply", "crafting_station", "wooden_pickaxe", "starter_shelter"];
  const next = (inventory: Record<string, number>, visibleTrees = true) =>
    getAutomaticSubobjectiveDecision(
      buildProgressionView(
        snapshot({ inventory, visibleTrees, structures: { ...snapshot().structures, house: "complete" } }),
        { completedObjectives },
        active,
      ),
      baseOptions,
    );

  assert.equal(next({}, false)?.action, "explore");
  assert.equal(next({})?.action, "gather_wood");
  assert.equal(next({ oak_planks: 8 })?.params.item, "stick");
  assert.equal(next({ oak_planks: 8, stick: 4 })?.params.item, "crafting_table");
  assert.equal(next({ oak_planks: 8, stick: 4, crafting_table: 1 })?.params.item, "wooden_pickaxe");
  assert.equal(next({ wooden_pickaxe: 1 })?.params.skill, "strip_mine");
  assert.equal(
    next({ wooden_pickaxe: 1, cobblestone: 3, oak_planks: 4, stick: 2, crafting_table: 1 })?.params.item,
    "stone_pickaxe",
  );
});

test("mining fuel after inventory loss rebuilds a pickaxe before invoking a mining skill", () => {
  const view = buildProgressionView(
    snapshot(),
    { completedObjectives: ["wood_supply", "crafting_station", "wooden_pickaxe", "starter_shelter"] },
    commitment("stone_survival", "progression:fuel_supply"),
  );
  const decision = getAutomaticSubobjectiveDecision(view, baseOptions);
  assert.equal(decision?.action, "gather_wood");
});

test("arbitrary nearby water does not unlock farm construction", () => {
  const view = evaluateObjectiveTree(
    snapshot({ nearbyWater: true, usableFarmSite: false }),
    commitment("food_production"),
  );
  const available =
    buildObjectiveDecisionMenu(view, baseOptions)
      .find((option) => option.action === "choose_subobjective")
      ?.allowedParams?.subobjective ?? [];

  assert.ok(available.includes("locate_farm_site"));
  assert.ok(!available.includes("establish_wheat_farm"));
});

test("farm-site discovery is a deterministic skill, not an unconstrained explore choice", () => {
  const view = evaluateObjectiveTree(
    snapshot(),
    commitment("food_production", "locate_farm_site"),
  );
  const decision = getAutomaticSubobjectiveDecision(view, baseOptions);

  assert.equal(decision?.action, "invoke_skill");
  assert.equal(decision?.params.skill, "locate_farm_site");
});

test("a fully blocked objective is cleared and is not immediately re-offered", () => {
  const blocked = snapshot({
    inventory: { oak_planks: 8, wooden_hoe: 1, wheat_seeds: 4 },
    recentlyFailed: new Set(["objective:locate_farm_site"]),
  });
  const reconciliation = reconcileObjectiveCommitment(
    evaluateObjectiveTree(blocked, commitment("food_production")),
  );
  const menu = buildObjectiveDecisionMenu(evaluateObjectiveTree(blocked), baseOptions);
  const objectives =
    menu.find((option) => option.action === "choose_objective")?.allowedParams?.objective ?? [];

  assert.equal(reconciliation.commitment, undefined);
  assert.match(reconciliation.reason ?? "", /no unblocked actionable branch/i);
  assert.ok(!objectives.includes("food_production"));
});

test("active team claims reserve one-worker objectives and roles prefer their own work", () => {
  const floraMenu = buildObjectiveDecisionMenu(
    evaluateObjectiveTree(
      snapshot({
        teamCommitments: [{ name: "OtherFlora", objectiveId: "food_production" }],
      }),
    ),
    baseOptions,
  );
  const floraChoices =
    floraMenu.find((option) => option.action === "choose_objective")?.allowedParams?.objective ?? [];
  assert.ok(!floraChoices.includes("food_production"));

  const minerMenu = buildObjectiveDecisionMenu(
    evaluateObjectiveTree(
      snapshot({
        botName: "Forge",
        role: "Miner / Smelter",
        inventory: { wooden_pickaxe: 1 },
        teamInventory: { wooden_pickaxe: 1 },
      }),
    ),
    baseOptions,
  );
  assert.deepEqual(
    minerMenu.find((option) => option.action === "choose_objective")?.allowedParams?.objective,
    ["resource_development", "equipment_progression"],
  );
});

test("a wrong-role legacy commitment is released when preferred work is available", () => {
  const state = snapshot({
    botName: "Mason",
    role: "Builder",
  });
  const result = reconcileObjectiveCommitment(
    evaluateObjectiveTree(state, commitment("resource_development")),
  );

  assert.equal(result.commitment, undefined);
  assert.match(result.reason ?? "", /released.*Builder work/i);
});

test("completion evidence returns control at the correct hierarchy level", () => {
  const suppliesReady = snapshot({
    inventory: { oak_planks: 8, wooden_hoe: 1, wheat_seeds: 4 },
  });
  const subResult = reconcileObjectiveCommitment(
    evaluateObjectiveTree(suppliesReady, commitment("food_production", "prepare_farm_supplies")),
  );
  assert.equal(subResult.commitment?.objectiveId, "food_production");
  assert.equal(subResult.commitment?.subobjectiveId, undefined);

  const farmDone = snapshot({
    structures: {
      house: "missing",
      farm: "complete",
      warehouse: "missing",
      workshop: "missing",
      mine: "missing",
    },
  });
  const objectiveResult = reconcileObjectiveCommitment(
    evaluateObjectiveTree(farmDone, commitment("food_production", "establish_wheat_farm")),
  );
  assert.equal(objectiveResult.commitment, undefined);
  assert.match(objectiveResult.reason ?? "", /complete/i);
});

test("resource development exposes staged mining choices before recurring supply", () => {
  const view = evaluateObjectiveTree(
    snapshot({
      botName: "Forge",
      role: "Miner / Smelter",
      inventory: { wooden_pickaxe: 1 },
      teamInventory: { wooden_pickaxe: 1 },
    }),
  );
  const development = view.objectives.find((objective) => objective.id === "resource_development");
  const supply = view.objectives.find((objective) => objective.id === "resource_supply");

  assert.equal(development?.available, true);
  assert.equal(development?.complete, false);
  assert.equal(supply?.available, false);
  assert.deepEqual(
    development?.subobjectives
      .filter((subobjective) => subobjective.relevant && !subobjective.complete)
      .map((subobjective) => subobjective.id),
    ["establish_shared_mine"],
  );
});

test("the shared-mine sub-objective deterministically invokes a general mining run", () => {
  const state = snapshot({
    botName: "Forge",
    role: "Miner / Smelter",
    inventory: { stone_pickaxe: 1 },
    teamInventory: { stone_pickaxe: 1 },
  });
  const decision = getAutomaticSubobjectiveDecision(
    evaluateObjectiveTree(state, commitment("resource_development", "establish_shared_mine")),
    baseOptions,
  );

  assert.equal(decision?.action, "invoke_skill");
  assert.deepEqual(decision?.params, { skill: "strip_mine", target: "general", targetCount: "64" });
});

test("resource development completes from durable mine, fuel, and upgraded-tool evidence", () => {
  const ready = snapshot({
    structures: {
      house: "missing",
      farm: "missing",
      warehouse: "missing",
      workshop: "missing",
      mine: "complete",
    },
    inventory: { iron_pickaxe: 1, coal: 16 },
    teamInventory: { iron_pickaxe: 1, coal: 16 },
    stashExists: true,
    furnaceEstablished: true,
  });
  const view = evaluateObjectiveTree(ready);

  assert.equal(view.objectives.find((objective) => objective.id === "resource_development")?.complete, true);
  assert.equal(view.objectives.find((objective) => objective.id === "resource_supply")?.available, true);
});

test("resource supply targets measured deficits and disappears at reserve thresholds", () => {
  const developed = {
    structures: {
      house: "complete" as const,
      farm: "missing" as const,
      warehouse: "missing" as const,
      workshop: "missing" as const,
      mine: "complete" as const,
    },
    inventory: { iron_pickaxe: 1 },
    teamInventory: { iron_pickaxe: 1 },
    stashExists: true,
    furnaceEstablished: true,
  };
  const shortageView = evaluateObjectiveTree(snapshot(developed));
  const supply = shortageView.objectives.find((objective) => objective.id === "resource_supply");
  assert.deepEqual(
    supply?.subobjectives
      .filter((subobjective) => subobjective.relevant && !subobjective.complete)
      .map((subobjective) => subobjective.id),
    ["replenish_fuel", "replenish_iron", "replenish_construction_stone"],
  );

  const stockedView = evaluateObjectiveTree(
    snapshot({
      ...developed,
      stashInventory: { coal: 32, iron_ingot: 12, cobblestone: 128 },
    }),
  );
  assert.equal(stockedView.objectives.find((objective) => objective.id === "resource_supply")?.available, false);
  assert.equal(stockedView.objectives.find((objective) => objective.id === "resource_supply")?.complete, true);
});

test("a broken pickaxe becomes supply maintenance instead of erasing mining progression", () => {
  const view = evaluateObjectiveTree(
    snapshot({
      structures: {
        house: "missing",
        farm: "missing",
        warehouse: "missing",
        workshop: "missing",
        mine: "complete",
      },
      ironToolEstablished: true,
      furnaceEstablished: true,
      inventory: {},
      teamInventory: {},
      stashInventory: { coal: 32, iron_ingot: 12 },
    }),
  );
  const development = view.objectives.find((objective) => objective.id === "resource_development");
  const supply = view.objectives.find((objective) => objective.id === "resource_supply");

  assert.equal(development?.complete, true);
  assert.equal(supply?.available, true);
  assert.deepEqual(
    supply?.subobjectives
      .filter((subobjective) => subobjective.relevant && !subobjective.complete)
      .map((subobjective) => subobjective.id),
    ["replace_mining_tools"],
  );
});

test("stash expansion invokes setup_stash in verified expansion mode", () => {
  const state = snapshot({
    botName: "Mason",
    role: "Builder",
    inventory: { oak_planks: 8 },
    teamInventory: { oak_planks: 8 },
    stashExists: true,
    stashFreeSlots: 4,
    stashTotalSlots: 54,
  });
  const decision = getAutomaticSubobjectiveDecision(
    evaluateObjectiveTree(state, commitment("storage", "expand_stash")),
    baseOptions,
  );
  assert.equal(decision?.action, "invoke_skill");
  assert.deepEqual(decision?.params, { skill: "setup_stash", mode: "expand" });
});

test("food stocking deposits only pantry surplus and preserves a personal reserve", () => {
  const state = snapshot({
    structures: {
      house: "complete",
      farm: "complete",
      warehouse: "missing",
      workshop: "missing",
      mine: "missing",
    },
    inventory: { bread: 50 },
    teamInventory: { bread: 50 },
    stashExists: true,
    farmLedgerReady: true,
  });
  const decision = getAutomaticSubobjectiveDecision(
    evaluateObjectiveTree(state, commitment("food_maintenance", "stock_food")),
    baseOptions,
  );

  assert.equal(decision?.action, "deposit_stash");
  assert.deepEqual(decision?.params, { mode: "pantry" });
});

test("storage pressure follows occupied slots instead of total item count", () => {
  const roomy = evaluateObjectiveTree(
    snapshot({
      stashExists: true,
      inventory: { wheat_seeds: 512 },
      inventoryStacks: 8,
      inventoryItems: 512,
    }),
  );
  const crowded = evaluateObjectiveTree(
    snapshot({
      stashExists: true,
      inventoryStacks: 30,
      inventoryItems: 30,
    }),
  );

  assert.equal(roomy.objectives.find((objective) => objective.id === "storage")?.available, false);
  assert.equal(crowded.objectives.find((objective) => objective.id === "storage")?.available, true);
});

test("farm maintenance uses the narrow maintenance procedure, not farm construction", () => {
  const state = snapshot({
    structures: {
      house: "missing",
      farm: "complete",
      warehouse: "missing",
      workshop: "missing",
      mine: "missing",
    },
    nearFarm: true,
    inventory: { wooden_hoe: 1 },
    teamInventory: { wooden_hoe: 1 },
    farmLedgerReady: true,
    farmPlotsTotal: 16,
    matureWheatNearby: 6,
  });
  const decision = getAutomaticSubobjectiveDecision(
    evaluateObjectiveTree(state, commitment("food_maintenance", "harvest_and_replant")),
    baseOptions,
  );
  assert.equal(decision?.action, "invoke_skill");
  assert.deepEqual(decision?.params, { skill: "maintain_farm" });
});

test("legacy farms stay in maintenance until their exact plots are reconciled", () => {
  const state = snapshot({
    structures: {
      house: "missing",
      farm: "complete",
      warehouse: "missing",
      workshop: "missing",
      mine: "missing",
    },
    stashInventory: { bread: 8 },
    farmLedgerReady: false,
  });
  const view = evaluateObjectiveTree(state);
  const objective = view.objectives.find((entry) => entry.id === "food_maintenance");
  assert.equal(objective?.available, true);
  assert.equal(objective?.subobjectives.find((entry) => entry.id === "harvest_and_replant")?.relevant, true);
});

test("empty or trampled ledger plots trigger repair even with enough food", () => {
  const state = snapshot({
    structures: {
      house: "missing",
      farm: "complete",
      warehouse: "missing",
      workshop: "missing",
      mine: "missing",
    },
    stashInventory: { bread: 8 },
    farmLedgerReady: true,
    farmPlotsTotal: 16,
    farmPlotsNeedingRepair: 3,
  });
  const objective = evaluateObjectiveTree(state).objectives.find((entry) => entry.id === "food_maintenance");
  assert.equal(objective?.available, true);
  assert.equal(objective?.subobjectives.find((entry) => entry.id === "harvest_and_replant")?.complete, false);
});

test("farm repair obtains a hoe and exact seeds before invoking maintenance", () => {
  const active = commitment("food_maintenance", "harvest_and_replant");
  const baseState = {
    structures: {
      house: "missing" as const,
      farm: "complete" as const,
      warehouse: "missing" as const,
      workshop: "missing" as const,
      mine: "missing" as const,
    },
    nearFarm: true,
    farmLedgerReady: true,
    farmPlotsTotal: 16,
    farmPlotsNeedingRepair: 3,
  };

  const needHoe = getAutomaticSubobjectiveDecision(
    evaluateObjectiveTree(snapshot({ ...baseState, stashInventory: { wooden_hoe: 1 } }), active),
    baseOptions,
  );
  assert.deepEqual(
    { action: needHoe?.action, item: needHoe?.params.item },
    { action: "withdraw_stash", item: "wooden_hoe" },
  );

  const needSeeds = getAutomaticSubobjectiveDecision(
    evaluateObjectiveTree(
      snapshot({ ...baseState, inventory: { wooden_hoe: 1 }, stashInventory: { wheat_seeds: 8 } }),
      active,
    ),
    baseOptions,
  );
  assert.deepEqual(
    { action: needSeeds?.action, item: needSeeds?.params.item, count: needSeeds?.params.count },
    { action: "withdraw_stash", item: "wheat_seeds", count: 3 },
  );
});

test("lighting obtains torches rather than invoking light_area empty-handed", () => {
  const state = snapshot({
    structures: {
      house: "missing",
      farm: "missing",
      warehouse: "missing",
      workshop: "missing",
      mine: "complete",
    },
    stashInventory: { torch: 12 },
  });
  const active = commitment("settlement_safety", "light_mine_zone");
  const withdraw = getAutomaticSubobjectiveDecision(evaluateObjectiveTree(state, active), baseOptions);
  assert.deepEqual(
    { action: withdraw?.action, item: withdraw?.params.item, count: withdraw?.params.count },
    { action: "withdraw_stash", item: "torch", count: 8 },
  );

  const execute = getAutomaticSubobjectiveDecision(
    evaluateObjectiveTree(snapshot({ ...state, inventory: { torch: 8 }, stashInventory: {} }), active),
    baseOptions,
  );
  assert.deepEqual(execute?.params, { skill: "light_area", safetyZone: "mine" });
});

test("smelting establishes its cobblestone and fuel prerequisites first", () => {
  const active = commitment("resource_development", "smelt_starter_iron");
  const needCobble = getAutomaticSubobjectiveDecision(
    evaluateObjectiveTree(
      snapshot({
        structures: {
          house: "missing",
          farm: "missing",
          warehouse: "missing",
          workshop: "missing",
          mine: "complete",
        },
        inventory: { raw_iron: 3, coal: 8, stone_pickaxe: 1 },
        stashInventory: { cobblestone: 8 },
      }),
      active,
    ),
    baseOptions,
  );
  assert.deepEqual(
    { action: needCobble?.action, item: needCobble?.params.item },
    { action: "withdraw_stash", item: "cobblestone" },
  );
});

test("a healthy reconciled farm can wait when food is sufficient", () => {
  const state = snapshot({
    structures: {
      house: "missing",
      farm: "complete",
      warehouse: "missing",
      workshop: "missing",
      mine: "missing",
    },
    stashInventory: { bread: 8 },
    farmLedgerReady: true,
    farmPlotsTotal: 16,
    farmPlotsNeedingRepair: 0,
    matureWheatNearby: 0,
  });
  const objective = evaluateObjectiveTree(state).objectives.find((entry) => entry.id === "food_maintenance");
  assert.equal(objective?.complete, true);
  assert.equal(objective?.available, false);
});

test("equipment work orders supply prerequisites before invoking craft_gear", () => {
  const decision = getAutomaticSubobjectiveDecision(
    evaluateObjectiveTree(snapshot(), commitment("equipment_progression", "establish_work_kit")),
    baseOptions,
  );
  assert.equal(decision?.action, "gather_wood");

  const supplied = getAutomaticSubobjectiveDecision(
    evaluateObjectiveTree(
      snapshot({
        inventory: { cobblestone: 8, stick: 6, crafting_table: 1 },
        teamInventory: { cobblestone: 8, stick: 6, crafting_table: 1 },
      }),
      commitment("equipment_progression", "establish_work_kit"),
    ),
    baseOptions,
  );
  assert.equal(supplied?.action, "invoke_skill");
  assert.deepEqual(supplied?.params, { skill: "craft_gear", target: "work_kit" });
});

test("regional survey closes after eight durable bounded sectors", () => {
  const incomplete = evaluateObjectiveTree(snapshot({ scoutedSectors: 7 }));
  assert.equal(incomplete.objectives.find((objective) => objective.id === "regional_survey")?.available, true);
  const complete = evaluateObjectiveTree(snapshot({ scoutedSectors: 8 }));
  assert.equal(complete.objectives.find((objective) => objective.id === "regional_survey")?.complete, true);
});

test("equipment progression uses the acting bot inventory and resource gates iron tiers", () => {
  const basic = evaluateObjectiveTree(
    snapshot({
      inventory: { stone_pickaxe: 1, stone_axe: 1, stone_sword: 1 },
      teamInventory: { stone_pickaxe: 1, stone_axe: 1, stone_sword: 1 },
    }),
  );
  assert.equal(basic.objectives.find((objective) => objective.id === "equipment_progression")?.available, false);

  const ironReady = evaluateObjectiveTree(
    snapshot({
      inventory: { stone_pickaxe: 1, stone_axe: 1, stone_sword: 1 },
      teamInventory: { stone_pickaxe: 1, stone_axe: 1, stone_sword: 1 },
      stashInventory: { iron_ingot: 6 },
    }),
  );
  assert.deepEqual(
    ironReady.objectives
      .find((objective) => objective.id === "equipment_progression")
      ?.subobjectives.filter((subobjective) => subobjective.relevant && !subobjective.complete)
      .map((subobjective) => subobjective.id),
    ["upgrade_iron_tools"],
  );
});

test("settlement safety tracks each completed zone independently", () => {
  const state = snapshot({
    structures: {
      house: "complete",
      farm: "complete",
      warehouse: "missing",
      workshop: "missing",
      mine: "complete",
    },
    safetyZones: new Set(["core", "lodge", "farm"]),
  });
  const safety = evaluateObjectiveTree(state).objectives.find((objective) => objective.id === "settlement_safety");
  assert.equal(safety?.complete, false);
  assert.equal(safety?.available, true);
  assert.deepEqual(
    safety?.subobjectives
      .filter((subobjective) => subobjective.relevant && !subobjective.complete)
      .map((subobjective) => subobjective.id),
    ["light_mine_zone"],
  );
});

test("animal husbandry is offered only for a visible feedable pair", () => {
  const state = snapshot({
    structures: {
      house: "missing",
      farm: "complete",
      warehouse: "missing",
      workshop: "missing",
      mine: "missing",
    },
    nearbyAnimals: { cow: 2 },
    stashInventory: { wheat: 2 },
  });
  const husbandry = evaluateObjectiveTree(state).objectives.find(
    (objective) => objective.id === "animal_husbandry",
  );
  assert.equal(husbandry?.available, true);
  assert.deepEqual(
    husbandry?.subobjectives
      .filter((subobjective) => subobjective.relevant && !subobjective.complete)
      .map((subobjective) => subobjective.id),
    ["establish_cow_pen"],
  );
});

test("a stocked farm waits for crops instead of sending Flora on food exploration", () => {
  const farmStructures = {
    house: "missing" as const,
    farm: "complete" as const,
    warehouse: "missing" as const,
    workshop: "missing" as const,
    mine: "missing" as const,
  };
  const stocked = snapshot({
    structures: farmStructures,
    inventory: { bread: 8 },
    teamInventory: { bread: 8 },
    farmLedgerReady: true,
    farmPlotsTotal: 16,
  });
  assert.equal(
    evaluateObjectiveTree(stocked).objectives.find((objective) => objective.id === "food_maintenance")?.available,
    false,
  );

  const lowFood = snapshot({
    structures: farmStructures,
    inventory: { bread: 7 },
    teamInventory: { bread: 7 },
    farmLedgerReady: true,
    farmPlotsTotal: 16,
  });
  const decision = getAutomaticSubobjectiveDecision(
    evaluateObjectiveTree(lowFood, commitment("food_maintenance", "supplement_food")),
    baseOptions,
  );
  assert.equal(decision, undefined, "supplement_food must not fall back to unbounded explore");
});

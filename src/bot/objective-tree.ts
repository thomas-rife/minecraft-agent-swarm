import type { ActionOption } from "./action-menu.js";
import { FARM_WOOD_TARGET, HOUSE_WOOD_TARGET, STASH_WOOD_TARGET } from "./goal-requirements.js";
import { PROGRESSION_TREE } from "./progression-tree.js";

const SETTLEMENT_WOOD_TARGET = 96;

export type ObjectiveId =
  | "first_shelter"
  | "stone_survival"
  | "established_base"
  | "iron_industry"
  | "nether_preparation"
  | "nether_expedition"
  | "food_production"
  | "food_maintenance"
  | "storage"
  | "resource_development"
  | "resource_supply"
  | "regional_survey"
  | "equipment_progression"
  | "settlement_safety"
  | "animal_husbandry"
  | "shelter"
  | "settlement";

export interface ObjectiveCommitment {
  objectiveId: ObjectiveId;
  subobjectiveId?: string;
  reason: string;
  startedAt: string;
  updatedAt: string;
}

export type StructureProgress = "missing" | "partial" | "complete";

export interface ObjectiveSnapshot {
  botName: string;
  role: string;
  /** Current and configured settlement positions used by deterministic return-home steps. */
  position?: { x: number; y: number; z: number };
  settlementAnchor?: { x: number; y: number; z: number };
  /** Items directly usable by this bot without a hand-off. */
  inventory: Record<string, number>;
  /** All carried team items, used for status reporting and coordination. */
  teamInventory: Record<string, number>;
  /** Last observed contents of the shared stash. */
  stashInventory: Record<string, number>;
  structures: {
    house: StructureProgress;
    farm: StructureProgress;
    warehouse: StructureProgress;
    workshop: StructureProgress;
    mine: StructureProgress;
  };
  stashExists: boolean;
  progressionStorage?: { chestCount: number; deposited: boolean; retrieved: boolean };
  stashFreeSlots: number | null;
  stashTotalSlots: number | null;
  shelterLit: boolean;
  /** Durable evidence that the team has successfully produced an iron-or-better pickaxe before. */
  ironToolEstablished: boolean;
  /** Durable evidence that a shared furnace station has been established. */
  furnaceEstablished: boolean;
  /** A specific exposed shore has been reached and persisted, not merely any water block observed. */
  usableFarmSite: boolean;
  nearbyWater: boolean;
  visibleTrees: boolean;
  nearbyCraftingTable: boolean;
  nearFarm: boolean;
  farmLocation?: { x: number; y: number; z: number };
  houseLocation?: { x: number; y: number; z: number };
  mineLocation?: { x: number; y: number; z: number };
  scoutedSectors: number;
  safetyZones: ReadonlySet<string>;
  nearbyAnimals: Record<string, number>;
  animalPens: ReadonlySet<string>;
  /** True once every established farm has exact persistent plot coordinates. */
  farmLedgerReady: boolean;
  farmPlotsTotal: number;
  farmPlotsNeedingRepair: number;
  matureWheatNearby: number;
  inventoryStacks: number;
  inventoryItems: number;
  recentlyFailed: ReadonlySet<string>;
  teamCommitments: {
    name: string;
    objectiveId?: string;
    subobjectiveId?: string;
  }[];
}

export interface EvaluatedSubobjective {
  id: string;
  label: string;
  description: string;
  complete: boolean;
  relevant: boolean;
}

export interface EvaluatedObjective {
  id: ObjectiveId;
  label: string;
  description: string;
  preferredRoles: string[];
  maxWorkers: number;
  status: string;
  complete: boolean;
  available: boolean;
  claimedBy: string[];
  subobjectives: EvaluatedSubobjective[];
}

export interface ObjectiveTreeView {
  progression?: boolean;
  snapshot: ObjectiveSnapshot;
  objectives: EvaluatedObjective[];
  commitment?: ObjectiveCommitment;
  activeObjective?: EvaluatedObjective;
  activeSubobjective?: EvaluatedSubobjective;
}

interface SubobjectiveDefinition {
  id: string;
  label: string;
  description: string;
  complete: (snapshot: ObjectiveSnapshot) => boolean;
  relevant: (snapshot: ObjectiveSnapshot) => boolean;
}

interface ObjectiveDefinition {
  id: ObjectiveId;
  label: string;
  description: string;
  preferredRoles: string[];
  maxWorkers: number;
  complete: (snapshot: ObjectiveSnapshot) => boolean;
  available: (snapshot: ObjectiveSnapshot) => boolean;
  status: (snapshot: ObjectiveSnapshot) => string;
  subobjectives: SubobjectiveDefinition[];
}

const FOOD_NAMES = new Set([
  "bread",
  "apple",
  "carrot",
  "baked_potato",
  "cooked_beef",
  "cooked_porkchop",
  "cooked_chicken",
  "cooked_mutton",
  "cooked_cod",
  "cooked_salmon",
  "beef",
  "porkchop",
  "chicken",
  "mutton",
  "cod",
  "salmon",
  "melon_slice",
  "sweet_berries",
]);

function countMatching(items: Record<string, number>, predicate: (name: string) => boolean): number {
  return Object.entries(items).reduce((total, [name, count]) => total + (predicate(name) ? count : 0), 0);
}

function countItem(snapshot: ObjectiveSnapshot, name: string, accessibleOnly = false): number {
  const direct = snapshot.inventory[name] ?? 0;
  const stash = snapshot.stashInventory[name] ?? 0;
  if (accessibleOnly) return direct + stash;
  return (snapshot.teamInventory[name] ?? direct) + stash;
}

function carriedCount(snapshot: ObjectiveSnapshot, names: readonly string[]): number {
  return names.reduce((total, name) => total + (snapshot.inventory[name] ?? 0), 0);
}

function storedItems(snapshot: ObjectiveSnapshot, predicate: (name: string) => boolean): string[] {
  return Object.keys(snapshot.stashInventory).filter(
    (name) => (snapshot.stashInventory[name] ?? 0) > 0 && predicate(name),
  );
}

function countFood(snapshot: ObjectiveSnapshot, accessibleOnly = false): number {
  const source = accessibleOnly ? snapshot.inventory : snapshot.teamInventory;
  return (
    countMatching(source, (name) => FOOD_NAMES.has(name)) +
    countMatching(snapshot.stashInventory, (name) => FOOD_NAMES.has(name))
  );
}

function carriedFood(snapshot: ObjectiveSnapshot): number {
  return countMatching(snapshot.inventory, (name) => FOOD_NAMES.has(name));
}

function woodEquivalent(items: Record<string, number>): number {
  return Object.entries(items).reduce((total, [name, count]) => {
    if (name.endsWith("_log") || name.endsWith("_stem") || name.endsWith("_hyphae")) return total + count * 4;
    if (name.endsWith("_planks")) return total + count;
    return total;
  }, 0);
}

function accessibleWood(snapshot: ObjectiveSnapshot): number {
  return woodEquivalent(snapshot.inventory) + woodEquivalent(snapshot.stashInventory);
}

function carriedWood(snapshot: ObjectiveSnapshot): number {
  return woodEquivalent(snapshot.inventory);
}

function stashWoodTarget(snapshot: ObjectiveSnapshot): number {
  return Math.max(0, STASH_WOOD_TARGET - (snapshot.inventory.chest ?? 0) * 8);
}

function stashWoodItems(snapshot: ObjectiveSnapshot): string[] {
  return Object.keys(snapshot.stashInventory).filter(
    (name) =>
      (snapshot.stashInventory[name] ?? 0) > 0 &&
      (name.endsWith("_log") || name.endsWith("_planks") || name.endsWith("_stem") || name.endsWith("_hyphae")),
  );
}

function hasHoe(snapshot: ObjectiveSnapshot): boolean {
  const has = (items: Record<string, number>) =>
    Object.entries(items).some(([name, count]) => count > 0 && name.endsWith("_hoe"));
  return has(snapshot.inventory) || has(snapshot.stashInventory);
}

function carriesHoe(snapshot: ObjectiveSnapshot): boolean {
  return Object.entries(snapshot.inventory).some(([name, count]) => count > 0 && name.endsWith("_hoe"));
}

function storagePressure(snapshot: ObjectiveSnapshot): boolean {
  if (snapshot.stashTotalSlots && snapshot.stashFreeSlots !== null) {
    return snapshot.stashFreeSlots <= Math.max(2, Math.ceil(snapshot.stashTotalSlots * 0.2));
  }
  return false;
}

function inventoryPressure(snapshot: ObjectiveSnapshot): boolean {
  // Minecraft inventory pressure is slot pressure, not raw item count. Eight
  // full stacks of seeds (512 items) still leave most of the inventory free;
  // the old item threshold repeatedly selected deposit_surplus for inventories
  // containing only protected reserves. Six free slots leaves room for drops.
  return snapshot.inventoryStacks >= 30;
}

function foodMaintenanceNeeded(snapshot: ObjectiveSnapshot): boolean {
  if (snapshot.structures.farm !== "complete") return false;
  // Once a renewable farm exists, eight prepared team meals are enough to
  // wait for crops. The former threshold of 16 kept Flora in supplement_food
  // and repeatedly sent her exploring far outside the farm while healthy
  // crops were already growing.
  return (
    !snapshot.farmLedgerReady ||
    snapshot.farmPlotsNeedingRepair > 0 ||
    snapshot.matureWheatNearby > 0 ||
    countItem(snapshot, "wheat") >= 3 ||
    countFood(snapshot) < 8
  );
}

const STARTER_FUEL_TARGET = 16;
const SUPPLY_FUEL_TARGET = 32;
const IRON_RESERVE_TARGET = 12;
const STONE_RESERVE_TARGET = 128;

const PICKAXE_RANK: Record<string, number> = {
  wooden_pickaxe: 1,
  golden_pickaxe: 1,
  stone_pickaxe: 2,
  iron_pickaxe: 3,
  diamond_pickaxe: 4,
  netherite_pickaxe: 5,
};

function hasRankedPickaxe(items: Record<string, number>, minimumRank = 1): boolean {
  return Object.entries(items).some(([name, count]) => count > 0 && (PICKAXE_RANK[name] ?? 0) >= minimumRank);
}

function carriesPickaxe(snapshot: ObjectiveSnapshot, minimumRank = 1): boolean {
  return hasRankedPickaxe(snapshot.inventory, minimumRank);
}

function accessiblePickaxe(snapshot: ObjectiveSnapshot, minimumRank = 1): boolean {
  return hasRankedPickaxe(snapshot.inventory, minimumRank) || hasRankedPickaxe(snapshot.stashInventory, minimumRank);
}

function teamPickaxe(snapshot: ObjectiveSnapshot, minimumRank = 1): boolean {
  return (
    hasRankedPickaxe(snapshot.teamInventory, minimumRank) || hasRankedPickaxe(snapshot.stashInventory, minimumRank)
  );
}

function ironToolEstablished(snapshot: ObjectiveSnapshot): boolean {
  return snapshot.ironToolEstablished || teamPickaxe(snapshot, 3);
}

function storedPickaxes(snapshot: ObjectiveSnapshot, minimumRank = 1): string[] {
  return Object.keys(snapshot.stashInventory)
    .filter((name) => (snapshot.stashInventory[name] ?? 0) > 0 && (PICKAXE_RANK[name] ?? 0) >= minimumRank)
    .sort((a, b) => (PICKAXE_RANK[b] ?? 0) - (PICKAXE_RANK[a] ?? 0));
}

function fuelCount(snapshot: ObjectiveSnapshot): number {
  return countItem(snapshot, "coal") + countItem(snapshot, "charcoal");
}

function rawIronCount(snapshot: ObjectiveSnapshot): number {
  return countItem(snapshot, "raw_iron") + countItem(snapshot, "iron_ore") + countItem(snapshot, "deepslate_iron_ore");
}

function ironIngotCount(snapshot: ObjectiveSnapshot): number {
  return countItem(snapshot, "iron_ingot");
}

function ironMaterialCount(snapshot: ObjectiveSnapshot): number {
  return rawIronCount(snapshot) + ironIngotCount(snapshot);
}

function rawSmeltableCount(snapshot: ObjectiveSnapshot): number {
  const names = new Set([
    "raw_iron",
    "iron_ore",
    "deepslate_iron_ore",
    "raw_copper",
    "copper_ore",
    "deepslate_copper_ore",
    "raw_gold",
    "gold_ore",
    "deepslate_gold_ore",
  ]);
  return (
    countMatching(snapshot.teamInventory, (name) => names.has(name)) +
    countMatching(snapshot.stashInventory, (name) => names.has(name))
  );
}

function stoneReserve(snapshot: ObjectiveSnapshot): number {
  return countItem(snapshot, "cobblestone") + countItem(snapshot, "stone") + countItem(snapshot, "stone_bricks");
}

function carriedMiningResources(snapshot: ObjectiveSnapshot): number {
  return countMatching(
    snapshot.inventory,
    (name) =>
      name === "coal" ||
      name === "charcoal" ||
      name === "cobblestone" ||
      name === "stone" ||
      name.endsWith("_ore") ||
      name.startsWith("raw_") ||
      name.endsWith("_ingot"),
  );
}

function constructionStoneNeeded(snapshot: ObjectiveSnapshot): boolean {
  return (
    snapshot.structures.house === "complete" &&
    (snapshot.structures.warehouse !== "complete" || snapshot.structures.workshop !== "complete") &&
    stoneReserve(snapshot) < STONE_RESERVE_TARGET
  );
}

function resourceDevelopmentComplete(snapshot: ObjectiveSnapshot): boolean {
  return snapshot.structures.mine === "complete" && snapshot.furnaceEstablished && ironToolEstablished(snapshot);
}

function resourceSupplyNeeded(snapshot: ObjectiveSnapshot): boolean {
  if (!resourceDevelopmentComplete(snapshot)) return false;
  return (
    !teamPickaxe(snapshot, 2) ||
    fuelCount(snapshot) < SUPPLY_FUEL_TARGET ||
    ironMaterialCount(snapshot) < IRON_RESERVE_TARGET ||
    rawSmeltableCount(snapshot) > 0 ||
    constructionStoneNeeded(snapshot) ||
    (snapshot.stashExists && carriedMiningResources(snapshot) >= 16)
  );
}

const TOOL_TIER_RANK: Record<string, number> = {
  wooden: 1,
  golden: 1,
  stone: 2,
  iron: 3,
  diamond: 4,
  netherite: 5,
};

function hasTool(items: Record<string, number>, suffix: string, minimumRank: number): boolean {
  return Object.entries(items).some(([name, count]) => {
    if (count <= 0 || !name.endsWith(`_${suffix}`)) return false;
    const tier = name.slice(0, -`_${suffix}`.length);
    return (TOOL_TIER_RANK[tier] ?? 0) >= minimumRank;
  });
}

function workKitComplete(snapshot: ObjectiveSnapshot): boolean {
  return (
    hasTool(snapshot.inventory, "pickaxe", 2) &&
    hasTool(snapshot.inventory, "axe", 2) &&
    hasTool(snapshot.inventory, "sword", 2)
  );
}

function ironToolsComplete(snapshot: ObjectiveSnapshot): boolean {
  return hasTool(snapshot.inventory, "pickaxe", 3) && hasTool(snapshot.inventory, "sword", 3);
}

function ironArmorComplete(snapshot: ObjectiveSnapshot): boolean {
  return ["helmet", "chestplate", "leggings", "boots"].every((piece) => hasTool(snapshot.inventory, piece, 3));
}

function equipmentProgressNeeded(snapshot: ObjectiveSnapshot): boolean {
  if (!workKitComplete(snapshot)) return true;
  const accessibleIngots = countItem(snapshot, "iron_ingot", true);
  if (!ironToolsComplete(snapshot) && accessibleIngots >= 6) return true;
  return !ironArmorComplete(snapshot) && accessibleIngots >= 24;
}

function requiredSafetyZones(snapshot: ObjectiveSnapshot): string[] {
  const zones = ["core"];
  if (snapshot.structures.house === "complete") zones.push("lodge");
  if (snapshot.structures.farm === "complete") zones.push("farm");
  if (snapshot.structures.mine === "complete") zones.push("mine");
  return zones;
}

function safetyComplete(snapshot: ObjectiveSnapshot): boolean {
  return requiredSafetyZones(snapshot).every((zone) => snapshot.safetyZones.has(zone));
}

function husbandryFeedCount(snapshot: ObjectiveSnapshot, species: string): number {
  const names =
    species === "cow" || species === "sheep"
      ? ["wheat"]
      : species === "chicken"
        ? ["wheat_seeds"]
        : ["carrot", "potato", "beetroot"];
  return names.reduce((total, name) => total + countItem(snapshot, name, true), 0);
}

function husbandryAvailable(snapshot: ObjectiveSnapshot): boolean {
  if (snapshot.structures.farm !== "complete") return false;
  return ["cow", "sheep", "chicken", "pig"].some(
    (species) =>
      !snapshot.animalPens.has(species) &&
      (snapshot.nearbyAnimals[species] ?? 0) >= 2 &&
      husbandryFeedCount(snapshot, species) >= 2,
  );
}

const DEFINITIONS: ObjectiveDefinition[] = [
  {
    id: "food_production",
    label: "Establish renewable food",
    description: "Create a dependable food source instead of repeatedly scavenging.",
    preferredRoles: ["Farmer / Crafter"],
    maxWorkers: 1,
    complete: (s) => s.structures.farm === "complete",
    available: (s) => s.structures.farm !== "complete",
    status: (s) => {
      const seeds = countItem(s, "wheat_seeds", true);
      return `farm=${s.structures.farm}; seeds=${seeds}; hoe=${hasHoe(s) ? "ready" : "missing"}; accessible wood=${accessibleWood(s)}`;
    },
    subobjectives: [
      {
        id: "prepare_farm_supplies",
        label: "Prepare farm supplies",
        description: "Secure wood, a hoe, and seeds before construction.",
        complete: (s) => carriedWood(s) >= FARM_WOOD_TARGET && carriesHoe(s) && (s.inventory.wheat_seeds ?? 0) >= 4,
        relevant: (s) => carriedWood(s) < FARM_WOOD_TARGET || !carriesHoe(s) || (s.inventory.wheat_seeds ?? 0) < 4,
      },
      {
        id: "locate_farm_site",
        label: "Locate a farm site",
        description: "Deterministically survey, reach, and remember an exposed usable shoreline.",
        complete: (s) => s.usableFarmSite,
        relevant: (s) => !s.usableFarmSite,
      },
      {
        id: "establish_wheat_farm",
        label: "Prepare, till, and plant the farm",
        description: "Use the farm procedure to prepare terrain, till soil, and plant wheat.",
        complete: (s) => s.structures.farm === "complete",
        relevant: (s) => s.structures.farm !== "complete" && s.usableFarmSite,
      },
    ],
  },
  {
    id: "food_maintenance",
    label: "Maintain the food supply",
    description: "Inspect, harvest, replant, bake, and store food from an existing farm.",
    preferredRoles: ["Farmer / Crafter"],
    maxWorkers: 1,
    complete: (s) => !foodMaintenanceNeeded(s),
    available: (s) => foodMaintenanceNeeded(s),
    status: (s) =>
      `farm=${s.structures.farm}; ledger=${s.farmLedgerReady ? `${s.farmPlotsTotal} plots` : "needs reconciliation"}; repair=${s.farmPlotsNeedingRepair}; mature=${s.matureWheatNearby}; wheat=${countItem(s, "wheat")}; prepared food=${countFood(s)}`,
    subobjectives: [
      {
        id: "inspect_crops",
        label: "Inspect the farm",
        description: "Return to the known farm and check whether crops are mature.",
        complete: (s) => s.nearFarm || !s.farmLedgerReady,
        relevant: (s) => s.farmLedgerReady && !s.nearFarm && (s.matureWheatNearby > 0 || s.farmPlotsNeedingRepair > 0),
      },
      {
        id: "harvest_and_replant",
        label: "Harvest and replant",
        description: "Reconcile exact farm plots, harvest mature wheat, repair damaged soil, and replant empty plots.",
        complete: (s) => s.farmLedgerReady && s.matureWheatNearby === 0 && s.farmPlotsNeedingRepair === 0,
        relevant: (s) => !s.farmLedgerReady || s.matureWheatNearby > 0 || s.farmPlotsNeedingRepair > 0,
      },
      {
        id: "bake_bread",
        label: "Bake accumulated wheat",
        description: "Convert wheat into edible bread.",
        complete: (s) => countItem(s, "wheat", true) < 3,
        relevant: (s) => countItem(s, "wheat", true) >= 3,
      },
      {
        id: "stock_food",
        label: "Stock the shared pantry",
        description: "Deposit surplus prepared food for the rest of the team.",
        complete: (s) => carriedFood(s) < 4,
        relevant: (s) => s.stashExists && carriedFood(s) >= 4,
      },
      {
        id: "supplement_food",
        label: "Supplement food while crops grow",
        description: "Fish, hunt, or forage without abandoning the farm commitment.",
        complete: (s) => countFood(s) >= 8,
        relevant: (s) => countFood(s) < 8,
      },
    ],
  },
  {
    id: "storage",
    label: "Establish or expand storage",
    description: "Create shared storage, clear overloaded inventories, or add capacity.",
    preferredRoles: ["Builder"],
    maxWorkers: 1,
    complete: (s) => s.stashExists && !storagePressure(s) && !inventoryPressure(s),
    available: (s) => !s.stashExists || storagePressure(s) || inventoryPressure(s),
    status: (s) => {
      const capacity =
        s.stashTotalSlots && s.stashFreeSlots !== null
          ? `${s.stashFreeSlots}/${s.stashTotalSlots} slots free`
          : s.stashExists
            ? "capacity not recently observed"
            : "no shared stash";
      return `${capacity}; carried stacks=${s.inventoryStacks}`;
    },
    subobjectives: [
      {
        id: "establish_stash",
        label: "Establish the shared stash",
        description: "Craft and place the first shared storage chests.",
        complete: (s) => s.stashExists,
        relevant: (s) => !s.stashExists,
      },
      {
        id: "deposit_surplus",
        label: "Deposit surplus inventory",
        description: "Move carried resources into shared storage.",
        complete: (s) => !inventoryPressure(s),
        relevant: (s) => s.stashExists && inventoryPressure(s),
      },
      {
        id: "expand_stash",
        label: "Expand full storage",
        description: "Craft and register additional chests when current storage is nearly full.",
        complete: (s) => s.stashExists && !storagePressure(s),
        relevant: (s) => s.stashExists && storagePressure(s),
      },
    ],
  },
  {
    id: "resource_development",
    label: "Establish mining and metalworking",
    description: "Create one shared mine, bootstrap fuel and iron, and leave the settlement with an iron pickaxe.",
    preferredRoles: ["Miner / Smelter", "Explorer / Miner"],
    maxWorkers: 1,
    complete: resourceDevelopmentComplete,
    available: (s) => !resourceDevelopmentComplete(s),
    status: (s) =>
      `mine=${s.structures.mine}; furnace=${s.furnaceEstablished ? "established" : "needed"}; iron-tool milestone=${ironToolEstablished(s) ? "achieved" : "needed"}; current pickaxe=${teamPickaxe(s, 3) ? "iron+" : teamPickaxe(s) ? "basic" : "missing"}; fuel=${fuelCount(s)}/${STARTER_FUEL_TARGET}; raw iron=${rawIronCount(s)}; ingots=${ironIngotCount(s)}`,
    subobjectives: [
      {
        id: "prepare_mining_tools",
        label: "Prepare a working pickaxe",
        description: "Withdraw or craft the first pickaxe needed to open the shared mine.",
        complete: (s) => accessiblePickaxe(s),
        relevant: (s) => !accessiblePickaxe(s),
      },
      {
        id: "establish_shared_mine",
        label: "Establish the shared mine",
        description: "Open and remember one safe settlement mine entrance, then complete its first branch.",
        complete: (s) => s.structures.mine === "complete",
        relevant: (s) => s.structures.mine !== "complete" && accessiblePickaxe(s),
      },
      {
        id: "acquire_starter_fuel",
        label: "Acquire starter fuel",
        description: "Extend the shared mine specifically for enough coal to light and smelt.",
        complete: (s) => fuelCount(s) >= STARTER_FUEL_TARGET,
        relevant: (s) => s.structures.mine === "complete" && fuelCount(s) < STARTER_FUEL_TARGET,
      },
      {
        id: "acquire_starter_iron",
        label: "Acquire starter iron",
        description: "Extend the shared mine for at least enough iron to make an iron pickaxe.",
        complete: (s) => ironMaterialCount(s) >= 3 || ironToolEstablished(s),
        relevant: (s) => s.structures.mine === "complete" && ironMaterialCount(s) < 3 && !ironToolEstablished(s),
      },
      {
        id: "smelt_starter_iron",
        label: "Smelt starter iron",
        description: "Turn pooled raw iron into the ingots needed for the first upgrade.",
        complete: (s) => ironIngotCount(s) >= 3 || ironToolEstablished(s),
        relevant: (s) => rawIronCount(s) > 0 && ironIngotCount(s) < 3 && !ironToolEstablished(s),
      },
      {
        id: "establish_furnace_station",
        label: "Establish shared metalworking",
        description: "Craft and place a durable furnace at the settlement work area.",
        complete: (s) => s.furnaceEstablished,
        relevant: (s) => s.structures.mine === "complete" && !s.furnaceEstablished,
      },
      {
        id: "upgrade_mining_tools",
        label: "Upgrade to an iron pickaxe",
        description: "Withdraw or craft an iron pickaxe after the first ingots are ready.",
        complete: ironToolEstablished,
        relevant: (s) => !ironToolEstablished(s) && ironIngotCount(s) >= 3,
      },
    ],
  },
  {
    id: "resource_supply",
    label: "Replenish settlement resources",
    description:
      "Respond to measured shortages in fuel, iron, tools, or construction stone using the established mine.",
    preferredRoles: ["Miner / Smelter", "Explorer / Miner"],
    maxWorkers: 1,
    complete: (s) => !resourceSupplyNeeded(s),
    available: resourceSupplyNeeded,
    status: (s) =>
      `fuel=${fuelCount(s)}/${SUPPLY_FUEL_TARGET}; iron reserve=${ironMaterialCount(s)}/${IRON_RESERVE_TARGET}; stone=${stoneReserve(s)}/${STONE_RESERVE_TARGET}; raw ore waiting=${rawSmeltableCount(s)}`,
    subobjectives: [
      {
        id: "replace_mining_tools",
        label: "Replace mining tools",
        description: "Restore a stone-or-better pickaxe before attempting another supply run.",
        complete: (s) => teamPickaxe(s, 2),
        relevant: (s) => !teamPickaxe(s, 2),
      },
      {
        id: "replenish_fuel",
        label: "Replenish fuel",
        description: "Target coal until the shared reserve reaches its working threshold.",
        complete: (s) => fuelCount(s) >= SUPPLY_FUEL_TARGET,
        relevant: (s) => fuelCount(s) < SUPPLY_FUEL_TARGET,
      },
      {
        id: "replenish_iron",
        label: "Replenish iron",
        description: "Target iron until the settlement has a useful raw-or-smelted reserve.",
        complete: (s) => ironMaterialCount(s) >= IRON_RESERVE_TARGET,
        relevant: (s) => ironMaterialCount(s) < IRON_RESERVE_TARGET,
      },
      {
        id: "replenish_construction_stone",
        label: "Replenish construction stone",
        description: "Extend a mine branch for stone while settlement construction still needs it.",
        complete: (s) => !constructionStoneNeeded(s),
        relevant: constructionStoneNeeded,
      },
      {
        id: "process_raw_ores",
        label: "Process pooled raw ores",
        description: "Smelt the raw ore waiting in inventories or shared storage.",
        complete: (s) => rawSmeltableCount(s) === 0,
        relevant: (s) => rawSmeltableCount(s) > 0,
      },
      {
        id: "deposit_mining_resources",
        label: "Deposit mined resources",
        description: "Move a substantial carried mining haul into shared storage.",
        complete: (s) => !s.stashExists || carriedMiningResources(s) < 16,
        relevant: (s) => s.stashExists && carriedMiningResources(s) >= 16,
      },
    ],
  },
  {
    id: "regional_survey",
    label: "Survey the settlement region",
    description: "Map one of eight bounded sectors per trip and return to base with durable observations.",
    preferredRoles: ["Explorer / Miner"],
    maxWorkers: 1,
    complete: (s) => s.scoutedSectors >= 8,
    available: (s) => s.scoutedSectors < 8,
    status: (s) => `bounded sectors recorded=${s.scoutedSectors}/8`,
    subobjectives: [
      {
        id: "survey_next_sector",
        label: "Survey the next unmapped sector",
        description: "Visit exactly one fixed sector within 91 blocks of base, record it, and return.",
        complete: (s) => s.scoutedSectors >= 8,
        relevant: (s) => s.scoutedSectors < 8,
      },
    ],
  },
  {
    id: "equipment_progression",
    label: "Improve personal equipment",
    description:
      "Give the acting bot a measured work kit, then spend pooled iron only when a full upgrade is affordable.",
    preferredRoles: ["Explorer / Miner", "Farmer / Crafter", "Miner / Smelter", "Builder", "Combat / Guard"],
    maxWorkers: 1,
    complete: (s) => !equipmentProgressNeeded(s),
    available: equipmentProgressNeeded,
    status: (s) =>
      `work kit=${workKitComplete(s) ? "ready" : "missing"}; iron tools=${ironToolsComplete(s) ? "ready" : "missing"}; iron armor=${ironArmorComplete(s) ? "ready" : "missing"}; accessible ingots=${countItem(s, "iron_ingot", true)}`,
    subobjectives: [
      {
        id: "establish_work_kit",
        label: "Establish a stone work kit",
        description: "Craft a stone-or-better pickaxe, axe, and sword for this bot.",
        complete: workKitComplete,
        relevant: (s) => !workKitComplete(s),
      },
      {
        id: "upgrade_iron_tools",
        label: "Upgrade core iron tools",
        description: "Craft an iron-or-better pickaxe and sword when six ingots are accessible.",
        complete: ironToolsComplete,
        relevant: (s) => workKitComplete(s) && !ironToolsComplete(s) && countItem(s, "iron_ingot", true) >= 6,
      },
      {
        id: "equip_iron_armor",
        label: "Equip a full iron armor set",
        description: "Craft four iron-or-better armor pieces only after a full 24-ingot set is affordable.",
        complete: ironArmorComplete,
        relevant: (s) => ironToolsComplete(s) && !ironArmorComplete(s) && countItem(s, "iron_ingot", true) >= 24,
      },
    ],
  },
  {
    id: "settlement_safety",
    label: "Secure the settlement",
    description: "Light each completed settlement zone independently and retain scoped completion evidence.",
    preferredRoles: ["Builder", "Combat / Guard"],
    maxWorkers: 1,
    complete: safetyComplete,
    available: (s) => !safetyComplete(s),
    status: (s) =>
      `required=${requiredSafetyZones(s).join(",")}; secured=${[...s.safetyZones].sort().join(",") || "none"}`,
    subobjectives: [
      {
        id: "light_core",
        label: "Light the settlement core",
        description: "Place and verify lighting around the stash and shared work yard.",
        complete: (s) => s.safetyZones.has("core"),
        relevant: (s) => !s.safetyZones.has("core"),
      },
      {
        id: "light_lodge_zone",
        label: "Light the starter lodge",
        description: "Place and verify lighting around the completed lodge.",
        complete: (s) => s.safetyZones.has("lodge"),
        relevant: (s) => s.structures.house === "complete" && !s.safetyZones.has("lodge"),
      },
      {
        id: "light_farm_zone",
        label: "Light the farm",
        description: "Place and verify lighting around the renewable food site.",
        complete: (s) => s.safetyZones.has("farm"),
        relevant: (s) => s.structures.farm === "complete" && !s.safetyZones.has("farm"),
      },
      {
        id: "light_mine_zone",
        label: "Light the mine entrance",
        description: "Place and verify lighting around the shared surface entrance.",
        complete: (s) => s.safetyZones.has("mine"),
        relevant: (s) => s.structures.mine === "complete" && !s.safetyZones.has("mine"),
      },
    ],
  },
  {
    id: "animal_husbandry",
    label: "Establish animal husbandry",
    description: "Choose a locally viable species, construct its pen near the farm, contain a pair, and breed it.",
    preferredRoles: ["Farmer / Crafter"],
    maxWorkers: 1,
    complete: (s) => s.animalPens.size > 0,
    available: husbandryAvailable,
    status: (s) =>
      `pens=${[...s.animalPens].join(",") || "none"}; nearby cows=${s.nearbyAnimals.cow ?? 0}, sheep=${s.nearbyAnimals.sheep ?? 0}, chickens=${s.nearbyAnimals.chicken ?? 0}, pigs=${s.nearbyAnimals.pig ?? 0}`,
    subobjectives: ["cow", "sheep", "chicken", "pig"].map((species) => ({
      id: `establish_${species}_pen`,
      label: `Establish a ${species} pen`,
      description: `Build a fixed pen near the farm, contain two ${species}s, and supply breeding feed.`,
      complete: (s: ObjectiveSnapshot) => s.animalPens.has(species),
      relevant: (s: ObjectiveSnapshot) =>
        !s.animalPens.has(species) && (s.nearbyAnimals[species] ?? 0) >= 2 && husbandryFeedCount(s, species) >= 2,
    })),
  },
  {
    id: "shelter",
    label: "Establish a safe shelter",
    description: "Build the core house and make it safe enough to use.",
    preferredRoles: ["Builder"],
    maxWorkers: 1,
    complete: (s) => s.structures.house === "complete" && s.shelterLit,
    available: (s) => s.structures.house !== "complete" || !s.shelterLit,
    status: (s) => `house=${s.structures.house}; lighting=${s.shelterLit ? "established" : "needed"}`,
    subobjectives: [
      {
        id: "gather_shelter_materials",
        label: "Gather shelter materials",
        description: "Secure enough building material to begin or resume the house.",
        complete: (s) => accessibleWood(s) >= HOUSE_WOOD_TARGET,
        relevant: (s) => s.structures.house !== "complete" && accessibleWood(s) < HOUSE_WOOD_TARGET,
      },
      {
        id: "build_shelter",
        label: "Build or finish the house",
        description: "Construct the house blueprint or resume a partial shell.",
        complete: (s) => s.structures.house === "complete",
        relevant: (s) => s.structures.house !== "complete",
      },
      {
        id: "light_shelter",
        label: "Light the shelter",
        description: "Place lighting in and around the completed house.",
        complete: (s) => s.shelterLit,
        relevant: (s) => s.structures.house === "complete" && !s.shelterLit,
      },
    ],
  },
  {
    id: "settlement",
    label: "Expand the settlement",
    description: "Complete permanent shared buildings after the core shelter exists.",
    preferredRoles: ["Builder"],
    maxWorkers: 1,
    complete: (s) => s.structures.warehouse === "complete" && s.structures.workshop === "complete",
    available: (s) =>
      s.structures.house === "complete" &&
      (s.structures.warehouse !== "complete" || s.structures.workshop !== "complete"),
    status: (s) => `warehouse=${s.structures.warehouse}; workshop=${s.structures.workshop}`,
    subobjectives: [
      {
        id: "gather_settlement_materials",
        label: "Gather construction materials",
        description: "Collect or withdraw wood and stone for the active building.",
        complete: (s) => accessibleWood(s) >= SETTLEMENT_WOOD_TARGET,
        relevant: (s) =>
          (s.structures.warehouse !== "complete" || s.structures.workshop !== "complete") &&
          accessibleWood(s) < SETTLEMENT_WOOD_TARGET,
      },
      {
        id: "build_warehouse",
        label: "Build or finish the warehouse",
        description: "Construct the warehouse, always resuming a partial build first.",
        complete: (s) => s.structures.warehouse === "complete",
        relevant: (s) => s.structures.warehouse !== "complete",
      },
      {
        id: "build_workshop",
        label: "Build or finish the workshop",
        description: "Construct the workshop after the warehouse is complete.",
        complete: (s) => s.structures.workshop === "complete",
        relevant: (s) => s.structures.warehouse === "complete" && s.structures.workshop !== "complete",
      },
      {
        id: "light_settlement",
        label: "Light settlement buildings",
        description: "Place lighting around completed and active construction.",
        complete: (s) => s.shelterLit,
        relevant: (s) =>
          (s.structures.warehouse === "complete" || s.structures.workshop === "complete") && !s.shelterLit,
      },
    ],
  },
];

export function isObjectiveId(value: string): value is ObjectiveId {
  return (
    DEFINITIONS.some((definition) => definition.id === value) || PROGRESSION_TREE.some((stage) => stage.id === value)
  );
}

export function evaluateObjectiveTree(
  snapshot: ObjectiveSnapshot,
  commitment?: ObjectiveCommitment,
): ObjectiveTreeView {
  const objectives = DEFINITIONS.map<EvaluatedObjective>((definition) => {
    const subobjectives = definition.subobjectives.map<EvaluatedSubobjective>((sub) => ({
      id: sub.id,
      label: sub.label,
      description: sub.description,
      complete: sub.complete(snapshot),
      relevant: sub.relevant(snapshot),
    }));
    return {
      id: definition.id,
      label: definition.label,
      description: definition.description,
      preferredRoles: definition.preferredRoles,
      maxWorkers: definition.maxWorkers,
      status: definition.status(snapshot),
      complete: definition.complete(snapshot),
      available: definition.available(snapshot),
      claimedBy: snapshot.teamCommitments
        .filter((entry) => entry.objectiveId === definition.id)
        .map((entry) => entry.name),
      subobjectives,
    };
  });

  const activeObjective = commitment
    ? objectives.find((objective) => objective.id === commitment.objectiveId)
    : undefined;
  const activeSubobjective =
    activeObjective && commitment?.subobjectiveId
      ? activeObjective.subobjectives.find((sub) => sub.id === commitment.subobjectiveId)
      : undefined;

  return { snapshot, objectives, commitment, activeObjective, activeSubobjective };
}

export function reconcileObjectiveCommitment(view: ObjectiveTreeView): {
  commitment?: ObjectiveCommitment;
  reason?: string;
} {
  const commitment = view.commitment;
  if (!commitment) return {};
  if (!view.activeObjective) {
    return { reason: `Unknown objective "${commitment.objectiveId}"` };
  }
  if (view.activeObjective.complete) {
    return { reason: `${view.activeObjective.label} is complete in the observed world` };
  }
  if (!view.activeObjective.preferredRoles.includes(view.snapshot.role)) {
    const preferredWorkAvailable = view.objectives.some(
      (objective) =>
        objective.id !== view.activeObjective?.id &&
        objective.preferredRoles.includes(view.snapshot.role) &&
        objective.available &&
        !objective.complete &&
        objective.claimedBy.length < objective.maxWorkers &&
        hasActionableSubobjective(objective, view.snapshot),
    );
    if (preferredWorkAvailable) {
      return {
        reason: `${view.activeObjective.label} was released because unclaimed ${view.snapshot.role} work is available`,
      };
    }
  }
  if (commitment.subobjectiveId && !view.activeSubobjective) {
    return {
      commitment: { ...commitment, subobjectiveId: undefined, updatedAt: new Date().toISOString() },
      reason: `Unknown sub-objective "${commitment.subobjectiveId}" was cleared`,
    };
  }
  if (view.activeSubobjective?.complete) {
    return {
      commitment: { ...commitment, subobjectiveId: undefined, updatedAt: new Date().toISOString() },
      reason: `${view.activeSubobjective.label} is complete; choose the next branch`,
    };
  }
  if (view.activeSubobjective && !view.activeSubobjective.relevant) {
    return {
      commitment: { ...commitment, subobjectiveId: undefined, updatedAt: new Date().toISOString() },
      reason: `${view.activeSubobjective.label} is no longer actionable in the observed world`,
    };
  }
  if (!view.activeSubobjective && !hasActionableSubobjective(view.activeObjective, view.snapshot)) {
    return {
      reason: `${view.activeObjective.label} has no unblocked actionable branch in the current state`,
    };
  }
  return { commitment };
}

function hasActionableSubobjective(objective: EvaluatedObjective, snapshot: ObjectiveSnapshot): boolean {
  return objective.subobjectives.some(
    (sub) => sub.relevant && !sub.complete && !snapshot.recentlyFailed.has(`objective:${sub.id}`),
  );
}

function actionFromBase(baseOptions: readonly ActionOption[], action: string): ActionOption | undefined {
  return baseOptions.find((option) => option.action === action && !option.skill);
}

function goToFarm(snapshot: ObjectiveSnapshot): ActionOption | undefined {
  const target = snapshot.farmLocation;
  if (!target) return undefined;
  return {
    action: "go_to",
    signature: `go_to ${JSON.stringify(target)}`,
    description: `Return to the known farm at (${target.x},${target.y},${target.z}).`,
    coordinateTargets: [{ ...target, label: "farm" }],
  };
}

function invokeSkill(
  snapshot: ObjectiveSnapshot,
  skill: string,
  description: string,
  fixedParams: Record<string, string> = {},
): ActionOption | undefined {
  if (snapshot.recentlyFailed.has(`skill:${skill}`)) return undefined;
  const params = { skill, ...fixedParams };
  return {
    action: "invoke_skill",
    skill,
    signature: `invoke_skill ${JSON.stringify(params)}`,
    description,
    allowedParams: Object.keys(fixedParams).length
      ? Object.fromEntries(Object.entries(fixedParams).map(([key, value]) => [key, [value]]))
      : undefined,
  };
}

function craftItem(item: string, count: number, description: string): ActionOption {
  return {
    action: "craft",
    signature: `craft ${JSON.stringify({ item, count })}`,
    description,
    allowedParams: { item: [item] },
  };
}

function gatherWood(snapshot: ObjectiveSnapshot, woodTarget: number, description: string): ActionOption | undefined {
  if (!snapshot.visibleTrees || snapshot.recentlyFailed.has("gather_wood")) {
    if (snapshot.recentlyFailed.has("explore")) return undefined;
    return {
      action: "explore",
      signature: 'explore {}',
      description: "Search for reachable trees to replace missing supplies, then resume the active objective.",
    };
  }
  const count = Math.max(1, Math.ceil((woodTarget - carriedWood(snapshot)) / 4));
  return {
    action: "gather_wood",
    signature: `gather_wood ${JSON.stringify({ count })}`,
    description,
  };
}

function withdrawWood(
  snapshot: ObjectiveSnapshot,
  items: string[],
  woodTarget: number,
  description: string,
): ActionOption {
  const preferred = items.find((item) => (snapshot.stashInventory[item] ?? 0) > 0) ?? items[0];
  const woodDeficit = Math.max(1, woodTarget - carriedWood(snapshot));
  const count =
    preferred.endsWith("_log") || preferred.endsWith("_stem") || preferred.endsWith("_hyphae")
      ? Math.ceil(woodDeficit / 4)
      : woodDeficit;
  return {
    action: "withdraw_stash",
    signature: `withdraw_stash ${JSON.stringify({ item: preferred, count })}`,
    description,
    allowedParams: { item: items },
  };
}

function depositStash(description: string, mode?: "pantry"): ActionOption {
  const params = mode ? { mode } : {};
  return {
    action: "deposit_stash",
    signature: `deposit_stash ${JSON.stringify(params)}`,
    description,
    allowedParams: mode ? { mode: [mode] } : undefined,
  };
}

function miningProcedure(
  snapshot: ObjectiveSnapshot,
  target: "general" | "iron" | "coal" | "stone",
  targetCount: number,
  description: string,
): ActionOption[] {
  if (!carriesPickaxe(snapshot)) {
    const stored = storedPickaxes(snapshot);
    if (stored.length > 0) {
      return [withdrawItems(snapshot, stored, "Withdraw a pickaxe before returning to the shared mine.", 1)];
    }
    return (
      ensurePortableCrafting(snapshot, 8, "Prepare supplies for a replacement mining pickaxe.") ?? [
        craftItem("wooden_pickaxe", 1, "Replace the missing pickaxe before resuming mining."),
      ]
    );
  }
  return compact([
    invokeSkill(snapshot, "strip_mine", description, {
      target,
      targetCount: String(Math.max(1, targetCount)),
    }),
  ]);
}

function withdrawItems(snapshot: ObjectiveSnapshot, items: string[], description: string, count = 8): ActionOption {
  const preferred = items.find((item) => (snapshot.stashInventory[item] ?? 0) > 0) ?? items[0];
  return {
    action: "withdraw_stash",
    signature: `withdraw_stash ${JSON.stringify({ item: preferred, count })}`,
    description,
    allowedParams: { item: items },
  };
}

function compact<T>(values: (T | undefined)[]): T[] {
  return values.filter((value): value is T => value !== undefined);
}

const COBBLE_NAMES = ["cobblestone", "cobbled_deepslate"] as const;
const RAW_SMELTABLE_NAMES = [
  "raw_iron",
  "iron_ore",
  "deepslate_iron_ore",
  "raw_copper",
  "copper_ore",
  "deepslate_copper_ore",
  "raw_gold",
  "gold_ore",
  "deepslate_gold_ore",
] as const;
const FUEL_NAMES = ["coal", "charcoal"] as const;
const WORK_KIT_COBBLE = 8;
const WORK_KIT_STICKS = 6;
const LIGHTING_TORCH_TARGET = 8;

function ensurePortableCrafting(
  snapshot: ObjectiveSnapshot,
  woodTarget: number,
  description: string,
): ActionOption[] | undefined {
  const woodInStash = stashWoodItems(snapshot);
  if (carriedWood(snapshot) < woodTarget) {
    return compact([
      woodInStash.length > 0
        ? withdrawWood(snapshot, woodInStash, woodTarget, description)
        : gatherWood(snapshot, woodTarget, description),
    ]);
  }
  if ((snapshot.inventory.stick ?? 0) < 2) {
    return [craftItem("stick", 4, "Craft the sticks required by this work order.")];
  }
  if (!snapshot.nearbyCraftingTable && (snapshot.inventory.crafting_table ?? 0) === 0) {
    return [craftItem("crafting_table", 1, "Craft a portable table for this work order.")];
  }
  return undefined;
}

/** Supply a stone work kit mechanically before craft_gear gets control. */
function workKitProcedure(snapshot: ObjectiveSnapshot): ActionOption[] {
  for (const suffix of ["pickaxe", "axe", "sword"] as const) {
    if (hasTool(snapshot.inventory, suffix, 2)) continue;
    const stored = storedItems(snapshot, (name) => hasTool({ [name]: 1 }, suffix, 2));
    if (stored.length > 0) {
      return [withdrawItems(snapshot, stored, `Withdraw the missing ${suffix} from shared storage.`, 1)];
    }
  }

  const carriedCobble = carriedCount(snapshot, COBBLE_NAMES);
  if (carriedCobble < WORK_KIT_COBBLE) {
    const storedCobble = storedItems(snapshot, (name) => COBBLE_NAMES.includes(name as (typeof COBBLE_NAMES)[number]));
    if (storedCobble.length > 0) {
      return [
        withdrawItems(
          snapshot,
          storedCobble,
          "Withdraw the exact stone batch needed for a pickaxe, axe, and sword.",
          WORK_KIT_COBBLE - carriedCobble,
        ),
      ];
    }
    if (!carriesPickaxe(snapshot)) {
      const crafting = ensurePortableCrafting(snapshot, 8, "Prepare wood for a temporary wooden pickaxe.");
      if (crafting) return crafting;
      return [craftItem("wooden_pickaxe", 1, "Craft a temporary pickaxe so the stone work kit can be mined.")];
    }
    return miningProcedure(
      snapshot,
      "stone",
      WORK_KIT_COBBLE - carriedCobble,
      "Mine the exact cobblestone batch required by the selected work-kit procedure.",
    );
  }

  if ((snapshot.inventory.stick ?? 0) < WORK_KIT_STICKS) {
    const storedSticks = storedItems(snapshot, (name) => name === "stick");
    if (storedSticks.length > 0) {
      return [withdrawItems(snapshot, storedSticks, "Withdraw sticks for the selected work kit.", WORK_KIT_STICKS)];
    }
    const crafting = ensurePortableCrafting(snapshot, 4, "Prepare wood for work-kit handles.");
    if (crafting && (snapshot.inventory.stick ?? 0) < 2) return crafting;
    return [
      craftItem("stick", WORK_KIT_STICKS - (snapshot.inventory.stick ?? 0), "Craft the missing work-kit handles."),
    ];
  }

  const crafting = ensurePortableCrafting(snapshot, 4, "Prepare a crafting table for the work kit.");
  if (crafting && !snapshot.nearbyCraftingTable && (snapshot.inventory.crafting_table ?? 0) === 0) return crafting;
  return compact([
    invokeSkill(snapshot, "craft_gear", "Craft the supplied stone-or-better pickaxe, axe, and sword.", {
      target: "work_kit",
    }),
  ]);
}

function farmMaintenanceProcedure(snapshot: ObjectiveSnapshot): ActionOption[] {
  if (!carriesHoe(snapshot)) {
    const storedHoes = storedItems(snapshot, (name) => name.endsWith("_hoe"));
    if (storedHoes.length > 0) return [withdrawItems(snapshot, storedHoes, "Withdraw a hoe for farm maintenance.", 1)];
    const crafting = ensurePortableCrafting(snapshot, 6, "Prepare the wood and table for a replacement hoe.");
    if (crafting) return crafting;
    return [craftItem("wooden_hoe", 1, "Craft the replacement hoe required to repair farm plots.")];
  }

  const seedsNeeded = Math.min(8, Math.max(0, snapshot.farmPlotsNeedingRepair));
  const carriedSeeds = snapshot.inventory.wheat_seeds ?? 0;
  if (seedsNeeded > carriedSeeds) {
    if ((snapshot.stashInventory.wheat_seeds ?? 0) > 0) {
      return [
        withdrawItems(
          snapshot,
          ["wheat_seeds"],
          "Withdraw seeds for the exact farm plots needing replanting.",
          seedsNeeded - carriedSeeds,
        ),
      ];
    }
    return compact([
      invokeSkill(snapshot, "gather_seeds", "Collect the seeds required by the farm repair work order."),
    ]);
  }

  return compact([
    invokeSkill(
      snapshot,
      "maintain_farm",
      "Reconcile all farm ledgers, then harvest, repair, and replant exact plots.",
    ),
  ]);
}

function lightingProcedure(snapshot: ObjectiveSnapshot, safetyZone: string, description: string): ActionOption[] {
  const carriedTorches = snapshot.inventory.torch ?? 0;
  if (carriedTorches < LIGHTING_TORCH_TARGET) {
    if ((snapshot.stashInventory.torch ?? 0) > 0) {
      return [
        withdrawItems(
          snapshot,
          ["torch"],
          "Withdraw a bounded torch batch for the selected safety zone.",
          LIGHTING_TORCH_TARGET - carriedTorches,
        ),
      ];
    }

    if (carriedCount(snapshot, FUEL_NAMES) < 1) {
      const storedFuel = storedItems(snapshot, (name) => FUEL_NAMES.includes(name as (typeof FUEL_NAMES)[number]));
      if (storedFuel.length > 0) return [withdrawItems(snapshot, storedFuel, "Withdraw coal for torches.", 2)];
      if (!carriesPickaxe(snapshot)) return workKitProcedure(snapshot);
      return miningProcedure(snapshot, "coal", 2, "Mine the coal required by the selected lighting work order.");
    }

    if ((snapshot.inventory.stick ?? 0) < 1) {
      if ((snapshot.stashInventory.stick ?? 0) > 0) {
        return [withdrawItems(snapshot, ["stick"], "Withdraw sticks for torches.", 2)];
      }
      const crafting = ensurePortableCrafting(snapshot, 2, "Prepare wood for torch sticks.");
      if (crafting) return crafting;
      return [craftItem("stick", 4, "Craft the handles for the selected torch batch.")];
    }

    return [craftItem("torch", LIGHTING_TORCH_TARGET - carriedTorches, "Craft a bounded torch batch for this zone.")];
  }

  return compact([invokeSkill(snapshot, "light_area", description, { safetyZone })]);
}

function smeltingProcedure(snapshot: ObjectiveSnapshot, description: string): ActionOption[] {
  if (carriedCount(snapshot, RAW_SMELTABLE_NAMES) === 0) {
    const storedOre = storedItems(snapshot, (name) =>
      RAW_SMELTABLE_NAMES.includes(name as (typeof RAW_SMELTABLE_NAMES)[number]),
    );
    if (storedOre.length > 0) return [withdrawItems(snapshot, storedOre, "Withdraw a raw-ore batch for smelting.", 16)];
    if (!carriesPickaxe(snapshot)) return workKitProcedure(snapshot);
    return miningProcedure(snapshot, "iron", 3, "Mine a smeltable ore batch before starting the furnace.");
  }

  if (carriedCount(snapshot, FUEL_NAMES) === 0) {
    const storedFuel = storedItems(snapshot, (name) => FUEL_NAMES.includes(name as (typeof FUEL_NAMES)[number]));
    if (storedFuel.length > 0)
      return [withdrawItems(snapshot, storedFuel, "Withdraw fuel for the furnace work order.", 16)];
    if (!carriesPickaxe(snapshot)) return workKitProcedure(snapshot);
    return miningProcedure(snapshot, "coal", 8, "Mine furnace fuel before attempting to smelt.");
  }

  if (!snapshot.furnaceEstablished && carriedCount(snapshot, COBBLE_NAMES) < 8) {
    const storedCobble = storedItems(snapshot, (name) => COBBLE_NAMES.includes(name as (typeof COBBLE_NAMES)[number]));
    if (storedCobble.length > 0) {
      return [withdrawItems(snapshot, storedCobble, "Withdraw eight cobblestone for the shared furnace.", 8)];
    }
    if (!carriesPickaxe(snapshot)) return workKitProcedure(snapshot);
    return miningProcedure(snapshot, "stone", 8, "Mine eight cobblestone for the shared furnace.");
  }

  if (!snapshot.furnaceEstablished && !snapshot.nearbyCraftingTable && (snapshot.inventory.crafting_table ?? 0) === 0) {
    const crafting = ensurePortableCrafting(snapshot, 4, "Prepare the crafting table for the shared furnace.");
    if (crafting) return crafting;
  }

  return compact([invokeSkill(snapshot, "smelt_ores", description)]);
}

function constructionProcedure(
  snapshot: ObjectiveSnapshot,
  skill: "build_house" | "build_structure",
  description: string,
  target: number,
  fixedParams: Record<string, string> = {},
): ActionOption[] {
  if (accessibleWood(snapshot) < target) {
    const woodInStash = stashWoodItems(snapshot);
    return compact([
      woodInStash.length > 0
        ? withdrawWood(snapshot, woodInStash, target, "Withdraw materials needed to resume construction.")
        : gatherWood(snapshot, target, "Gather only the missing construction material batch."),
    ]);
  }
  return compact([invokeSkill(snapshot, skill, description, fixedParams)]);
}

function leafOptions(view: ObjectiveTreeView, baseOptions: readonly ActionOption[]): ActionOption[] {
  const snapshot = view.snapshot;
  const sub = view.activeSubobjective?.id;
  if (!sub) return [];

  if (sub.startsWith("progression:")) {
    const milestone = sub.slice("progression:".length);
    const aliases: Record<string, string> = {
      starter_shelter: "build_shelter",
      renewable_food: "establish_wheat_farm",
      expanded_house: snapshot.structures.house === "complete" ? "light_shelter" : "build_shelter",
    };
    const alias = aliases[milestone];
    if (alias)
      return leafOptions({ ...view, activeSubobjective: { ...view.activeSubobjective!, id: alias } }, baseOptions);
    switch (milestone) {
      case "wood_supply":
        return compact([gatherWood(snapshot, 64, "Gather sixteen logs for the first shelter stage.")]);
      case "crafting_station": {
        const preparation = ensurePortableCrafting(snapshot, 8, "Prepare a crafting station near the base.");
        if (preparation) return preparation;
        return [
          {
            action: "place_block",
            signature: 'place_block {"blockType":"crafting_table"}',
            description: "Place the crafted table on nearby ground.",
          },
        ];
      }
      case "wooden_pickaxe": {
        const preparation = ensurePortableCrafting(snapshot, 8, "Prepare materials for a first pickaxe.");
        return preparation ?? [craftItem("wooden_pickaxe", 1, "Craft the team's first mining tool.")];
      }
      case "stone_pickaxe": {
        if (!carriesPickaxe(snapshot))
          return leafOptions(
            { ...view, activeSubobjective: { ...view.activeSubobjective!, id: "prepare_mining_tools" } },
            baseOptions,
          );
        if (carriedCount(snapshot, COBBLE_NAMES) < 3)
          return miningProcedure(snapshot, "stone", 3, "Mine stone for a stone pickaxe.");
        const preparation = ensurePortableCrafting(snapshot, 4, "Prepare handles for the stone pickaxe.");
        return preparation ?? [craftItem("stone_pickaxe", 1, "Upgrade the first mining tool to stone.")];
      }
      case "fuel_supply":
        return miningProcedure(snapshot, "coal", 8, "Acquire eight coal for the furnace stage.");
      case "furnace_station":
        return smeltingProcedure(snapshot, "Build and operate the furnace station by smelting starter iron.");
      case "water_bucket":
        if ((snapshot.inventory.bucket ?? 0) === 0 && (snapshot.inventory.iron_ingot ?? 0) < 3)
          return smeltingProcedure(snapshot, "Produce the iron for an expedition bucket.");
        return compact([
          invokeSkill(
            snapshot,
            (snapshot.inventory.bucket ?? 0) > 0 ? "fillBucketWithWater" : "craftBucket",
            "Craft and fill an expedition water bucket.",
          ),
        ]);
      case "iron_pickaxe":
        if ((snapshot.inventory.iron_ingot ?? 0) < 3)
          return smeltingProcedure(snapshot, "Produce iron for the mining upgrade.");
        return compact([
          invokeSkill(snapshot, "craft_gear", "Craft the expedition iron tools.", { target: "iron_tools" }),
        ]);
      case "iron_protection":
        if (!ironArmorComplete(snapshot)) {
          if ((snapshot.inventory.iron_ingot ?? 0) < 24)
            return smeltingProcedure(snapshot, "Produce the expedition armor materials.");
          return compact([
            invokeSkill(snapshot, "craft_gear", "Craft a full iron armor set.", { target: "iron_armor" }),
          ]);
        }
        if (!hasTool(snapshot.inventory, "sword", 3))
          return compact([
            invokeSkill(snapshot, "craft_gear", "Craft the expedition sword.", { target: "iron_tools" }),
          ]);
        return compact([invokeSkill(snapshot, "craftShieldImproved", "Craft an expedition shield.")]);
      case "shared_storage": {
        const storage = snapshot.progressionStorage;
        if (!storage || storage.chestCount < 2)
          return leafOptions(
            {
              ...view,
              activeSubobjective: {
                ...view.activeSubobjective!,
                id: snapshot.stashExists ? "expand_stash" : "establish_stash",
              },
            },
            baseOptions,
          );
        if (!storage.deposited) {
          if (carriedWood(snapshot) < 32)
            return compact([gatherWood(snapshot, 32, "Gather a deposit batch for the shared storage check.")]);
          return [depositStash("Deposit actual resources to verify the shared storage.")];
        }
        const stored = storedItems(snapshot, () => true);
        return stored.length
          ? [withdrawItems(snapshot, stored, "Retrieve a resource to verify shared storage.", 1)]
          : [depositStash("Restock shared storage for its retrieval check.")];
      }
      default:
        // Later goals have no fixed executor yet. Do not run unrelated legacy actions.
        return [];
    }
  }

  switch (sub) {
    case "prepare_farm_supplies": {
      const woodInStash = stashWoodItems(snapshot);
      if (!carriesHoe(snapshot)) {
        const storedHoes = Object.keys(snapshot.stashInventory).filter(
          (name) => name.endsWith("_hoe") && (snapshot.stashInventory[name] ?? 0) > 0,
        );
        if (storedHoes.length > 0) {
          return [withdrawItems(snapshot, storedHoes, "Withdraw an existing hoe.")];
        }
        if (carriedWood(snapshot) < FARM_WOOD_TARGET) {
          return compact([
            woodInStash.length > 0
              ? withdrawWood(snapshot, woodInStash, FARM_WOOD_TARGET, "Withdraw wood specifically for farm tools.")
              : gatherWood(snapshot, FARM_WOOD_TARGET, "Gather enough wood for the selected farm-tool procedure."),
          ]);
        }
        if ((snapshot.inventory.stick ?? 0) < 2) {
          return [craftItem("stick", 4, "Craft the sticks required by the farm hoe.")];
        }
        if (!snapshot.nearbyCraftingTable && (snapshot.inventory.crafting_table ?? 0) === 0) {
          return [craftItem("crafting_table", 1, "Craft the table required to make the farm hoe.")];
        }
        return [craftItem("wooden_hoe", 1, "Craft the missing farm hoe.")];
      }
      if (carriedWood(snapshot) < FARM_WOOD_TARGET) {
        return compact([
          woodInStash.length > 0
            ? withdrawWood(snapshot, woodInStash, FARM_WOOD_TARGET, "Withdraw the remaining farm construction wood.")
            : gatherWood(snapshot, FARM_WOOD_TARGET, "Gather the remaining wood for the selected farm procedure."),
        ]);
      }
      if ((snapshot.inventory.wheat_seeds ?? 0) < 4) {
        if ((snapshot.stashInventory.wheat_seeds ?? 0) > 0) {
          return [withdrawItems(snapshot, ["wheat_seeds"], "Withdraw pooled wheat seeds.", 8)];
        }
        return compact([
          invokeSkill(snapshot, "gather_seeds", "Break nearby grass and collect enough wheat seeds for the farm."),
        ]);
      }
      return [];
    }
    case "locate_farm_site":
      return compact([
        invokeSkill(
          snapshot,
          "locate_farm_site",
          "Survey bounded settlement sectors and persist one reachable exposed farm shore.",
        ),
      ]);
    case "establish_wheat_farm":
      return compact([
        invokeSkill(
          snapshot,
          "build_farm",
          "Prepare a hydrated plot, collect any missing seeds, till it, and plant wheat.",
        ),
      ]);
    case "temporary_fishing_supply":
      return compact([
        invokeSkill(snapshot, "go_fishing", "Catch a temporary food supply while the permanent farm is blocked."),
        actionFromBase(baseOptions, "explore"),
      ]);
    case "inspect_crops":
      return compact([goToFarm(snapshot), actionFromBase(baseOptions, "explore")]);
    case "harvest_and_replant":
      return farmMaintenanceProcedure(snapshot);
    case "bake_bread":
      if ((snapshot.inventory.wheat ?? 0) < 3 && (snapshot.stashInventory.wheat ?? 0) >= 3) {
        return [
          withdrawItems(
            snapshot,
            ["wheat"],
            "Withdraw the pooled wheat required by the selected bread procedure.",
            Math.max(3, snapshot.stashInventory.wheat),
          ),
        ];
      }
      return compact([
        craftItem(
          "bread",
          Math.max(1, Math.floor((snapshot.inventory.wheat ?? 0) / 3)),
          "Bake available wheat into bread.",
        ),
        invokeSkill(snapshot, "build_farm", "Use the farm cycle to pool wheat and bake bread."),
      ]);
    case "stock_food":
      return [depositStash("Deposit prepared food above the three-item personal reserve.", "pantry")];
    case "supplement_food":
      return compact([
        actionFromBase(baseOptions, "attack"),
        (snapshot.inventory.fishing_rod ?? 0) > 0
          ? invokeSkill(snapshot, "go_fishing", "Fish locally while planted crops continue growing.")
          : undefined,
      ]);
    case "establish_stash":
      if (carriedWood(snapshot) < stashWoodTarget(snapshot)) {
        return compact([
          gatherWood(
            snapshot,
            stashWoodTarget(snapshot),
            "Gather the wood required by the selected shared-stash procedure.",
          ),
        ]);
      }
      return compact([
        invokeSkill(snapshot, "setup_stash", "Craft and place the initial shared stash chests.", {
          mode: "ensure",
        }),
      ]);
    case "deposit_surplus":
      return [depositStash("Deposit the carried surplus selected by the storage procedure.")];
    case "expand_stash": {
      const expansionWoodTarget = Math.max(0, 8 - (snapshot.inventory.chest ?? 0) * 8);
      if (carriedWood(snapshot) < expansionWoodTarget) {
        const woodInStash = stashWoodItems(snapshot);
        if (woodInStash.length > 0) {
          return [
            withdrawWood(
              snapshot,
              woodInStash,
              expansionWoodTarget,
              "Withdraw wood before expanding the full shared stash.",
            ),
          ];
        }
        return compact([
          gatherWood(snapshot, expansionWoodTarget, "Gather wood for the selected stash-expansion procedure."),
        ]);
      }
      return compact([
        invokeSkill(snapshot, "setup_stash", "Add and verify genuinely new shared storage capacity.", {
          mode: "expand",
        }),
      ]);
    }
    case "prepare_mining_tools": {
      const stored = storedPickaxes(snapshot);
      if (stored.length > 0) {
        return [withdrawItems(snapshot, stored, "Withdraw the best pooled pickaxe for the shared mine.", 1)];
      }
      if (!carriesPickaxe(snapshot)) {
        const crafting = ensurePortableCrafting(snapshot, 8, "Prepare wood for the first mining pickaxe.");
        if (crafting) return crafting;
        return [craftItem("wooden_pickaxe", 1, "Craft the first pickaxe required to open the shared mine.")];
      }
      return [];
    }
    case "establish_shared_mine":
      return miningProcedure(
        snapshot,
        "general",
        64,
        "Open the anchored shared mine and complete its first lit branch.",
      );
    case "acquire_starter_fuel":
      return miningProcedure(
        snapshot,
        "coal",
        STARTER_FUEL_TARGET - fuelCount(snapshot),
        "Extend the shared mine with coal as the current target.",
      );
    case "acquire_starter_iron":
      return miningProcedure(
        snapshot,
        "iron",
        3 - ironMaterialCount(snapshot),
        "Extend the shared mine with starter iron as the current target.",
      );
    case "smelt_starter_iron":
      return smeltingProcedure(snapshot, "Smelt the supplied starter iron at the shared furnace station.");
    case "establish_furnace_station":
      return smeltingProcedure(
        snapshot,
        "Establish and verify the shared furnace station while processing starter ore.",
      );
    case "upgrade_mining_tools": {
      const stored = storedPickaxes(snapshot, 3);
      if (stored.length > 0) {
        return [withdrawItems(snapshot, stored, "Withdraw the completed iron-or-better pickaxe.", 1)];
      }
      return compact([invokeSkill(snapshot, "craft_gear", "Use the pooled ingots to craft the first iron pickaxe.")]);
    }
    case "replace_mining_tools": {
      const stored = storedPickaxes(snapshot, 2);
      if (stored.length > 0) {
        return [withdrawItems(snapshot, stored, "Withdraw a stone-or-better replacement pickaxe.", 1)];
      }
      return compact([invokeSkill(snapshot, "craft_gear", "Craft a stone-or-better replacement mining tool.")]);
    }
    case "replenish_fuel":
      return miningProcedure(
        snapshot,
        "coal",
        SUPPLY_FUEL_TARGET - fuelCount(snapshot),
        "Extend the established shared mine specifically to replenish coal.",
      );
    case "replenish_iron":
      return miningProcedure(
        snapshot,
        "iron",
        IRON_RESERVE_TARGET - ironMaterialCount(snapshot),
        "Extend the established shared mine specifically to replenish iron.",
      );
    case "replenish_construction_stone":
      return miningProcedure(
        snapshot,
        "stone",
        STONE_RESERVE_TARGET - stoneReserve(snapshot),
        "Extend a shared-mine branch to replenish settlement construction stone.",
      );
    case "process_raw_ores":
      return smeltingProcedure(snapshot, "Process the supplied raw ore at the shared furnace station.");
    case "deposit_mining_resources":
      return [depositStash("Deposit the completed mining haul into shared storage.")];
    case "survey_next_sector":
      return compact([
        invokeSkill(snapshot, "survey_region", "Survey one bounded unmapped sector and return to base."),
      ]);
    case "establish_work_kit":
      return workKitProcedure(snapshot);
    case "upgrade_iron_tools":
      return compact([
        invokeSkill(snapshot, "craft_gear", "Use accessible ingots to upgrade only this bot's core tools.", {
          target: "iron_tools",
        }),
      ]);
    case "equip_iron_armor":
      return compact([
        invokeSkill(snapshot, "craft_gear", "Use the reserved ingots to complete only this bot's iron armor.", {
          target: "iron_armor",
        }),
      ]);
    case "light_core":
      return lightingProcedure(snapshot, "core", "Secure the shared stash and work yard with verified lighting.");
    case "light_lodge_zone":
      return lightingProcedure(snapshot, "lodge", "Secure the completed lodge with verified lighting.");
    case "light_farm_zone":
      return lightingProcedure(snapshot, "farm", "Secure the established farm with verified lighting.");
    case "light_mine_zone":
      return lightingProcedure(snapshot, "mine", "Secure the shared mine entrance with verified lighting.");
    case "establish_cow_pen":
    case "establish_sheep_pen":
    case "establish_chicken_pen":
    case "establish_pig_pen":
      if (accessibleWood(snapshot) < 48) {
        const woodInStash = stashWoodItems(snapshot);
        return compact([
          woodInStash.length > 0
            ? withdrawWood(snapshot, woodInStash, 48, "Withdraw the materials for the selected animal pen.")
            : gatherWood(snapshot, 48, "Gather the bounded material batch for the selected animal pen."),
        ]);
      }
      return compact([
        invokeSkill(snapshot, "establish_animal_pen", "Build a pen, contain a pair, and begin breeding.", {
          species: sub.replace("establish_", "").replace("_pen", ""),
        }),
      ]);
    case "gather_shelter_materials": {
      const woodInStash = stashWoodItems(snapshot);
      return compact([
        woodInStash.length > 0
          ? withdrawWood(snapshot, woodInStash, HOUSE_WOOD_TARGET, "Withdraw actual shelter materials from storage.")
          : undefined,
        gatherWood(snapshot, HOUSE_WOOD_TARGET, "Gather the remaining wood for the selected shelter procedure."),
      ]);
    }
    case "build_shelter":
      return constructionProcedure(
        snapshot,
        "build_house",
        "Build or resume the settlement house blueprint.",
        HOUSE_WOOD_TARGET,
      );
    case "light_shelter":
      return lightingProcedure(snapshot, "lodge", "Light the completed shelter and its entrances.");
    case "gather_settlement_materials": {
      const woodInStash = stashWoodItems(snapshot);
      return compact([
        woodInStash.length > 0
          ? withdrawWood(
              snapshot,
              woodInStash,
              SETTLEMENT_WOOD_TARGET,
              "Withdraw materials for the active settlement building.",
            )
          : undefined,
        gatherWood(
          snapshot,
          SETTLEMENT_WOOD_TARGET,
          "Gather the remaining wood for the selected settlement procedure.",
        ),
      ]);
    }
    case "build_warehouse":
      return constructionProcedure(
        snapshot,
        "build_structure",
        "Build or resume the warehouse blueprint.",
        SETTLEMENT_WOOD_TARGET,
        { structure: "warehouse" },
      );
    case "build_workshop":
      return constructionProcedure(
        snapshot,
        "build_structure",
        "Build or resume the workshop blueprint.",
        SETTLEMENT_WOOD_TARGET,
        { structure: "workshop" },
      );
    case "light_settlement":
      return lightingProcedure(snapshot, "core", "Light active and completed settlement buildings.");
    default:
      return [];
  }
}

function selectionOption(
  action: "choose_objective" | "choose_subobjective",
  parameter: "objective" | "subobjective",
  candidates: { id: string; label: string; description: string; detail?: string }[],
): ActionOption | undefined {
  if (candidates.length === 0) return undefined;
  const allowed = candidates.map((candidate) => candidate.id);
  return {
    action,
    signature: `${action} ${JSON.stringify({ [parameter]: allowed[0] })}`,
    description: candidates
      .map(
        (candidate) =>
          `${candidate.id} = ${candidate.label}: ${candidate.description}${candidate.detail ? ` [${candidate.detail}]` : ""}`,
      )
      .join(" | "),
    allowedParams: { [parameter]: allowed },
  };
}

function leaveOption(): ActionOption {
  return {
    action: "leave_objective",
    signature: 'leave_objective {"reason":"blocked, completed, or deliberately reprioritized"}',
    description: "Abandon the current project only with a concrete reason; return to the objective level.",
  };
}

const SAFETY_ACTIONS = new Set(["eat", "flee", "attack", "neural_combat"]);

/**
 * Build one level of the hierarchy at a time:
 * objective selection → sub-objective selection → executable leaves.
 */
export function buildObjectiveDecisionMenu(
  view: ObjectiveTreeView,
  baseOptions: readonly ActionOption[],
): ActionOption[] {
  const safety = baseOptions.filter((option) => SAFETY_ACTIONS.has(option.action));
  if (!view.commitment || !view.activeObjective) {
    const available = view.objectives.filter(
      (objective) =>
        objective.available &&
        !objective.complete &&
        objective.claimedBy.length < objective.maxWorkers &&
        hasActionableSubobjective(objective, view.snapshot),
    );
    const rolePreferred = available.filter((objective) => objective.preferredRoles.includes(view.snapshot.role));
    const candidates = (rolePreferred.length > 0 ? rolePreferred : available).map((objective) => ({
      id: objective.id,
      label: objective.label,
      description: objective.description,
      detail: `${objective.status}; preferred=${objective.preferredRoles.join(", ")}${
        objective.claimedBy.length
          ? `; ${objective.claimedBy.length}/${objective.maxWorkers} worker(s): ${objective.claimedBy.join(", ")}`
          : `; workers=0/${objective.maxWorkers}`
      }`,
    }));
    const selection = selectionOption("choose_objective", "objective", candidates);
    // Once every implemented domain is satisfied, retain useful legacy
    // actions until later objective packs (exploration, Nether) are added.
    return selection
      ? [...safety, selection]
      : view.progression
        ? [
            ...safety,
            {
              action: "idle",
              signature: "idle {}",
              description:
                "Wait for teammates or blocked progression work; later Nether procedures are not implemented yet.",
            },
          ]
        : [...safety, ...baseOptions.filter((option) => !SAFETY_ACTIONS.has(option.action))];
  }

  if (!view.activeSubobjective) {
    const candidates = view.activeObjective.subobjectives
      .filter((sub) => sub.relevant && !sub.complete && !view.snapshot.recentlyFailed.has(`objective:${sub.id}`))
      .map((sub) => ({ id: sub.id, label: sub.label, description: sub.description }));
    const selection = selectionOption("choose_subobjective", "subobjective", candidates);
    return compact([...safety, selection, leaveOption()]);
  }

  // An active sub-objective is an execution state, not another LLM choice.
  // These leaves exist for the central capability gate; the brain selects and
  // executes them automatically until the sub-objective completes or blocks.
  return compact([...safety, ...leafOptions(view, baseOptions)]);
}

export interface AutomaticObjectiveDecision {
  thought: string;
  action: string;
  params: Record<string, any>;
}

/**
 * Pick the next deterministic leaf for an already-selected sub-objective.
 * The LLM chose the intent; code now performs its reliable procedure.
 */
export function getAutomaticSubobjectiveDecision(
  view: ObjectiveTreeView,
  baseOptions: readonly ActionOption[],
): AutomaticObjectiveDecision | undefined {
  if (!view.activeObjective || !view.activeSubobjective) return undefined;
  const option = leafOptions(view, baseOptions)[0];
  if (!option) return undefined;

  const signatureParams = option.signature.match(/\{.*\}$/)?.[0];
  let params: Record<string, any> = {};
  if (signatureParams) {
    try {
      params = JSON.parse(signatureParams);
    } catch {
      params = {};
    }
  }

  return {
    thought: `${view.activeSubobjective.label}: ${option.description}`,
    action: option.action,
    params,
  };
}

export function renderObjectiveTreeReport(view: ObjectiveTreeView): string {
  const snapshot = view.snapshot;
  const capacity =
    snapshot.stashTotalSlots && snapshot.stashFreeSlots !== null
      ? `${snapshot.stashFreeSlots}/${snapshot.stashTotalSlots} free slots`
      : snapshot.stashExists
        ? "exists; capacity not recently observed"
        : "missing";
  const lines = [
    "SETTLEMENT STATUS:",
    `- Structures: house=${snapshot.structures.house}; farm=${snapshot.structures.farm}; warehouse=${snapshot.structures.warehouse}; workshop=${snapshot.structures.workshop}; mine=${snapshot.structures.mine}`,
    `- Food: ${countFood(snapshot)} prepared items; wheat=${countItem(snapshot, "wheat")}; seeds=${countItem(snapshot, "wheat_seeds")}`,
    `- Resources: fuel=${fuelCount(snapshot)}; raw iron=${rawIronCount(snapshot)}; iron ingots=${ironIngotCount(snapshot)}; construction stone=${stoneReserve(snapshot)}; furnace=${snapshot.furnaceEstablished ? "established" : "needed"}; iron-tool milestone=${ironToolEstablished(snapshot) ? "achieved" : "needed"}; current iron pickaxe=${teamPickaxe(snapshot, 3) ? "yes" : "no"}`,
    `- Storage: ${capacity}; this inventory=${snapshot.inventoryStacks} stacks/${snapshot.inventoryItems} items`,
    `- Farm conditions: nearby water=${snapshot.nearbyWater ? "yes" : "no"}; near known farm=${snapshot.nearFarm ? "yes" : "no"}; ledger=${snapshot.farmLedgerReady ? `${snapshot.farmPlotsTotal} plots` : "needs reconciliation"}; repair=${snapshot.farmPlotsNeedingRepair}; mature=${snapshot.matureWheatNearby}`,
  ];

  if (!view.commitment || !view.activeObjective) {
    lines.push("DECISION LEVEL: Choose one high-level objective. This creates a persistent project.");
    for (const objective of view.objectives.filter((entry) => entry.available && !entry.complete)) {
      lines.push(
        `- ${objective.id}: ${objective.label} — ${objective.status}${
          objective.claimedBy.length ? `; teammate commitment=${objective.claimedBy.join(", ")}` : ""
        }`,
      );
    }
  } else {
    lines.push(
      `ACTIVE PROJECT: ${view.activeObjective.label} (${view.commitment.objectiveId}) — reason: ${view.commitment.reason}`,
    );
    if (view.activeSubobjective) {
      lines.push(
        `ACTIVE SUB-OBJECTIVE: ${view.activeSubobjective.label} (${view.activeSubobjective.id}) — ${view.activeSubobjective.description}`,
      );
      lines.push(
        "EXECUTION LEVEL: Mineflayer is carrying out this sub-objective automatically. The LLM will be asked again after completion or a blocker.",
      );
    } else {
      lines.push("DECISION LEVEL: Choose the next relevant sub-objective. Completed branches are hidden.");
      for (const sub of view.activeObjective.subobjectives.filter((entry) => entry.relevant && !entry.complete)) {
        lines.push(`- ${sub.id}: ${sub.label} — ${sub.description}`);
      }
    }
  }

  if (snapshot.teamCommitments.length > 0) {
    lines.push("TEAM COMMITMENTS:");
    for (const teammate of snapshot.teamCommitments) {
      lines.push(
        `- ${teammate.name}: ${teammate.objectiveId ?? "uncommitted"}${
          teammate.subobjectiveId ? ` → ${teammate.subobjectiveId}` : ""
        }`,
      );
    }
  }

  return lines.join("\n");
}

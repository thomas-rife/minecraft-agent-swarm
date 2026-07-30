import type { Bot } from "mineflayer";
import type { PostconditionResult } from "../operations/types.js";
import { getVerifiedStructure, verifyCanonicalStash, verifyFarmSite } from "../world/registry.js";
import type { SkillContract } from "./types.js";

interface SkillBaseline {
  capturedAt: number;
  position: { x: number; y: number; z: number };
  inventory: Record<string, number>;
  nearbyTorches: number;
  nearbyFarmland: number;
}

function inventory(bot: Bot): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of bot.inventory.items()) result[item.name] = (result[item.name] ?? 0) + item.count;
  return result;
}

function nearbyCount(bot: Bot, names: string[], radius = 16): number {
  try {
    return bot.findBlocks({ matching: (block) => names.includes(block.name), maxDistance: radius, count: 256 }).length;
  } catch {
    return 0;
  }
}

function capture(bot: Bot): SkillBaseline {
  const pos = bot.entity.position;
  return {
    capturedAt: Date.now(),
    position: { x: pos.x, y: pos.y, z: pos.z },
    inventory: inventory(bot),
    nearbyTorches: nearbyCount(bot, ["torch", "wall_torch"]),
    nearbyFarmland: nearbyCount(bot, ["farmland"], 24),
  };
}

function sumMatching(items: Record<string, number>, predicate: (name: string) => boolean): number {
  return Object.entries(items).reduce((total, [name, count]) => total + (predicate(name) ? count : 0), 0);
}

function condition(name: string, satisfied: boolean, evidence: unknown): PostconditionResult {
  return { name, satisfied, evidence };
}

function baseline(value: unknown): SkillBaseline {
  return value as SkillBaseline;
}

const contracts: Record<string, SkillContract> = {
  build_house: {
    purpose: "Build or resume a verified, enclosed house from the canonical blueprint.",
    useWhen: "The settlement needs a verified shelter or an existing house is incomplete.",
    doNotUseWhen: "No building materials can be obtained safely.",
    requiredStatus: ["reachable build site", "building blocks available or gatherable"],
    successCriteria: ["blueprint shell >=85%", "entrance door present", "house registered verified"],
    knownFailureCodes: ["MATERIAL_GATHER_FAILED", "HOUSE_INCOMPLETE", "SKILL_POSTCONDITION_FAILED"],
    progressPolicy: "Report blocks placed, blocks skipped, phase, and blueprint completion.",
    recoveryPolicy: "Keep partial cells; rerun inspects and fills missing blueprint cells.",
    capture,
    retryable: true,
    timeoutMs: 240_000,
    async postconditions(_bot, _params, value) {
      const before = baseline(value);
      const house = getVerifiedStructure("house");
      return [condition("verified_house_registered", !!house && (house.verifiedAt ?? 0) >= before.capturedAt, house ?? null)];
    },
  },
  craft_gear: {
    purpose: "Craft the best useful tools, armor, and shield available from verified inventory.",
    useWhen: "Required survival or work gear is missing.",
    doNotUseWhen: "Useful gear is already present and no upgrade materials exist.",
    requiredStatus: ["crafting inputs or stash supply available"],
    successCriteria: ["usable gear remains in inventory or equipment after crafting"],
    knownFailureCodes: ["MATERIAL_GATHER_FAILED", "SKILL_POSTCONDITION_FAILED"],
    progressPolicy: "Report preparation and crafted item counts.",
    recoveryPolicy: "Preserve crafted intermediates and retry only after materials change.",
    capture,
    retryable: true,
    async postconditions(bot, _params, value) {
      const before = baseline(value);
      const isGear = (name: string) =>
        ["pickaxe", "axe", "sword", "shovel", "hoe", "helmet", "chestplate", "leggings", "boots", "shield"].some(
          (part) => name.includes(part),
        );
      const previous = sumMatching(before.inventory, isGear);
      const current = sumMatching(inventory(bot), isGear);
      return [condition("usable_gear_present", current > 0 && current >= previous, { previous, current })];
    },
  },
  light_area: {
    purpose: "Place verified lighting around the current work area.",
    useWhen: "A work area is dark or needs safer traversal.",
    doNotUseWhen: "No torches can be obtained.",
    requiredStatus: ["safe standing area", "torches available or craftable"],
    successCriteria: ["nearby torch count increases"],
    knownFailureCodes: ["MATERIAL_GATHER_FAILED", "SKILL_POSTCONDITION_FAILED"],
    progressPolicy: "Report torches placed and candidate locations checked.",
    recoveryPolicy: "Skip obstructed cells and resume remaining placements.",
    capture,
    retryable: true,
    async postconditions(bot, _params, value) {
      const before = baseline(value);
      const current = nearbyCount(bot, ["torch", "wall_torch"]);
      return [condition("lighting_increased", current > before.nearbyTorches, { before: before.nearbyTorches, current })];
    },
  },
  build_farm: {
    purpose: "Build, verify, harvest, and replant the canonical irrigated crop farm.",
    useWhen: "No verified farm exists or mature crops need a harvest cycle.",
    doNotUseWhen: "The canonical site is unreachable and no safe alternate site is available.",
    requiredStatus: ["reachable farm site", "water access", "hoe and seeds obtainable"],
    successCriteria: ["at least 9 farmland blocks", "nearby water", "planted crops", "farm registry verified"],
    knownFailureCodes: ["MATERIAL_GATHER_FAILED", "SKILL_POSTCONDITION_FAILED", "OPERATION_TIMED_OUT"],
    progressPolicy: "Report travel, seed collection, tilled cells, crops planted, and harvest output.",
    recoveryPolicy: "Retain verified farmland and resume missing planting cells on rerun.",
    capture,
    retryable: true,
    timeoutMs: 240_000,
    async postconditions(bot, params) {
      const position = {
        x: Number.isFinite(Number(params.x)) ? Number(params.x) : bot.entity.position.x,
        y: Number.isFinite(Number(params.y)) ? Number(params.y) : bot.entity.position.y,
        z: Number.isFinite(Number(params.z)) ? Number(params.z) : bot.entity.position.z,
      };
      const farm = verifyFarmSite(bot, "shared-farm", position, 16);
      return [condition("irrigated_farm_verified", farm.status === "verified", farm.evidence ?? farm.failureReason)];
    },
  },
  strip_mine: {
    purpose: "Complete a bounded mining expedition and return to its registered entrance.",
    useWhen: "The bot has a pickaxe, food, and needs underground resources.",
    doNotUseWhen: "The bot cannot reserve a safe entrance or recovery route.",
    requiredStatus: ["pickaxe available", "entrance can be registered", "return route enabled"],
    successCriteria: ["exploration stage completes", "bot returns within 3 blocks of registered entrance"],
    knownFailureCodes: ["MINING_COMPLETE_RETURN_FAILED", "SKILL_POSTCONDITION_FAILED", "OPERATION_TIMED_OUT"],
    progressPolicy: "Report stage, depth, tunnel blocks, ores found, endpoint, and return status.",
    recoveryPolicy: "On interruption or failed return, hand control to deterministic trapped recovery.",
    capture,
    retryable: true,
    timeoutMs: 240_000,
    async preconditions(bot) {
      const items = inventory(bot);
      const pickaxes = sumMatching(items, (name) => name.endsWith("_pickaxe"));
      const torches = items.torch ?? 0;
      const reserveBlocks = sumMatching(
        items,
        (name) => name.endsWith("_planks") || ["dirt", "cobblestone", "stone"].includes(name),
      );
      const carriedFood = sumMatching(items, (name) =>
        ["bread", "apple", "carrot", "potato", "beef", "porkchop", "chicken", "mutton", "salmon", "cod"].some((food) =>
          name.includes(food),
        ),
      );
      return [
        condition("pickaxe_available", pickaxes > 0, { pickaxes }),
        condition("torches_reserved", torches >= 4, { torches, required: 4 }),
        condition("escape_blocks_reserved", reserveBlocks >= 8, { reserveBlocks, required: 8 }),
        condition("food_reserve_available", bot.food >= 12 || carriedFood >= 2, { hunger: bot.food, carriedFood }),
      ];
    },
    async postconditions(bot, _params, value) {
      const before = baseline(value);
      const dx = bot.entity.position.x - before.position.x;
      const dy = bot.entity.position.y - before.position.y;
      const dz = bot.entity.position.z - before.position.z;
      const distance = Math.hypot(dx, dy, dz);
      return [condition("returned_to_mine_entrance", distance <= 3, { distance, entrance: before.position })];
    },
  },
  smelt_ores: {
    purpose: "Turn raw ore into verified ingot inventory using a reachable furnace.",
    useWhen: "Raw ore and fuel are available locally or in the verified stash.",
    doNotUseWhen: "There is no ore to smelt.",
    requiredStatus: ["ore available", "fuel obtainable", "furnace openable"],
    successCriteria: ["ingot inventory count increases"],
    knownFailureCodes: ["MATERIAL_GATHER_FAILED", "SKILL_POSTCONDITION_FAILED", "OPERATION_TIMED_OUT"],
    progressPolicy: "Report furnace access, ore loaded, fuel loaded, and ingots collected.",
    recoveryPolicy: "Close the furnace, preserve remaining inputs, and retry after access or fuel changes.",
    capture,
    retryable: true,
    async postconditions(bot, _params, value) {
      const before = baseline(value);
      const isIngot = (name: string) => name.endsWith("_ingot") || name === "copper_ingot";
      const previous = sumMatching(before.inventory, isIngot);
      const current = sumMatching(inventory(bot), isIngot);
      return [condition("ingot_inventory_increased", current > previous, { previous, current })];
    },
  },
  go_fishing: {
    purpose: "Fish until at least one verifiable loot item is acquired.",
    useWhen: "Food or fishing loot is needed and a safe water edge is reachable.",
    doNotUseWhen: "No fishing rod or reachable water exists.",
    requiredStatus: ["fishing rod available", "reachable water"],
    successCriteria: ["non-rod inventory gains a fishing loot item"],
    knownFailureCodes: ["SKILL_POSTCONDITION_FAILED", "OPERATION_TIMED_OUT"],
    progressPolicy: "Report water search, casts, bites, and catches.",
    recoveryPolicy: "Stop using the rod, leave controls clear, and choose another water edge.",
    capture,
    retryable: true,
    async postconditions(bot, _params, value) {
      const before = baseline(value);
      const after = inventory(bot);
      const gained = Object.entries(after)
        .filter(([name, count]) => name !== "fishing_rod" && count > (before.inventory[name] ?? 0))
        .map(([name, count]) => ({ name, gained: count - (before.inventory[name] ?? 0) }));
      return [condition("fishing_loot_acquired", gained.length > 0, { gained })];
    },
  },
  build_bridge: {
    purpose: "Build a traversable bridge while maintaining a recoverable standing route.",
    useWhen: "A short obstacle needs a safe crossing and blocks are available.",
    doNotUseWhen: "The gap or destination cannot be validated.",
    requiredStatus: ["bridge blocks available", "safe starting edge"],
    successCriteria: ["bridge blocks consumed", "bot makes forward positional progress"],
    knownFailureCodes: ["MATERIAL_GATHER_FAILED", "SKILL_POSTCONDITION_FAILED"],
    progressPolicy: "Report blocks placed and traversal distance.",
    recoveryPolicy: "Stop at the last supported block and resume from verified placements.",
    capture,
    retryable: true,
    async postconditions(bot, _params, value) {
      const before = baseline(value);
      const isBridgeBlock = (name: string) => name.includes("cobblestone") || name.endsWith("_planks") || name === "stone";
      const previous = sumMatching(before.inventory, isBridgeBlock);
      const current = sumMatching(inventory(bot), isBridgeBlock);
      const distance = Math.hypot(bot.entity.position.x - before.position.x, bot.entity.position.z - before.position.z);
      return [condition("bridge_progress_verified", current < previous && distance >= 2, { previous, current, distance })];
    },
  },
  setup_stash: {
    purpose: "Establish or revalidate the canonical shared storage container.",
    useWhen: "No verified canonical stash exists or the registered stash needs revalidation.",
    doNotUseWhen: "The configured canonical site is unreachable.",
    requiredStatus: ["system-injected canonical coordinates", "site reachable", "chest materials obtainable"],
    successCriteria: ["at least one canonical chest exists", "container opens", "capacity and identity recorded", "registry verified"],
    knownFailureCodes: ["SKILL_PRECONDITION_FAILED", "SKILL_POSTCONDITION_FAILED", "OPERATION_TIMED_OUT"],
    progressPolicy: "Report navigation, material preparation, chests placed, container capacity, and registry status.",
    recoveryPolicy: "Revalidate exact canonical blocks; keep one openable chest as the valid minimum and expand later.",
    capture,
    retryable: true,
    async postconditions(bot, params) {
      const position = { x: Number(params.x), y: Number(params.y), z: Number(params.z) };
      if (![position.x, position.y, position.z].every(Number.isFinite)) {
        return [condition("canonical_stash_openable", false, { reason: "invalid_coordinates", position })];
      }
      const stash = await verifyCanonicalStash(bot, "shared-stash", position, 5);
      return [condition("canonical_stash_openable", stash.status === "verified", stash.evidence ?? stash.failureReason)];
    },
    validate(params) {
      const valid = [params.x, params.y, params.z].every((value) => Number.isFinite(Number(value)));
      return [condition("canonical_coordinates_valid", valid, { x: params.x, y: params.y, z: params.z })];
    },
  },
};

export function getStaticSkillContract(name: string): SkillContract | undefined {
  return contracts[name];
}

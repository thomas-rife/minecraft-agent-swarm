import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { getDynamicSkillNames } from "../skills/dynamic-loader.js";
import { isRetired } from "../skills/reliability.js";
import { skillRegistry } from "../skills/registry.js";
import { isHostile, isPassive } from "./perception.js";

export interface ActionOption {
  /** Executor action name. Skill options use invoke_skill. */
  action: string;
  /** Exact compact example shown to the model. */
  signature: string;
  /** Why this option is useful/available in the current state. */
  description: string;
  /** A skill option may only invoke this exact registered skill. */
  skill?: string;
  /** Restrict a parameter to values observed or selected by deterministic code. */
  allowedParams?: Record<string, string[]>;
  /** go_to may target only these coordinates from memory/current state. */
  coordinateTargets?: { x: number; y: number; z: number; label: string }[];
}

export interface ActionMenuContext {
  roleName: string;
  role?: string;
  preferredActions: string[];
  preferredSkills: string[];
  goal?: string;
  recentlyFailed?: ReadonlySet<string>;
  stashPos?: { x: number; y: number; z: number };
  structures?: ReadonlySet<string>;
  woodNeeded?: boolean;
  pendingPlayerMessage?: boolean;
  /** Dynamic one-off skills stay quarantined unless an external directive
   * explicitly names them. Model-authored goals do not grant this capability. */
  explicitlyRequestedSkills?: ReadonlySet<string>;
  knownLocations?: { x: number; y: number; z: number; label: string }[];
}

export interface DecisionForValidation {
  action: string;
  params: Record<string, any>;
}

export interface DecisionValidation {
  ok: boolean;
  reason?: string;
}

export const ACTION_SIGNATURES: Record<string, string> = {
  choose_objective: 'choose_objective {"objective":"food_production"}',
  choose_subobjective: 'choose_subobjective {"subobjective":"establish_wheat_farm"}',
  leave_objective: 'leave_objective {"reason":"concrete reason"}',
  gather_wood: 'gather_wood {"count":5}',
  mine_block: 'mine_block {"blockType":"iron_ore"}',
  go_to: 'go_to {"x":0,"y":64,"z":0}',
  explore: 'explore {"direction":"north"}',
  craft: 'craft {"item":"oak_planks","count":4}',
  eat: "eat {}",
  attack: "attack {}",
  flee: "flee {}",
  place_block: 'place_block {"blockType":"oak_planks"}',
  sleep: "sleep {}",
  idle: "idle {}",
  chat: 'chat {"message":"..."}',
  respond_to_chat: 'respond_to_chat {"message":"..."}',
  invoke_skill: 'invoke_skill {"skill":"exact_skill_name"}',
  neural_combat: 'neural_combat {"duration":5}',
  give_item: 'give_item {"to":"Flora","item":"oak_log","count":8}',
  deposit_stash: "deposit_stash {}",
  withdraw_stash: 'withdraw_stash {"item":"oak_log","count":8}',
};

const BUILTIN_SKILLS = new Set([
  "build_house",
  "craft_gear",
  "light_area",
  "build_farm",
  "strip_mine",
  "smelt_ores",
  "go_fishing",
  "build_bridge",
  "setup_stash",
  "build_structure",
  "gather_seeds",
  "locate_farm_site",
  "survey_region",
  "establish_animal_pen",
]);

const LOG_NAMES = new Set([
  "oak_log",
  "birch_log",
  "spruce_log",
  "jungle_log",
  "acacia_log",
  "dark_oak_log",
  "mangrove_log",
  "cherry_log",
  "pale_oak_log",
]);

const MINEABLE_TARGETS = [
  "diamond_ore",
  "deepslate_diamond_ore",
  "iron_ore",
  "deepslate_iron_ore",
  "coal_ore",
  "deepslate_coal_ore",
  "gold_ore",
  "deepslate_gold_ore",
  "copper_ore",
  "deepslate_copper_ore",
  "lapis_ore",
  "deepslate_lapis_ore",
  "redstone_ore",
  "deepslate_redstone_ore",
  "emerald_ore",
  "deepslate_emerald_ore",
  "stone",
  "cobblestone",
  "dirt",
  "grass_block",
];

const BUILDING_ITEMS =
  /(?:_planks|_log|cobblestone|stone_bricks|bricks|glass|dirt|torch|fence|slab|stairs|door|chest)$/;

function safeItems(bot: Bot): any[] {
  try {
    return bot.inventory.items();
  } catch {
    return [];
  }
}

function itemCount(items: any[], predicate: (name: string) => boolean): number {
  return items.filter((item) => predicate(item.name)).reduce((sum, item) => sum + Number(item.count || 0), 0);
}

function hasNearbyBlock(bot: Bot, names: ReadonlySet<string>, maxDistance: number): boolean {
  try {
    return !!bot.findBlock({ matching: (block) => names.has(block.name), maxDistance });
  } catch {
    return false;
  }
}

function nearbyBlockNames(bot: Bot, names: readonly string[], maxDistance: number): string[] {
  const wanted = new Set(names);
  try {
    if (typeof bot.findBlocks === "function") {
      const positions = bot.findBlocks({
        matching: (block) => wanted.has(block.name),
        maxDistance,
        count: 128,
      });
      const found = new Set<string>();
      for (const position of positions) {
        const block = bot.blockAt(position);
        if (block && wanted.has(block.name)) found.add(block.name);
      }
      return names.filter((name) => found.has(name));
    }
  } catch {
    // Fall through to individual probes for partial/mocked bot APIs.
  }

  const found: string[] = [];
  for (const name of names) {
    try {
      if (bot.findBlock({ matching: (block) => block.name === name, maxDistance })) found.push(name);
    } catch {
      // Chunks can unload between the state scan and the decision. Omit it.
    }
  }
  return found;
}

function nearbyEntities(bot: Bot): any[] {
  try {
    return Object.values(bot.entities).filter(
      (entity: any) =>
        entity !== bot.entity && entity?.position && bot.entity.position.distanceTo(entity.position) <= 16,
    );
  } catch {
    return [];
  }
}

function hasFood(bot: Bot, items: any[]): boolean {
  const foods = (bot as any).registry?.foodsByName;
  if (foods) return items.some((item) => foods[item.name]);
  return items.some((item) =>
    /^(?:bread|apple|carrot|potato|baked_potato|beef|cooked_beef|porkchop|cooked_porkchop|chicken|cooked_chicken|mutton|cooked_mutton|rabbit|cooked_rabbit|melon_slice|sweet_berries)$/.test(
      item.name,
    ),
  );
}

function goalHas(goal: string, pattern: RegExp): boolean {
  return pattern.test(goal);
}

function words(value: string): Set<string> {
  const splitCamel = value.replace(/([a-z])([A-Z])/g, "$1 $2");
  return new Set(
    splitCamel
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 3 && !["the", "and", "with", "from", "more", "some"].includes(word)),
  );
}

function dynamicSkillRelevant(name: string, description: string, goal: string): boolean {
  if (!goal.trim()) return false;
  const goalWords = words(goal);
  const skillWords = words(`${name} ${description}`);
  let overlap = 0;
  for (const word of skillWords) {
    if (goalWords.has(word)) overlap++;
  }
  // Exact distinctive nouns such as cactus/pigs/scaffolding are enough;
  // otherwise require two matching concepts to avoid unrelated one-off skills.
  return overlap >= 2 || [...goalWords].some((word) => word.length >= 6 && skillWords.has(word));
}

function skillRelevant(
  name: string,
  context: ActionMenuContext,
  items: any[],
  hasHostile: boolean,
  hasWater: boolean,
  hasHouse: boolean,
  hasFarm: boolean,
  hasStash: boolean,
): boolean {
  const goal = (context.goal || "").toLowerCase();
  const preferred = context.preferredSkills.includes(name);
  const hasPickaxe = items.some((item) => item.name.endsWith("_pickaxe"));
  const hasRawOre = items.some((item) => item.name.startsWith("raw_"));
  const hasHoe = items.some((item) => item.name.endsWith("_hoe"));
  const hasTorches = itemCount(items, (item) => item === "torch") > 0;

  switch (name) {
    case "build_farm":
      return (preferred || goalHas(goal, /\b(?:farm|wheat|crop|food|bread|harvest)\b/)) && (!hasFarm || !!goal);
    case "strip_mine":
      return hasPickaxe && (preferred || goalHas(goal, /\b(?:mine|mining|ore|iron|coal|diamond)\b/));
    case "smelt_ores":
      return hasRawOre && (preferred || goalHas(goal, /\b(?:smelt|ingot|ore|iron|copper|gold)\b/));
    case "craft_gear":
      return (
        goalHas(goal, /\b(?:gear|tool|pickaxe|axe|shovel|hoe|sword|armor|helmet|chestplate)\b/) ||
        (preferred && (!hasPickaxe || (context.roleName === "Flora" && !hasHoe)))
      );
    case "build_house":
      return !hasHouse && (preferred || goalHas(goal, /\b(?:house|home|shelter)\b/));
    case "build_structure":
      return hasHouse && preferred;
    case "setup_stash":
      return !hasStash && preferred;
    case "light_area":
      return hasTorches && (preferred || goalHas(goal, /\b(?:light|torch|dark|spawnproof|safe|structure|base)\b/));
    case "build_bridge":
      return hasWater && goalHas(goal, /\b(?:bridge|cross|river|water)\b/);
    case "go_fishing":
      return hasWater && (preferred || goalHas(goal, /\b(?:fish|fishing|food)\b/));
    case "neural_combat":
      return hasHostile;
    default: {
      const skill = skillRegistry.get(name);
      if (!skill || BUILTIN_SKILLS.has(name)) return preferred && !!goal;
      return !!context.explicitlyRequestedSkills?.has(name) && dynamicSkillRelevant(name, skill.description, goal);
    }
  }
}

function skillSignature(name: string, fixedParams: Record<string, string> = {}): string {
  const params: Record<string, string> = { skill: name, ...fixedParams };
  return `invoke_skill ${JSON.stringify(params)}`;
}

/**
 * Build the small, live menu the LLM is permitted to choose from this turn.
 * Permissions remain broad: a non-specialist can use a skill when its current
 * goal actually matches. What disappears is globally advertising irrelevant
 * and currently impossible actions.
 */
export function buildActionMenu(bot: Bot, context: ActionMenuContext): ActionOption[] {
  const items = safeItems(bot);
  const goal = (context.goal || "").toLowerCase();
  const failures = context.recentlyFailed ?? new Set<string>();
  const entities = nearbyEntities(bot);
  const hasHostile = entities.some((entity) => isHostile(entity));
  const hasAnimal = entities.some((entity) => isPassive(entity));
  const visibleTrees = hasNearbyBlock(bot, LOG_NAMES, 64);
  const observedMineable = nearbyBlockNames(bot, MINEABLE_TARGETS, 24);
  const visibleMineable = observedMineable.filter((name) => {
    if (name.includes("ore")) return true;
    if (context.preferredActions.includes("mine_block")) return true;
    if (name === "stone" || name === "cobblestone") return goalHas(goal, /\b(?:stone|cobblestone|mine|tunnel)\b/);
    if (name === "dirt" || name === "grass_block") return goalHas(goal, /\b(?:dirt|terraform|flatten|excavate)\b/);
    return false;
  });
  const waterNames = new Set(["water"]);
  const hasWater = hasNearbyBlock(bot, waterNames, 32);
  const bedNames = new Set([
    "white_bed",
    "orange_bed",
    "magenta_bed",
    "light_blue_bed",
    "yellow_bed",
    "lime_bed",
    "pink_bed",
    "gray_bed",
    "light_gray_bed",
    "cyan_bed",
    "purple_bed",
    "blue_bed",
    "brown_bed",
    "green_bed",
    "red_bed",
    "black_bed",
  ]);
  const hasBed = items.some((item) => item.name.endsWith("_bed")) || hasNearbyBlock(bot, bedNames, 32);
  const hasStash = !!context.stashPos && hasNearbyBlock(bot, new Set(["chest", "trapped_chest", "barrel"]), 16);
  const structures = context.structures ?? new Set<string>();
  const hasHouse = structures.has("house");
  const hasFarm = structures.has("farm");
  const time = Number((bot as any).time?.timeOfDay ?? 0);
  const isNight = time >= 13000 && time <= 23000;
  const totalWood = itemCount(items, (name) => name.endsWith("_log") || name.endsWith("_planks"));
  const totalItems = itemCount(items, () => true);
  const itemStacks = items.length;
  const options: ActionOption[] = [];

  const add = (option: ActionOption, failureKey = option.action) => {
    if (failures.has(failureKey)) return;
    if (!options.some((existing) => existing.action === option.action && existing.skill === option.skill)) {
      options.push(option);
    }
  };

  // Exploration is always a safe way to acquire new information.
  add({ action: "explore", signature: ACTION_SIGNATURES.explore, description: "Scout one bounded direction." });
  const knownTargets = (context.knownLocations ?? [])
    .map((target) => {
      const destination = new Vec3(target.x, target.y, target.z);
      const distance = bot.entity.position.distanceTo(destination);
      if (distance <= 200) return target;
      // Long trips use a deterministic waypoint instead of asking the model
      // to invent coordinates or submitting a target the executor will reject.
      const fraction = 180 / distance;
      return {
        x: Math.round(bot.entity.position.x + (target.x - bot.entity.position.x) * fraction),
        y: Math.round(bot.entity.position.y),
        z: Math.round(bot.entity.position.z + (target.z - bot.entity.position.z) * fraction),
        label: `waypoint toward ${target.label}`,
      };
    })
    .filter((target) => {
      const distance = bot.entity.position.distanceTo(new Vec3(target.x, target.y, target.z));
      return distance >= 2 && distance <= 200;
    });
  if (knownTargets.length > 0) {
    const first = knownTargets[0];
    add({
      action: "go_to",
      signature: `go_to ${JSON.stringify({ x: first.x, y: first.y, z: first.z })}`,
      description: `Travel only to a known location: ${knownTargets
        .slice(0, 6)
        .map((target) => `${target.label}=(${target.x},${target.y},${target.z})`)
        .join("; ")}.`,
      coordinateTargets: knownTargets,
    });
  }

  if (hasHostile || Number(bot.health ?? 20) <= 8) {
    add({ action: "flee", signature: ACTION_SIGNATURES.flee, description: "Escape an immediate threat." });
  }
  if (hasHostile) {
    add({ action: "attack", signature: ACTION_SIGNATURES.attack, description: "Attack the visible hostile." });
    add({
      action: "neural_combat",
      signature: ACTION_SIGNATURES.neural_combat,
      description: "Use combat control against the visible hostile.",
    });
  } else if (hasAnimal && (Number(bot.food ?? 20) <= 14 || goalHas(goal, /\b(?:hunt|food|meat|wool)\b/))) {
    add({ action: "attack", signature: ACTION_SIGNATURES.attack, description: "Hunt a visible food animal." });
  }

  if (Number(bot.food ?? 20) < 18 && hasFood(bot, items)) {
    add({ action: "eat", signature: ACTION_SIGNATURES.eat, description: "Eat food already in inventory." });
  }
  if (isNight && hasBed) {
    add({ action: "sleep", signature: ACTION_SIGNATURES.sleep, description: "Sleep in a reachable bed at night." });
  }

  if (visibleTrees && (context.woodNeeded || totalWood < 8 || goalHas(goal, /\b(?:wood|log|plank)\b/))) {
    add({
      action: "gather_wood",
      signature: ACTION_SIGNATURES.gather_wood,
      description: "Gather visible trees because the current objective still needs wood.",
    });
  }

  if (visibleMineable.length > 0) {
    add({
      action: "mine_block",
      signature: `mine_block {"blockType":"${visibleMineable[0]}"}`,
      description: `Mine only a visible target: ${visibleMineable.join(", ")}.`,
      allowedParams: { blockType: visibleMineable },
    });
  }

  const hasCraftInputs = items.some((item) =>
    /(?:_log|_planks|stick|cobblestone|stone|raw_|ingot|coal|wool|wheat)/.test(item.name),
  );
  if (hasCraftInputs || goalHas(goal, /\b(?:craft|make|tool|gear|plank|stick|torch|table|furnace|bed)\b/)) {
    add({ action: "craft", signature: ACTION_SIGNATURES.craft, description: "Craft a valid Minecraft item." });
  }

  const placeableItems = items.filter((item) => BUILDING_ITEMS.test(item.name)).map((item) => item.name);
  if (placeableItems.length > 0 && goalHas(goal, /\b(?:build|place|repair|bridge|wall|floor|roof)\b/)) {
    add({
      action: "place_block",
      signature: `place_block {"blockType":"${placeableItems[0]}"}`,
      description: `Place a carried building block: ${placeableItems.slice(0, 8).join(", ")}.`,
      allowedParams: { blockType: placeableItems },
    });
  }

  if (context.stashPos && (itemStacks >= 12 || totalItems >= 96 || goalHas(goal, /\bdeposit\b/))) {
    add({
      action: "deposit_stash",
      signature: ACTION_SIGNATURES.deposit_stash,
      description: "Deposit surplus items at the configured shared stash.",
    });
  }
  if (
    context.stashPos &&
    !!goal &&
    goalHas(goal, /\b(?:need|build|craft|smelt|farm|gear|tool|torch|wood|log|plank|seed|ore|iron)\b/)
  ) {
    add({
      action: "withdraw_stash",
      signature: ACTION_SIGNATURES.withdraw_stash,
      description: "Withdraw a specifically needed item from the shared stash.",
    });
  }

  if (context.pendingPlayerMessage) {
    add({
      action: "chat",
      signature: ACTION_SIGNATURES.chat,
      description: "Reply once to the pending player message.",
    });
  }

  const dynamicNames = new Set(getDynamicSkillNames());
  for (const [name, skill] of skillRegistry.entries()) {
    const key = `skill:${name}`;
    if (failures.has(key) || isRetired(name)) continue;
    if (!skillRelevant(name, context, items, hasHostile, hasWater, hasHouse, hasFarm, hasStash)) continue;

    const fixedParams: Record<string, string> = {};
    if (name === "build_structure") {
      if (!structures.has("warehouse")) fixedParams.structure = "warehouse";
      else if (!structures.has("workshop")) fixedParams.structure = "workshop";
      else continue;
    }

    add(
      {
        action: "invoke_skill",
        skill: name,
        signature: skillSignature(name, fixedParams),
        description: `${skill.description}${dynamicNames.has(name) ? " (goal-matched dynamic skill)" : ""}`,
        allowedParams: Object.keys(fixedParams).length
          ? Object.fromEntries(Object.entries(fixedParams).map(([keyName, value]) => [keyName, [value]]))
          : undefined,
      },
      key,
    );
  }

  return options;
}

export function renderActionMenu(options: readonly ActionOption[]): string {
  return options.map((option) => `- ${option.signature}: ${option.description}`).join("\n");
}

function validationOption(decision: DecisionForValidation, options: readonly ActionOption[]): ActionOption | undefined {
  if (decision.action === "invoke_skill") {
    const skill = String(decision.params?.skill || "");
    return options.find((option) => option.action === "invoke_skill" && option.skill === skill);
  }
  if (skillRegistry.has(decision.action)) {
    return options.find((option) => option.action === "invoke_skill" && option.skill === decision.action);
  }
  return options.find((option) => option.action === decision.action && !option.skill);
}

/**
 * Final authority immediately before execution. Prompt/schema guidance improves
 * model output, but only this gate guarantees hallucinated or stale decisions
 * never reach Mineflayer.
 */
export function validateDecisionAgainstMenu(
  bot: Bot,
  decision: DecisionForValidation,
  options: readonly ActionOption[],
): DecisionValidation {
  const option = validationOption(decision, options);
  if (!option) {
    return {
      ok: false,
      reason: `"${decision.action}" is not available in the current state. Choose exactly one item from AVAILABLE NOW.`,
    };
  }

  const params = decision.params ?? {};
  if (decision.action === "invoke_skill" && (!params.skill || params.skill !== option.skill)) {
    return { ok: false, reason: `invoke_skill must name one of the exact skills in AVAILABLE NOW.` };
  }

  for (const [name, allowed] of Object.entries(option.allowedParams ?? {})) {
    if (!allowed.includes(String(params[name] ?? ""))) {
      return { ok: false, reason: `${decision.action}.${name} must be one of: ${allowed.join(", ")}.` };
    }
  }

  if (decision.action === "go_to") {
    const coords = params.coordinates;
    const x = Number(params.x ?? coords?.[0]);
    const y = Number(params.y ?? (coords?.length >= 3 ? coords[1] : bot.entity.position.y));
    const z = Number(params.z ?? (coords?.length >= 3 ? coords[2] : coords?.[1]));
    if (![x, y, z].every(Number.isFinite)) {
      return { ok: false, reason: "go_to requires finite x, y, and z coordinates from known state or memory." };
    }
    const distance = bot.entity.position.distanceTo(new Vec3(x, y, z));
    if (distance > 200) {
      return {
        ok: false,
        reason: `go_to target is ${distance.toFixed(0)} blocks away; direct navigation is capped at 200.`,
      };
    }
    const matchesKnownTarget = (option.coordinateTargets ?? []).some(
      (target) => Math.hypot(x - target.x, y - target.y, z - target.z) <= 3,
    );
    if (!matchesKnownTarget) {
      return { ok: false, reason: "go_to coordinates must match a known location listed in AVAILABLE NOW." };
    }
  }

  if (decision.action === "explore") {
    const direction = String(params.direction || "").toLowerCase();
    if (direction && !["north", "south", "east", "west", "up"].includes(direction)) {
      return { ok: false, reason: "explore direction must be north, south, east, west, or up." };
    }
  }

  if (decision.action === "craft") {
    const item = String(params.item || "");
    if (!item) return { ok: false, reason: "craft requires an exact Minecraft item ID." };
    const registry = (bot as any).registry;
    if (registry?.itemsByName && !registry.itemsByName[item]) {
      return { ok: false, reason: `"${item}" is not a valid Minecraft item ID.` };
    }
    if (registry?.itemsByName?.[item] && typeof bot.recipesFor === "function") {
      let table: any = null;
      try {
        table = bot.findBlock({ matching: (block) => block.name === "crafting_table", maxDistance: 32 });
      } catch {
        // A missing chunk probe is not proof that crafting is impossible.
      }
      let hasRecipe = false;
      try {
        const itemId = registry.itemsByName[item].id;
        hasRecipe = !!bot.recipesFor(itemId, null, 1, table)[0] || !!bot.recipesFor(itemId, null, 1, null)[0];
      } catch {
        // Let the executor provide detailed feedback if the recipe API itself
        // is temporarily unavailable.
        hasRecipe = true;
      }
      const items = safeItems(bot);
      const canPlaceCarriedTable = items.some((entry) => entry.name === "crafting_table");
      const executorCanConvertLogs =
        items.some((entry) => entry.name.endsWith("_log")) &&
        /(?:_planks|stick|wooden_|crafting_table|chest|torch)/.test(item);
      if (!hasRecipe && !canPlaceCarriedTable && !executorCanConvertLogs) {
        return {
          ok: false,
          reason: `craft ${item} has no currently satisfiable recipe; gather its ingredients first.`,
        };
      }
    }
  }

  if (decision.action === "mine_block" && !params.blockType) {
    return { ok: false, reason: "mine_block requires one of the visible blockType values in AVAILABLE NOW." };
  }
  if (decision.action === "place_block" && !params.blockType) {
    return { ok: false, reason: "place_block requires a carried blockType from AVAILABLE NOW." };
  }
  if (decision.action === "withdraw_stash" && !params.item) {
    return { ok: false, reason: "withdraw_stash requires the exact item currently needed." };
  }
  if (decision.action === "chat" && !String(params.message || "").trim()) {
    return { ok: false, reason: "chat requires a non-empty message." };
  }
  if (decision.action === "leave_objective" && !String(params.reason || "").trim()) {
    return { ok: false, reason: "leave_objective requires a concrete reason." };
  }

  return { ok: true };
}

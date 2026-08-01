import type { Bot } from "mineflayer";
import type { OperationResult } from "../operations/types.js";
import { getSharedStructure } from "../world/registry.js";
import { routeOverallGoal } from "./goal-router.js";
import { houseBlueprint } from "../skills/blueprints/house.js";

export interface PlannedDecision {
  thought: string;
  action: string;
  params: Record<string, any>;
  goal?: string;
}

interface Objective {
  action: string;
  params: Record<string, any>;
  goal?: string;
  attempts: number;
  noProgress: number;
}

export interface PlannedStep extends PlannedDecision {
  completesObjective: boolean;
  objectiveAction: string;
}

const FOOD_PARTS = ["bread", "apple", "carrot", "potato", "beef", "porkchop", "chicken", "mutton", "salmon", "cod"];

function count(bot: Bot, predicate: (name: string) => boolean): number {
  return bot.inventory
    .items()
    .filter((item) => predicate(item.name))
    .reduce((total, item) => total + item.count, 0);
}

function countNamed(bot: Bot, name: string): number {
  if (/^([a-z]+_)?logs?$|^wood$/.test(name) || name.endsWith("_log")) {
    return count(bot, (itemName) => itemName.endsWith("_log"));
  }
  if (/^([a-z]+_)?planks?$/.test(name) || name.endsWith("_planks")) {
    return count(bot, (itemName) => itemName.endsWith("_planks"));
  }
  return count(bot, (itemName) => itemName === name);
}

function woodEquivalent(bot: Bot): number {
  return count(bot, (name) => name.endsWith("_log")) * 4 + count(bot, (name) => name.endsWith("_planks"));
}

function reserveBlocks(bot: Bot): number {
  return count(bot, (name) => name.endsWith("_planks") || ["dirt", "cobblestone", "stone"].includes(name));
}

function carriedFood(bot: Bot): number {
  return count(bot, (name) => FOOD_PARTS.some((part) => name.includes(part)));
}

function firstLog(bot: Bot): string | undefined {
  return bot.inventory.items().find((item) => item.name.endsWith("_log"))?.name;
}

function stashCount(itemName: string): number {
  const items = getSharedStructure("shared-stash")?.evidence?.items;
  if (!Array.isArray(items)) return 0;
  return items.reduce((total, entry) => {
    if (!entry || typeof entry !== "object") return total;
    const name = String((entry as { name?: unknown }).name ?? "");
    const amount = Number((entry as { count?: unknown }).count ?? 0);
    if (itemName.endsWith("_log") || itemName === "log" || itemName === "logs") {
      return total + (name.endsWith("_log") ? amount : 0);
    }
    if (itemName.endsWith("_planks") || itemName === "plank" || itemName === "planks") {
      return total + (name.endsWith("_planks") ? amount : 0);
    }
    return total + (name === itemName ? amount : 0);
  }, 0);
}

function step(
  objective: Objective,
  action: string,
  params: Record<string, any>,
  reason: string,
  completesObjective = false,
): PlannedStep {
  return {
    thought: `[plan] ${reason}`,
    action,
    params,
    goal: objective.goal,
    completesObjective,
    objectiveAction: objective.action,
  };
}

const HOUSE_PLANK_TARGET =
  Object.entries(houseBlueprint.materials)
    .filter(([name]) => name.endsWith("_planks"))
    .reduce((total, [, amount]) => total + amount, 0) + 14;

function firstPlank(bot: Bot): string | undefined {
  return bot.inventory.items().find((item) => item.name.endsWith("_planks"))?.name;
}

function canonicalCraftItem(item: string, bot: Bot): string {
  if (["plank", "planks", "wooden_planks", "wood_planks"].includes(item)) {
    return firstLog(bot)?.replace("_log", "_planks") ?? firstPlank(bot) ?? "oak_planks";
  }
  if (item === "sticks") return "stick";
  return item;
}

interface RecipeDependency {
  inputs: Record<string, number>;
  yields: number;
  table?: boolean;
}

const RECIPE_DEPENDENCIES: Record<string, RecipeDependency> = {
  stick: { inputs: { planks: 2 }, yields: 4 },
  crafting_table: { inputs: { planks: 4 }, yields: 1 },
  chest: { inputs: { planks: 8 }, yields: 1, table: true },
  torch: { inputs: { stick: 1, coal: 1 }, yields: 4 },
  wooden_hoe: { inputs: { planks: 2, stick: 2 }, yields: 1, table: true },
  wooden_pickaxe: { inputs: { planks: 3, stick: 2 }, yields: 1, table: true },
  wooden_axe: { inputs: { planks: 3, stick: 2 }, yields: 1, table: true },
  wooden_shovel: { inputs: { planks: 1, stick: 2 }, yields: 1, table: true },
  wooden_sword: { inputs: { planks: 2, stick: 1 }, yields: 1, table: true },
  furnace: { inputs: { cobblestone: 8 }, yields: 1, table: true },
  stone_pickaxe: { inputs: { cobblestone: 3, stick: 2 }, yields: 1, table: true },
  iron_pickaxe: { inputs: { iron_ingot: 3, stick: 2 }, yields: 1, table: true },
  fishing_rod: { inputs: { stick: 3, string: 2 }, yields: 1, table: true },
  white_bed: { inputs: { planks: 3, white_wool: 3 }, yields: 1, table: true },
  oak_door: { inputs: { planks: 6 }, yields: 3, table: true },
};

function hasCraftingTable(bot: Bot): boolean {
  return (
    countNamed(bot, "crafting_table") > 0 ||
    !!bot.findBlock?.({ matching: (block: any) => block.name === "crafting_table", maxDistance: 32 })
  );
}

function woodCost(item: string, amount: number, bot: Bot): number {
  const canonical = canonicalCraftItem(item, bot);
  if (countNamed(bot, canonical) >= amount) return 0;
  if (canonical.endsWith("_planks") || canonical === "planks") return amount;
  const recipe = RECIPE_DEPENDENCIES[canonical];
  if (!recipe) return 0;
  const crafts = Math.ceil((amount - countNamed(bot, canonical)) / recipe.yields);
  let total = Object.entries(recipe.inputs).reduce(
    (sum, [input, count]) => sum + woodCost(input, count * crafts, bot),
    0,
  );
  if (recipe.table && !hasCraftingTable(bot)) total += woodCost("crafting_table", 1, bot);
  return total;
}

function objectiveRequirements(objective: Objective): Record<string, number> {
  switch (objective.action) {
    case "craft":
      return {
        [String(objective.params.item ?? "")]: Math.max(1, Number(objective.params.count) || 1),
      };
    case "build_farm":
      return { wooden_hoe: 1 };
    case "setup_stash":
      return { chest: 2 };
    case "build_house":
      return { ...houseBlueprint.materials };
    case "build_bridge":
      return { planks: 3 };
    case "light_area":
      return { torch: 16 };
    case "craft_gear":
      return { wooden_pickaxe: 1, wooden_axe: 1, wooden_shovel: 1, wooden_sword: 1 };
    case "strip_mine":
      return { wooden_pickaxe: 1, torch: 4, planks: 8 };
    case "go_fishing":
      return { fishing_rod: 1 };
    case "smelt_ores":
      return { furnace: 1, coal: 1 };
    case "place_block":
      return { [String(objective.params.blockType ?? objective.params.item ?? "oak_planks")]: 1 };
    case "mine_block": {
      const block = String(objective.params.blockType ?? "");
      if (/(diamond|redstone|gold)_ore/.test(block)) return { iron_pickaxe: 1 };
      if (/(iron|copper)_ore/.test(block)) return { stone_pickaxe: 1 };
      if (/(stone|coal_ore)/.test(block)) return { wooden_pickaxe: 1 };
      return {};
    }
    case "sleep":
    case "sleep_in_bed":
    case "use_bed":
      return { white_bed: 1 };
    default:
      return {};
  }
}

function materialStep(objective: Objective, bot: Bot, item: string, amount: number): PlannedStep | null {
  const canonical = canonicalCraftItem(item, bot);
  const have = countNamed(bot, canonical);
  if (have >= amount) return null;

  if (canonical.endsWith("_planks")) {
    const log = firstLog(bot);
    if (!log) {
      return step(
        objective,
        "gather_wood",
        { count: Math.max(1, Math.ceil((amount - have) / 4)) },
        "planks require logs; harvest and verify complete trees",
      );
    }
    return step(
      objective,
      "craft",
      { item: log.replace("_log", "_planks"), count: amount - have },
      "convert verified logs into planks",
    );
  }

  const recipe = RECIPE_DEPENDENCIES[canonical];
  if (recipe) {
    if (recipe.table && !hasCraftingTable(bot)) {
      const tableStep = materialStep(objective, bot, "crafting_table", 1);
      if (tableStep) return tableStep;
      return step(objective, "place_block", { blockType: "crafting_table" }, "place the required crafting table");
    }
    const crafts = Math.ceil((amount - have) / recipe.yields);
    for (const [input, perCraft] of Object.entries(recipe.inputs)) {
      const dependency = materialStep(objective, bot, input, perCraft * crafts);
      if (dependency) return dependency;
    }
    return step(objective, "craft", { item: canonical, count: amount - have }, `craft required ${canonical}`);
  }

  const mineSource: Record<string, string> = {
    coal: "coal_ore",
    cobblestone: "stone",
    iron_ingot: "iron_ore",
    string: "cobweb",
    white_wool: "white_wool",
  };
  if (mineSource[canonical]) {
    const toolForRaw: Record<string, string> = {
      coal: "wooden_pickaxe",
      cobblestone: "wooden_pickaxe",
      iron_ingot: "stone_pickaxe",
    };
    const tool = toolForRaw[canonical];
    if (tool && countNamed(bot, tool) < 1) {
      const toolStep = materialStep(objective, bot, tool, 1);
      if (toolStep) return toolStep;
    }
    return step(
      objective,
      "mine_block",
      { blockType: mineSource[canonical], count: amount - have },
      `acquire required ${canonical}`,
    );
  }
  return null;
}

/**
 * A persistent, state-driven prerequisite planner. The LLM may choose the root
 * objective, but it never chooses recipe leaves or retries. Each call derives
 * the next executable step from current verified state.
 */
export class ObjectivePlanner {
  private queue: Objective[] = [];
  private inFlight: PlannedStep | null = null;

  hasWork(): boolean {
    return this.queue.length > 0;
  }

  hasInFlight(): boolean {
    return this.inFlight !== null;
  }

  enqueue(decision: PlannedDecision, front = false): void {
    const routed =
      decision.action === "pursue_goal"
        ? routeOverallGoal(decision.goal ?? decision.thought)
        : { action: decision.action, params: decision.params ?? {} };
    const objective: Objective = {
      action: routed.action,
      params: { ...routed.params },
      goal: decision.goal,
      attempts: 0,
      noProgress: 0,
    };
    if (front) this.queue.unshift(objective);
    else this.queue.push(objective);
  }

  ensureBootstrapStash(): void {
    const stash = getSharedStructure("shared-stash");
    const alreadyQueued = this.queue.some((objective) => objective.action === "setup_stash");
    if (stash?.status !== "verified" && !alreadyQueued) {
      this.enqueue(
        {
          thought: "[plan] establish canonical shared storage",
          action: "setup_stash",
          params: {},
          goal: "Establish and verify the canonical shared stash",
        },
        true,
      );
    }
  }

  next(bot: Bot): PlannedStep | null {
    if (this.inFlight) return null;
    while (this.queue.length > 0) {
      const objective = this.queue[0];

      const requirements = objectiveRequirements(objective);
      const woodNeeded = Object.entries(requirements).reduce(
        (total, [item, amount]) => total + woodCost(item, amount, bot),
        0,
      );
      if (woodEquivalent(bot) < woodNeeded) {
        this.inFlight = step(
          objective,
          "gather_wood",
          { count: Math.ceil((woodNeeded - woodEquivalent(bot)) / 4) },
          "gather the complete wood budget for the whole dependency tree",
        );
        return this.inFlight;
      }
      for (const [item, amount] of Object.entries(requirements)) {
        const dependency = materialStep(objective, bot, item, amount);
        if (dependency) {
          if (
            objective.action === "craft" &&
            dependency.action === "craft" &&
            canonicalCraftItem(String(dependency.params.item), bot) === canonicalCraftItem(item, bot)
          )
            dependency.completesObjective = true;
          this.inFlight = dependency;
          return this.inFlight;
        }
      }

      // The dependency tree is itself the objective for craft_gear. Once all
      // required tools are present, invoking the skill again can only produce
      // the contradictory "Missing: none" failure that used to trap the
      // planner in a retry/blacklist loop.
      if (objective.action === "craft_gear" && Object.keys(requirements).length > 0) {
        this.queue.shift();
        continue;
      }

      if (objective.action === "craft") {
        const item = canonicalCraftItem(String(objective.params.item ?? ""), bot);
        const wanted = Math.max(1, Number(objective.params.count) || 1);
        objective.params.item = item;
        if (countNamed(bot, item) >= wanted) {
          this.queue.shift();
          continue;
        }
        const dependency = materialStep(objective, bot, item, wanted);
        if (dependency) {
          dependency.completesObjective = dependency.action === "craft" && dependency.params.item === item;
          this.inFlight = dependency;
          return this.inFlight;
        }
      }

      if (objective.action === "build_farm") {
        const hasHoe = bot.inventory.items().some((item) => item.name.endsWith("_hoe"));
        if (!hasHoe) {
          const dependency = materialStep(objective, bot, "wooden_hoe", 1);
          if (dependency) {
            this.inFlight = dependency;
            return this.inFlight;
          }
        }
        this.inFlight = step(
          objective,
          "build_farm",
          objective.params,
          "tool chain verified; establish and plant the farm",
          true,
        );
        return this.inFlight;
      }

      if (objective.action === "build_bridge" && reserveBlocks(bot) < 3) {
        const dependency = materialStep(objective, bot, "planks", 3);
        if (dependency) {
          this.inFlight = dependency;
          return this.inFlight;
        }
      }

      if (objective.action === "light_area" && countNamed(bot, "torch") < 16) {
        const dependency = materialStep(objective, bot, "torch", 16);
        if (dependency) {
          this.inFlight = dependency;
          return this.inFlight;
        }
      }

      if (objective.action === "craft_gear" && !bot.inventory.items().some((item) => item.name.endsWith("_pickaxe"))) {
        const dependency = materialStep(objective, bot, "wooden_pickaxe", 1);
        if (dependency) {
          this.inFlight = dependency;
          return this.inFlight;
        }
      }

      if (objective.action === "setup_stash") {
        if (getSharedStructure("shared-stash")?.status === "verified") {
          this.queue.shift();
          continue;
        }
        // Two chests cost 16 planks and a new crafting table costs four more.
        const chestsHeld = countNamed(bot, "chest");
        const deficit = chestsHeld >= 2 ? 0 : Math.max(0, 20 - woodEquivalent(bot));
        if (deficit > 0) {
          this.inFlight = step(
            objective,
            "gather_wood",
            { count: Math.max(2, Math.ceil(deficit / 4)) },
            "stash needs chest materials; harvest complete trees first",
          );
          return this.inFlight;
        }
        this.inFlight = step(
          objective,
          "setup_stash",
          objective.params,
          "materials ready; build and verify storage",
          true,
        );
        return this.inFlight;
      }

      if (objective.action === "withdraw_stash") {
        const item = String(objective.params.item ?? "");
        const wanted = Math.max(1, Number(objective.params.count) || 1);
        if (item && countNamed(bot, item) >= wanted) {
          this.queue.shift();
          continue;
        }
        if (getSharedStructure("shared-stash")?.status !== "verified") {
          this.enqueue({ thought: "", action: "setup_stash", params: {} }, true);
          continue;
        }
        const deficit = Math.max(1, wanted - countNamed(bot, item));
        if (stashCount(item) < deficit) {
          if (item.endsWith("_log") || item === "log" || item === "logs") {
            this.inFlight = step(
              objective,
              "gather_wood",
              { count: deficit },
              "stash has no logs; harvest full trees locally",
            );
            return this.inFlight;
          }
          if (item.endsWith("_planks") || item === "plank" || item === "planks") {
            const log = firstLog(bot);
            if (!log) {
              this.inFlight = step(
                objective,
                "gather_wood",
                { count: Math.max(1, Math.ceil(deficit / 4)) },
                "stash has no planks; gather wood first",
              );
              return this.inFlight;
            }
            this.inFlight = step(
              objective,
              "craft",
              { item: log.replace("_log", "_planks"), count: deficit },
              "convert gathered logs into required planks",
            );
            return this.inFlight;
          }
          if (item === "stick") {
            if (count(bot, (name) => name.endsWith("_planks")) < 2) {
              this.inFlight = step(
                objective,
                "gather_wood",
                { count: 1 },
                "sticks require planks, so gather wood first",
              );
              return this.inFlight;
            }
            this.inFlight = step(objective, "craft", { item: "stick", count: deficit }, "craft missing sticks locally");
            return this.inFlight;
          }
          if (item.endsWith("_pickaxe") || item.endsWith("_axe") || item.endsWith("_shovel")) {
            this.inFlight = step(
              objective,
              "craft_gear",
              {},
              "stash lacks the requested tool; execute its material chain",
            );
            return this.inFlight;
          }
          const blockType = item === "coal" ? "coal_ore" : item === "cobblestone" ? "stone" : item;
          if (["coal_ore", "stone", "iron_ore", "copper_ore", "diamond_ore"].includes(blockType)) {
            this.inFlight = step(
              objective,
              "mine_block",
              { blockType, count: deficit },
              "stash lacks the resource; mine it locally",
            );
            return this.inFlight;
          }
          this.inFlight = step(objective, "explore", {}, `stash lacks ${item}; search for its world source`);
          return this.inFlight;
        }
        this.inFlight = step(
          objective,
          objective.action,
          objective.params,
          "verified storage exists; perform withdrawal",
          true,
        );
        return this.inFlight;
      }

      if (objective.action === "deposit_stash") {
        if (getSharedStructure("shared-stash")?.status !== "verified") {
          this.enqueue({ thought: "", action: "setup_stash", params: {} }, true);
          continue;
        }
        this.inFlight = step(
          objective,
          objective.action,
          objective.params,
          "verified storage exists; perform deposit",
          true,
        );
        return this.inFlight;
      }

      if (objective.action === "strip_mine") {
        const hasPickaxe = bot.inventory.items().some((item) => item.name.endsWith("_pickaxe"));
        if (!hasPickaxe) {
          this.inFlight = step(objective, "craft_gear", {}, "mining requires a pickaxe; build the tool chain");
          return this.inFlight;
        }
        const torches = countNamed(bot, "torch");
        if (torches < 4) {
          if (countNamed(bot, "coal") < 1) {
            this.inFlight = step(objective, "mine_block", { blockType: "coal_ore" }, "torches require coal");
            return this.inFlight;
          }
          if (countNamed(bot, "stick") < 1) {
            if (count(bot, (name) => name.endsWith("_planks")) < 2) {
              const log = firstLog(bot);
              if (!log) {
                this.inFlight = step(
                  objective,
                  "gather_wood",
                  { count: 2 },
                  "torches require sticks, sticks require wood",
                );
                return this.inFlight;
              }
              this.inFlight = step(
                objective,
                "craft",
                { item: log.replace("_log", "_planks"), count: 4 },
                "turn carried logs into planks",
              );
              return this.inFlight;
            }
            this.inFlight = step(objective, "craft", { item: "stick", count: 4 }, "turn planks into sticks");
            return this.inFlight;
          }
          this.inFlight = step(objective, "craft", { item: "torch", count: 4 }, "craft the required torch reserve");
          return this.inFlight;
        }
        if (reserveBlocks(bot) < 8) {
          const log = firstLog(bot);
          if (!log) {
            this.inFlight = step(objective, "gather_wood", { count: 2 }, "mine recovery requires eight reserve blocks");
            return this.inFlight;
          }
          this.inFlight = step(
            objective,
            "craft",
            { item: log.replace("_log", "_planks"), count: 8 },
            "craft reserve blocks for a safe return route",
          );
          return this.inFlight;
        }
        if (bot.food < 12 && carriedFood(bot) < 2) {
          this.inFlight = step(objective, "attack", {}, "mining expedition needs a food reserve");
          return this.inFlight;
        }
        this.inFlight = step(objective, objective.action, objective.params, "all mining preconditions verified", true);
        return this.inFlight;
      }

      this.inFlight = step(
        objective,
        objective.action,
        objective.params,
        "execute the selected high-level objective",
        true,
      );
      return this.inFlight;
    }
    return null;
  }

  record(result: OperationResult): void {
    const activeStep = this.inFlight;
    this.inFlight = null;
    if (!activeStep || this.queue.length === 0) return;
    const objective = this.queue[0];
    objective.attempts++;

    if (activeStep.completesObjective && result.status === "succeeded") {
      this.queue.shift();
      return;
    }

    // Preserve the root objective, but do useful movement while a transient
    // blacklist cools down instead of selecting the same blocked leaf again.
    if (result.code === "PLANNER_STEP_BLOCKED" && activeStep.action !== "explore") {
      this.queue.unshift({
        action: "explore",
        params: { direction: ["north", "east", "south", "west"][objective.attempts % 4] },
        attempts: 0,
        noProgress: 0,
      });
      return;
    }

    if (result.worldChanged || result.status === "succeeded" || result.status === "partial") {
      objective.noProgress = 0;
    } else {
      objective.noProgress++;
    }

    // Never spin forever on an unchanged leaf. Preserve the root objective but
    // insert one deterministic scouting move before recomputing prerequisites.
    if (objective.noProgress >= 3 && activeStep.action !== "explore") {
      objective.noProgress = 0;
      this.queue.unshift({
        action: "explore",
        params: { direction: ["north", "east", "south", "west"][objective.attempts % 4] },
        attempts: 0,
        noProgress: 0,
      });
    } else if (activeStep.completesObjective && !result.retryable) {
      this.queue.shift();
    }
  }

  clear(): void {
    this.queue.length = 0;
    this.inFlight = null;
  }
}

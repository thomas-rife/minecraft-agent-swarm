import type { Bot } from "mineflayer";
import type { OperationResult } from "../operations/types.js";
import { getSharedStructure } from "../world/registry.js";

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
    completesObjective,
    objectiveAction: objective.action,
  };
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

  enqueue(decision: PlannedDecision, front = false): void {
    const objective: Objective = {
      action: decision.action,
      params: { ...(decision.params ?? {}) },
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

      if (objective.action === "setup_stash") {
        if (getSharedStructure("shared-stash")?.status === "verified") {
          this.queue.shift();
          continue;
        }
        // Two chests cost 16 planks and a new crafting table costs four more.
        const deficit = Math.max(0, 20 - woodEquivalent(bot));
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

import type { Bot } from "mineflayer";
import type { PostconditionResult } from "../operations/types.js";

export function inventoryCount(bot: Bot, matcher: string | ((name: string) => boolean)): number {
  const matches = typeof matcher === "string" ? (name: string) => name === matcher || name.includes(matcher) : matcher;
  return bot.inventory
    .items()
    .filter((item) => matches(item.name))
    .reduce((sum, item) => sum + item.count, 0);
}

export function verifyInventoryIncrease(before: number, after: number, minimum = 1): PostconditionResult {
  return {
    name: "inventory_increased",
    satisfied: after - before >= minimum,
    evidence: { before, after, delta: after - before, minimum },
  };
}

export function verifyInventoryDecrease(before: number, after: number, minimum = 1): PostconditionResult {
  return {
    name: "inventory_decreased",
    satisfied: before - after >= minimum,
    evidence: { before, after, delta: before - after, minimum },
  };
}


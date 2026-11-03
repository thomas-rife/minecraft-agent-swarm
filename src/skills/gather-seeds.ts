import type { Bot } from "mineflayer";
import pkg from "mineflayer-pathfinder";
import { collectNearbyDrops, safeGoto } from "../bot/navigation.js";
import type { Skill, SkillResult } from "./types.js";

const { goals, Movements } = pkg;

function seedCount(bot: Bot): number {
  return bot.inventory
    .items()
    .filter((item) => item.name === "wheat_seeds")
    .reduce((total, item) => total + item.count, 0);
}

/**
 * One narrow farm-phase skill: acquire seeds without also selecting a site,
 * building a farm, or changing the strategic objective.
 */
export const gatherSeedsSkill: Skill = {
  name: "gather_seeds",
  description: "Break nearby short/tall grass and collect wheat seeds for a selected farming project.",
  params: {
    count: { type: "number", description: "Desired total wheat seeds (default 8)." },
  },

  estimateMaterials() {
    return {};
  },

  async execute(bot, params, signal, onProgress): Promise<SkillResult> {
    const target = Math.max(1, Math.min(Number(params?.count) || 8, 32));
    const initial = seedCount(bot);
    if (initial >= target) {
      return { success: true, message: `Seed supply already ready (${initial}/${target}).`, stats: { seeds: initial } };
    }

    const movements = new Movements(bot);
    movements.canDig = false;
    movements.allow1by1towers = false;
    bot.pathfinder.setMovements(movements);

    const tried = new Set<string>();
    const startedAt = Date.now();
    let current = initial;

    while (!signal.aborted && current < target && Date.now() - startedAt < 60_000) {
      const positions = bot.findBlocks({
        matching: (block) => block.name === "short_grass" || block.name === "tall_grass",
        maxDistance: 48,
        count: 96,
      });
      const position = positions.find((candidate) => !tried.has(candidate.toString()));
      if (!position) break;
      tried.add(position.toString());

      const grass = bot.blockAt(position);
      if (!grass) continue;
      try {
        await safeGoto(bot, new goals.GoalNear(position.x, position.y, position.z, 2), 8_000);
        await Promise.race([
          bot.dig(grass),
          new Promise<void>((_, reject) => setTimeout(() => reject(new Error("dig timeout")), 8_000)),
        ]);
        await collectNearbyDrops(bot, 5, 3_000);
      } catch {
        continue;
      }

      current = seedCount(bot);
      onProgress({
        skillName: "gather_seeds",
        phase: "Collecting seeds",
        progress: Math.min(0.95, current / target),
        message: `Collected ${current}/${target} wheat seeds`,
        active: true,
      });
    }

    current = seedCount(bot);
    if (current <= initial) {
      return {
        success: false,
        message: "No wheat seeds collected here. The selected farm-supply branch needs a grassy area.",
      };
    }
    return {
      success: current >= target,
      message:
        current >= target
          ? `Farm seed supply ready: ${current}/${target} wheat seeds.`
          : `Collected ${current}/${target} wheat seeds before nearby grass ran out.`,
      stats: { seedsCollected: current - initial, seeds: current },
    };
  },
};

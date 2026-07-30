import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { PostconditionResult } from "../operations/types.js";

export function verifyAtPosition(
  bot: Bot,
  target: { x: number; y: number; z: number },
  tolerance: number,
  start?: Vec3,
): PostconditionResult[] {
  const final = bot.entity.position.clone();
  const distance = final.distanceTo(new Vec3(target.x, target.y, target.z));
  const displacement = start ? final.distanceTo(start) : undefined;
  return [
    { name: "within_target_tolerance", satisfied: distance <= tolerance, evidence: { distance, tolerance, final } },
    {
      name: "meaningful_displacement",
      satisfied: start ? displacement! >= Math.min(1, start.distanceTo(new Vec3(target.x, target.y, target.z))) : true,
      evidence: { displacement },
    },
  ];
}

export function waterState(bot: Bot): { feetInWater: boolean; headInWater: boolean; dry: boolean } {
  const pos = bot.entity.position;
  const feetInWater = bot.blockAt(pos)?.name === "water";
  const headInWater = bot.blockAt(pos.offset(0, 1, 0))?.name === "water";
  return { feetInWater, headInWater, dry: !feetInWater && !headInWater };
}

export async function verifyDryStable(bot: Bot, checks = 3, intervalMs = 250): Promise<PostconditionResult> {
  const observations: Array<{ feetInWater: boolean; headInWater: boolean }> = [];
  for (let i = 0; i < checks; i++) {
    const state = waterState(bot);
    observations.push({ feetInWater: state.feetInWater, headInWater: state.headInWater });
    if (!state.dry) return { name: "dry_stability_window", satisfied: false, evidence: observations };
    if (i < checks - 1) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return { name: "dry_stability_window", satisfied: true, evidence: observations };
}

export function verifyBlockAt(bot: Bot, position: Vec3, expectedNames: string[]): PostconditionResult {
  const actual = bot.blockAt(position)?.name ?? null;
  return {
    name: "expected_block_present",
    satisfied: actual !== null && expectedNames.includes(actual),
    evidence: { position, expectedNames, actual },
  };
}


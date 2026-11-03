import type { Blueprint, BlueprintBlock } from "../types.js";

export function finishBlueprint(
  name: string,
  dimensions: Blueprint["dimensions"],
  blocks: BlueprintBlock[],
  entrance: Blueprint["entrance"],
): Blueprint {
  const materials: Record<string, number> = {};
  for (const block of blocks) materials[block.block] = (materials[block.block] ?? 0) + 1;
  return { name, dimensions, blocks, entrance, materials };
}

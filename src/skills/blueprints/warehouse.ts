import type { Blueprint, BlueprintBlock } from "../types.js";
import { finishBlueprint } from "./helpers.js";

/** Compact 9x7 warehouse: enough storage to be useful without exceeding one skill run. */
function generateWarehouse(): Blueprint {
  const blocks: BlueprintBlock[] = [];
  const width = 9;
  const depth = 7;

  for (let x = 0; x < width; x++) {
    for (let z = 0; z < depth; z++) {
      blocks.push({ pos: [x, 0, z], block: "oak_planks", phase: "structure" });
      blocks.push({ pos: [x, 3, z], block: "oak_planks", phase: "structure" });
    }
  }

  for (let y = 1; y <= 2; y++) {
    for (let x = 0; x < width; x++) {
      for (let z = 0; z < depth; z++) {
        if (x !== 0 && x !== width - 1 && z !== 0 && z !== depth - 1) continue;
        if (z === 0 && x === 4 && (y === 1 || y === 2)) continue;
        // Open side windows at head height.
        if (y === 2 && (x === 0 || x === width - 1) && (z === 2 || z === 4)) continue;
        blocks.push({ pos: [x, y, z], block: "oak_planks", phase: "structure" });
      }
    }
  }

  blocks.push({ pos: [4, 1, 0], block: "oak_door", phase: "interior" });
  for (const [x, z] of [
    [1, 2],
    [1, 3],
    [1, 5],
    [7, 2],
    [7, 3],
    [7, 5],
  ] as const) {
    blocks.push({ pos: [x, 1, z], block: "chest", phase: "interior" });
  }
  blocks.push({ pos: [4, 1, 5], block: "crafting_table", phase: "interior" });
  for (const [x, z] of [
    [2, 1],
    [6, 1],
    [2, 5],
    [6, 5],
  ] as const) {
    blocks.push({ pos: [x, 2, z], block: "torch", phase: "interior" });
  }

  return finishBlueprint("Settlement Warehouse", [width, 4, depth], blocks, { pos: [4, 1, -1], facing: "south" });
}

export const warehouseBlueprint = generateWarehouse();

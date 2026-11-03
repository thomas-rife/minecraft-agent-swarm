import type { Blueprint, BlueprintBlock } from "../types.js";
import { finishBlueprint } from "./helpers.js";

/** 7x7 workshop with a furnace bank, work tables, storage, and lighting. */
function generateWorkshop(): Blueprint {
  const blocks: BlueprintBlock[] = [];
  const size = 7;

  for (let x = 0; x < size; x++) {
    for (let z = 0; z < size; z++) {
      blocks.push({ pos: [x, 0, z], block: "cobblestone", phase: "structure" });
      blocks.push({ pos: [x, 3, z], block: "oak_planks", phase: "structure" });
    }
  }

  for (let y = 1; y <= 2; y++) {
    for (let x = 0; x < size; x++) {
      for (let z = 0; z < size; z++) {
        if (x !== 0 && x !== size - 1 && z !== 0 && z !== size - 1) continue;
        if (z === 0 && x === 3 && (y === 1 || y === 2)) continue;
        if (y === 2 && (x === 0 || x === size - 1) && z === 3) continue;
        blocks.push({ pos: [x, y, z], block: "oak_planks", phase: "structure" });
      }
    }
  }

  blocks.push({ pos: [3, 1, 0], block: "oak_door", phase: "interior" });
  for (const x of [1, 2, 4, 5]) {
    blocks.push({ pos: [x, 1, 5], block: "furnace", phase: "interior" });
  }
  blocks.push({ pos: [1, 1, 1], block: "crafting_table", phase: "interior" });
  blocks.push({ pos: [5, 1, 1], block: "crafting_table", phase: "interior" });
  blocks.push({ pos: [1, 1, 3], block: "chest", phase: "interior" });
  blocks.push({ pos: [5, 1, 3], block: "chest", phase: "interior" });
  for (const [x, z] of [
    [2, 1],
    [4, 1],
    [2, 5],
    [4, 5],
  ] as const) {
    blocks.push({ pos: [x, 2, z], block: "torch", phase: "interior" });
  }

  return finishBlueprint("Settlement Workshop", [size, 4, size], blocks, {
    pos: [3, 1, -1],
    facing: "south",
  });
}

export const workshopBlueprint = generateWorkshop();

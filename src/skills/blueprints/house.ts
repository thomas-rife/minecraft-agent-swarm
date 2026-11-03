import type { Blueprint, BlueprintBlock } from "../types.js";
import { finishBlueprint } from "./helpers.js";

/**
 * 9x9 starter lodge.
 *
 * The footprint is intentionally large enough to read as the team's main
 * shared base while remaining realistic for an early settlement. Construction
 * is resumable; a larger great hall can be a later progression objective.
 *
 * Y=0: full floor
 * Y=1-3: perimeter walls with a centered south-facing door and windows
 * Y=4: full flat roof
 */
function generate(): Blueprint {
  const blocks: BlueprintBlock[] = [];
  const size = 9;
  const wallTop = 3;
  const doorX = 4;
  const windowOffsets = new Set([2, 4, 6]);

  for (let x = 0; x < size; x++) {
    for (let z = 0; z < size; z++) {
      blocks.push({ pos: [x, 0, z], block: "oak_planks", phase: "structure" });
    }
  }

  for (let y = 1; y <= wallTop; y++) {
    for (let x = 0; x < size; x++) {
      for (let z = 0; z < size; z++) {
        const perimeter = x === 0 || x === size - 1 || z === 0 || z === size - 1;
        if (!perimeter) continue;

        // The entrance faces +Z, toward the settlement anchor/stash.
        if (z === size - 1 && x === doorX && (y === 1 || y === 2)) continue;

        // Open head-height windows on all four sides. Glass can be added as a
        // later decoration objective without blocking shelter completion.
        const window =
          y === 2 &&
          (((z === 0 || z === size - 1) && windowOffsets.has(x)) ||
            ((x === 0 || x === size - 1) && windowOffsets.has(z)));
        if (window) continue;

        blocks.push({ pos: [x, y, z], block: "oak_planks", phase: "structure" });
      }
    }
  }

  for (let x = 0; x < size; x++) {
    for (let z = 0; z < size; z++) {
      blocks.push({ pos: [x, wallTop + 1, z], block: "oak_planks", phase: "structure" });
    }
  }

  blocks.push({ pos: [2, 1, 2], block: "crafting_table", phase: "interior" });
  blocks.push({ pos: [doorX, 1, size - 1], block: "oak_door", phase: "interior" });

  // Interior wall lights. These remain best-effort if coal is unavailable.
  for (const [x, y, z] of [
    [2, 2, 1],
    [6, 2, 1],
    [2, 2, size - 2],
    [6, 2, size - 2],
  ] as const) {
    blocks.push({ pos: [x, y, z], block: "torch", phase: "interior" });
  }

  return finishBlueprint("Settlement Starter Lodge", [size, wallTop + 2, size], blocks, {
    pos: [doorX, 1, size],
    facing: "south",
  });
}

export const houseBlueprint = generate();

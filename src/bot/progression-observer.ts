import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { getAllMemoryStores, getRegisteredBots } from "./memory-registry.js";
import { blockMatchesBlueprint } from "../skills/build-house.js";
import { decodeShelterDesign, shelterBlueprint } from "../skills/shelter-design.js";
import { SETTLEMENT_STRUCTURE_RADIUS } from "./role.js";
import { getStashSummary } from "../skills/stash-ledger.js";
import type { ProgressionObservations } from "./progression-runtime.js";

/** Demo verification for existing builders. Unknown chunks never count. */
export function observeProgression(bot: Bot, anchor: { x: number; y: number; z: number }): ProgressionObservations {
  const bots = getRegisteredBots().filter((member) => member.entity && member.health > 0);
  if (!bots.includes(bot)) bots.push(bot);
  const inventories = bots.map((member) => member.inventory.items());
  const items = inventories.flat();
  const count = (predicate: (name: string) => boolean) =>
    items.filter((item) => predicate(item.name)).reduce((sum, item) => sum + item.count, 0);
  const rank = (name: string) =>
    ({ wooden: 1, golden: 1, stone: 2, iron: 3, diamond: 4, netherite: 5 })[name.split("_")[0] as "wooden"] ?? 0;
  const nearBase = (position: { x: number; z: number }) =>
    Math.hypot(position.x - anchor.x, position.z - anchor.z) <= SETTLEMENT_STRUCTURE_RADIUS;
  const structures = getAllMemoryStores()
    .flatMap((store) => [...store.getStructures()])
    .filter(nearBase);
  const find = (name: string, settlementOnly = true) =>
    bots.some(
      (member) =>
        !!member.findBlock({
          matching: (block) => block?.name === name,
          useExtraInfo: (block) => !!block?.position && (!settlementOnly || nearBase(block.position)),
          maxDistance: 48,
        }),
    );
  const houses = structures.filter((structure) => structure.type === "house");
  const verified = houses
    .map((house) => ({ house, design: decodeShelterDesign(house.notes) }))
    .find(({ house, design }) => {
      if (!design) return false;
      const blueprint = shelterBlueprint(design);
      return bots.some((member) =>
        blueprint.blocks
        .filter((block) => block.block !== "torch")
        .every((block) => blockMatchesBlueprint(member, new Vec3(house.x, house.y, house.z), block)),
      );
    });
  const verifiedHouse = verified?.house;
  const verifiedDesign = verified?.design;
  const clearInterior =
    verifiedHouse && verifiedDesign &&
    bots.some((member) => {
      const entrance = shelterBlueprint(verifiedDesign).entrance.pos;
      for (const y of [1, 2]) {
        const entranceBlock = member.blockAt(
          new Vec3(verifiedHouse.x + entrance[0], verifiedHouse.y + y, verifiedHouse.z + entrance[2]),
        );
        if (!entranceBlock || entranceBlock.name !== "air") return false;
      }
      for (let x = 1; x < verifiedDesign.width - 1; x++)
        for (let z = 1; z < verifiedDesign.depth - 1; z++) {
          for (const y of [1, 2]) {
            const block = member.blockAt(new Vec3(verifiedHouse.x + x, verifiedHouse.y + y, verifiedHouse.z + z));
            if (
              !block ||
              !(
                block.name === "air" ||
                block.name === "torch" ||
                block.name === "wall_torch" ||
                block.name === "crafting_table"
              )
            )
              return false;
          }
        }
      return true;
    });
  const history = getAllMemoryStores().flatMap((store) => store.getSkillHistory());
  const plantedFarm =
    structures.some((structure) => structure.type === "farm" && !/partial/i.test(structure.notes ?? "")) &&
    bots.some(
      (member) =>
        !!member.findBlock({
          matching: (block) => block?.name === "wheat",
          useExtraInfo: (block) => !!block?.position && nearBase(block.position),
          maxDistance: 48,
        }),
    );
  return {
    logs: count((name) => name.endsWith("_log")),
    craftingStation: find("crafting_table", false),
    pickaxeRank: Math.max(0, ...items.filter((item) => item.name.endsWith("_pickaxe")).map((item) => rank(item.name))),
    shelter: !!verifiedHouse && !!clearInterior,
    expandedHouse:
      !!verifiedHouse &&
      !!clearInterior &&
      find("chest") &&
      bots.some(
        (member) =>
          !!member.findBlock({
            matching: (block) => !!block && ["torch", "wall_torch"].includes(block.name),
            useExtraInfo: (block) =>
              !!block?.position &&
              block.position.x > verifiedHouse.x &&
              block.position.x < verifiedHouse.x + (verifiedDesign?.width ?? 9) - 1 &&
              block.position.z > verifiedHouse.z &&
              block.position.z < verifiedHouse.z + (verifiedDesign?.depth ?? 9) - 1 &&
              block.position.y > verifiedHouse.y &&
              block.position.y < verifiedHouse.y + (verifiedDesign?.wallHeight ?? 3) + 1,
            maxDistance: 48,
          }),
      ),
    operatedFurnace:
      find("furnace") &&
      history.some(
        (attempt) => attempt.skill === "smelt_ores" && attempt.success && /Smelting done! Got:/i.test(attempt.notes),
      ),
    fuel: count((name) => name === "coal" || name === "charcoal"),
    renewableFood:
      plantedFarm &&
      history.some(
        (attempt) =>
          attempt.success &&
          ["maintain_farm", "build_farm"].includes(attempt.skill) &&
          /Baked [1-9]\d* bread/i.test(attempt.notes),
      ),
    sharedStorage:
      getStashSummary().totalSlots >= 54 &&
      find("chest") &&
      getAllMemoryStores().some((store) => store.getProgressionStorage().deposited) &&
      getAllMemoryStores().some((store) => store.getProgressionStorage().retrieved),
    ironProtection: inventories.some(
      (inventory) =>
        ["helmet", "chestplate", "leggings", "boots", "sword"].every((suffix) =>
          inventory.some((item) => item.name.endsWith(`_${suffix}`) && rank(item.name) >= 3),
        ) && inventory.some((item) => item.name === "shield"),
    ),
    waterBucket: count((name) => name === "water_bucket") > 0,
  };
}

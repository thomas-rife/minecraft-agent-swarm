import test from "node:test";
import assert from "node:assert/strict";
import { formatSharedWorldFacts, getSharedStructure, planSharedStructure, resetSharedWorldRegistry, verifyFarmSite } from "./registry.js";

test("configured coordinates remain planned until observed", () => {
  resetSharedWorldRegistry();
  planSharedStructure("shared-stash", "stash", { x: 1, y: 64, z: 2 });
  assert.equal(getSharedStructure("shared-stash")?.status, "planned");
  assert.match(formatSharedWorldFacts(), /is planned/);
  assert.doesNotMatch(formatSharedWorldFacts(), /is verified/);
});

test("farm verifier requires farmland, crops, irrigation, and walking space", () => {
  resetSharedWorldRegistry();
  const bot = {
    findBlocks: ({ matching }: any) => {
      const farmland = { name: "farmland" };
      const wheat = { name: "wheat" };
      const ground = { name: "grass_block" };
      return matching(farmland)
        ? Array.from({ length: 9 }, () => ({ x: 0, y: 64, z: 0 }))
        : matching(wheat)
          ? Array.from({ length: 4 }, () => ({ x: 1, y: 65, z: 0 }))
          : matching(ground)
            ? Array.from({ length: 4 }, (_, index) => ({ x: index, y: 64, z: 2 }))
            : [];
    },
    findBlock: () => ({ name: "water", position: { x: 0, y: 64, z: 0 } }),
    blockAt: () => ({ name: "air" }),
  } as any;
  const farm = verifyFarmSite(bot, "shared-farm", { x: 0, y: 64, z: 0 });
  assert.equal(farm.status, "verified");
  assert.equal((farm.evidence as any).farmland, 9);
  assert.equal((farm.evidence as any).crops, 4);
});

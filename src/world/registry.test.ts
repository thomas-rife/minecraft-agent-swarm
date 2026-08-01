import test from "node:test";
import assert from "node:assert/strict";
import {
  formatSharedWorldFacts,
  getSharedStructure,
  planSharedStructure,
  resetSharedWorldRegistry,
  upsertSharedStructure,
  verifyCanonicalStash,
  verifyFarmSite,
} from "./registry.js";

test("configured coordinates remain planned until observed", () => {
  resetSharedWorldRegistry();
  planSharedStructure("shared-stash", "stash", { x: 1, y: 64, z: 2 });
  assert.equal(getSharedStructure("shared-stash")?.status, "planned");
  assert.match(formatSharedWorldFacts(), /is planned/);
  assert.doesNotMatch(formatSharedWorldFacts(), /is verified/);
});

test("missing transitions clear stale verified evidence", () => {
  resetSharedWorldRegistry();
  upsertSharedStructure({
    id: "shared-stash",
    type: "stash",
    status: "verified",
    position: { x: 1, y: 64, z: 2 },
    provenance: "world_observation",
    verifiedAt: 123,
    evidence: { openable: true },
  });
  const missing = upsertSharedStructure({
    id: "shared-stash",
    type: "stash",
    status: "missing",
    position: { x: 1, y: 64, z: 2 },
    provenance: "world_observation",
    failureReason: "confirmed absent",
  });

  assert.equal(missing.status, "missing");
  assert.equal(missing.evidence, undefined);
  assert.equal(missing.verifiedAt, undefined);
});

test("a verified stash requires three nearby misses before it is downgraded", async () => {
  resetSharedWorldRegistry();
  upsertSharedStructure({
    id: "shared-stash",
    type: "stash",
    status: "verified",
    position: { x: 1, y: 64, z: 2 },
    provenance: "world_observation",
    verifiedAt: 123,
    evidence: { block: "chest", openable: true },
  });
  const bot = {
    entity: { position: { x: 1, y: 64, z: 2 } },
    findBlock: () => null,
  } as any;

  assert.equal((await verifyCanonicalStash(bot, "shared-stash", { x: 1, y: 64, z: 2 })).status, "verified");
  assert.equal((await verifyCanonicalStash(bot, "shared-stash", { x: 1, y: 64, z: 2 })).status, "verified");
  const missing = await verifyCanonicalStash(bot, "shared-stash", { x: 1, y: 64, z: 2 });
  assert.equal(missing.status, "missing");
  assert.equal(missing.evidence, undefined);
});
test("stash verification tolerates approximate canonical Y coordinates", async () => {
  resetSharedWorldRegistry();
  const chest = { name: "chest", position: { x: 1, y: 78, z: 2 } };
  const bot = {
    findBlock: ({ matching }: any) => (matching(chest) ? chest : null),
    openContainer: async () => ({
      inventoryStart: 27,
      containerItems: () => [],
      close: () => {},
    }),
  } as any;

  const result = await verifyCanonicalStash(bot, "shared-stash", { x: 1, y: 64, z: 2 }, 5);
  assert.equal(result.status, "verified");
  assert.deepEqual(result.position, chest.position);
});
test("a transient container-open failure cannot downgrade a verified stash", async () => {
  resetSharedWorldRegistry();
  const verified = upsertSharedStructure({
    id: "shared-stash",
    type: "stash",
    status: "verified",
    position: { x: 1, y: 64, z: 2 },
    provenance: "world_observation",
    verifiedAt: 123,
    evidence: { block: "chest", openable: true },
  });
  const chest = { name: "chest", position: { x: 1, y: 64, z: 2 } };
  const bot = {
    findBlock: () => chest,
    openContainer: async () => {
      throw new Error("container busy");
    },
  } as any;

  const result = await verifyCanonicalStash(bot, "shared-stash", { x: 1, y: 64, z: 2 });
  assert.equal(result, verified);
  assert.equal(getSharedStructure("shared-stash")?.status, "verified");
  assert.deepEqual(getSharedStructure("shared-stash")?.evidence, { block: "chest", openable: true });
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

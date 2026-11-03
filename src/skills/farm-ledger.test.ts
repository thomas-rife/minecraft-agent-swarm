import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import type { FarmSiteRecord } from "../bot/memory.js";
import { inspectFarmLedger, mergeFarmSiteRecords } from "./farm-ledger.js";

function site(overrides: Partial<FarmSiteRecord> = {}): FarmSiteRecord {
  return {
    water: { x: 10, y: 63, z: 10 },
    approach: { x: 9, y: 64, z: 10 },
    status: "planted",
    failures: 0,
    discoveredAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    plots: [],
    ...overrides,
  };
}

test("farm ledger merges plot knowledge from multiple bots", () => {
  const merged = mergeFarmSiteRecords([
    site({ plots: [{ x: 9, y: 63, z: 10 }] }),
    site({
      approach: { x: 11, y: 64, z: 10 },
      updatedAt: "2026-01-02T00:00:00.000Z",
      plots: [
        { x: 9, y: 63, z: 10 },
        { x: 11, y: 63, z: 10 },
      ],
    }),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.plots?.length, 2);
  assert.deepEqual(merged[0]?.approach, { x: 11, y: 64, z: 10 });
});

test("farm ledger preserves the highest invalid confirmation count across bots", () => {
  const merged = mergeFarmSiteRecords([
    site({ plots: [{ x: 9, y: 63, z: 10, invalidChecks: 2 }] }),
    site({ plots: [{ x: 9, y: 63, z: 10, invalidChecks: 1 }] }),
  ]);
  assert.equal(merged[0]?.plots?.[0]?.invalidChecks, 2);
});

test("farm inspection counts only ledger plots and identifies empty soil", () => {
  const blocks = new Map<string, any>([
    ["9,63,10", { name: "farmland" }],
    ["9,64,10", { name: "wheat", getProperties: () => ({ age: 7 }) }],
    ["11,63,10", { name: "farmland" }],
    ["11,64,10", { name: "air" }],
    // Mature wheat outside the ledger must not affect this farm.
    ["30,64,30", { name: "wheat", getProperties: () => ({ age: 7 }) }],
  ]);
  const bot = {
    blockAt(position: { x: number; y: number; z: number }) {
      return blocks.get(`${position.x},${position.y},${position.z}`) ?? null;
    },
  } as unknown as Bot;
  const inspection = inspectFarmLedger(bot, [
    site({
      plots: [
        { x: 9, y: 63, z: 10 },
        { x: 11, y: 63, z: 10 },
      ],
    }),
  ]);
  assert.deepEqual(inspection, {
    totalPlots: 2,
    loadedPlots: 2,
    growingPlots: 1,
    maturePlots: 1,
    repairPlots: 1,
    unknownPlots: 0,
  });
});

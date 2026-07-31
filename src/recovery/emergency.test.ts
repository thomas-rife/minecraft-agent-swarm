import test from "node:test";
import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import { safeGoto } from "../bot/navigation.js";
import { EmergencyManager } from "./emergency.js";

function dryBot() {
  return {
    username: "TestBot",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [] },
    blockAt: () => ({ name: "air", boundingBox: "empty" }),
    pathfinder: {
      goto: async () => {
        throw new Error("route unavailable");
      },
      stop: () => {},
      setMovements: () => {},
    },
    stopDigging: () => {},
    setControlState: () => {},
    currentWindow: null,
  } as any;
}

test("water emergency clears after a stable dry observation window", async () => {
  let wet = true;
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    blockAt: (position: Vec3) => ({ name: wet && position.y <= 65 ? "water" : "air", boundingBox: "empty" }),
    pathfinder: { stop: () => {} },
    stopDigging: () => {},
    setControlState: () => {},
    currentWindow: null,
  } as any;
  const manager = new EmergencyManager();
  assert.equal(manager.observe(bot)?.kind, "WATER_ESCAPE");
  wet = false;
  const result = await manager.resolve(bot);
  assert.equal(result?.code, "WATER_ESCAPE_RESOLVED");
  assert.equal(manager.getActive(), null);
});

test("standing still at a low Y coordinate does not create a trapped emergency", () => {
  const bot = dryBot();
  const manager = new EmergencyManager();

  for (let check = 0; check < 20; check++) {
    assert.equal(manager.observe(bot), null);
  }
});

test("failed navigation does not escalate into global cancellation", async () => {
  const bot = dryBot();
  const manager = new EmergencyManager();

  await assert.rejects(() => safeGoto(bot, { x: 5, y: 64, z: 5 }, 1_000));
  assert.equal(manager.observe(bot), null);

  const result = await manager.resolve(bot);
  assert.equal(result, null);
  assert.equal(manager.getActive(), null);
});

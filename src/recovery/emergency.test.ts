import test from "node:test";
import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import { EmergencyManager } from "./emergency.js";

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

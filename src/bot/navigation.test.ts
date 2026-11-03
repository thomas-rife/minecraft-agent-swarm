import { test } from "node:test";
import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import { getSurfaceState } from "./navigation.js";

function surfaceBot(blockNameAt: (position: Vec3) => string, worldTop = 80) {
  const position = new Vec3(0, 64, 0);
  return {
    entity: { position },
    game: { minY: 0, height: worldTop + 1 },
    blockAt(pos: Vec3) {
      const name = blockNameAt(pos);
      return {
        name,
        boundingBox: name === "air" ? "empty" : "block",
        position: pos,
      };
    },
  } as any;
}

test("surface state detects a roof independently of elevation", () => {
  const bot = surfaceBot((position) => (position.y === 67 ? "oak_planks" : "air"));
  const state = getSurfaceState(bot);
  assert.equal(state.hasDirectSky, false);
  assert.equal(state.skyKnown, true);
  assert.equal(state.ceilingDistance, 3);
});

test("surface state recognizes direct sky at low elevation", () => {
  const bot = surfaceBot(() => "air");
  bot.entity.position = new Vec3(0, 40, 0);
  const state = getSurfaceState(bot);
  assert.equal(state.hasDirectSky, true);
  assert.equal(state.skyKnown, true);
  assert.equal(state.ceilingDistance, null);
});

test("surface state reports an unloaded sky column as unknown", () => {
  const bot = surfaceBot(() => "air");
  bot.blockAt = (position: Vec3) =>
    position.y === 70
      ? null
      : {
          name: "air",
          boundingBox: "empty",
          position,
        };
  const state = getSurfaceState(bot);
  assert.equal(state.hasDirectSky, false);
  assert.equal(state.skyKnown, false);
});

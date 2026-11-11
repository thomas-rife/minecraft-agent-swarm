import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import mcDataLoader from "minecraft-data";
import pkg from "mineflayer-pathfinder";
import { installLiquidAvoidance } from "./movement-policy.js";

test("liquid avoidance covers initial and replacement skill movements while preserving digging", () => {
  const registry = mcDataLoader("1.21.4");
  const applied: InstanceType<typeof pkg.Movements>[] = [];
  const mockBot = {
    registry,
    pathfinder: {
      movements: undefined as unknown as InstanceType<typeof pkg.Movements>,
      setMovements(movements: InstanceType<typeof pkg.Movements>) {
        this.movements = movements;
        applied.push(movements);
      },
    },
  };
  const bot = mockBot as unknown as Bot;
  const initial = new pkg.Movements(bot);
  mockBot.pathfinder.movements = initial;
  installLiquidAvoidance(bot);

  const mining = new pkg.Movements(bot);
  mining.canDig = true;
  mining.allowFreeMotion = true;
  bot.pathfinder.setMovements(mining);

  assert.deepEqual(applied, [initial, mining]);
  for (const moves of applied) {
    for (const name of ["water", "lava", "fire"]) {
      assert.ok(moves.blocksToAvoid.has(registry.blocksByName[name].id), `${name} must be avoided`);
    }
    assert.equal(moves.allowFreeMotion, false);
    assert.equal(moves.dontCreateFlow, true);
  }
  assert.equal(mining.canDig, true);
});

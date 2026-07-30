import test from "node:test";
import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import { NavigationRecoveryError, consumeNavigationRecoveryRequest, safeGoto } from "./navigation.js";

function navigationBot(outcomes: Array<"fail" | "pass">) {
  let calls = 0;
  const bot = {
    username: "TestBot",
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [] },
    blockAt: () => ({ name: "air" }),
    pathfinder: {
      goto: async () => {
        const outcome = outcomes[calls++] ?? "fail";
        if (outcome === "fail") throw new Error(`route-${calls}-failed`);
      },
      stop: () => {},
      setMovements: () => {},
    },
    setControlState: () => {},
  } as any;
  return { bot, get calls() { return calls; } };
}

test("navigation recovery replans and succeeds on a later route", async () => {
  const mock = navigationBot(["fail", "fail", "pass"]);
  await safeGoto(mock.bot, { x: 5, y: 64, z: 5 }, 9_000);
  assert.equal(mock.calls, 3);
  assert.equal(consumeNavigationRecoveryRequest(mock.bot), null);
});

test("exhausted navigation requests deterministic trapped recovery", async () => {
  const mock = navigationBot(["fail", "fail", "fail"]);
  await assert.rejects(() => safeGoto(mock.bot, { x: 5, y: 64, z: 5 }, 9_000), NavigationRecoveryError);
  assert.equal(consumeNavigationRecoveryRequest(mock.bot)?.reason, "NO_POSITIONAL_PROGRESS");
});

test("navigation rejects non-finite targets before moving", async () => {
  const mock = navigationBot(["pass"]);
  await assert.rejects(() => safeGoto(mock.bot, { x: Number.NaN, y: 64, z: 5 }), /INVALID_NAVIGATION_TARGET/);
  assert.equal(mock.calls, 0);
});

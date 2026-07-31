import test from "node:test";
import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import { digBlockVerified } from "./dig-verifier.js";

test("dig verification retries the same coordinate until the world block changes", async () => {
  const position = new Vec3(2, 65, 3);
  const log = { name: "oak_log", position } as any;
  const air = { name: "air", position } as any;
  let digs = 0;
  let current = log;
  const bot = {
    blockAt: () => current,
    dig: async () => {
      digs++;
      if (digs === 2) current = air;
    },
    stopDigging: () => {},
  } as any;

  await digBlockVerified(bot, log, 50, 3);
  assert.equal(digs, 2);
  assert.equal(current.name, "air");
});

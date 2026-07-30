import test from "node:test";
import assert from "node:assert/strict";
import { withStashLock } from "./stash.js";
import { getStashTransactions, recordStashTransaction } from "./stash-ledger.js";

test("canonical stash lock serializes competing agents", async () => {
  const order: string[] = [];
  const position = { x: 1, y: 64, z: 2 };
  await Promise.all([
    withStashLock(position, async () => {
      order.push("first-start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("first-end");
    }),
    withStashLock(position, async () => {
      order.push("second-start");
      order.push("second-end");
    }),
  ]);
  assert.deepEqual(order, ["first-start", "first-end", "second-start", "second-end"]);
});

test("stash ledger records committed, partial, and failed deltas", () => {
  recordStashTransaction({ bot: "A", kind: "deposit", item: "stone", requested: 4, verifiedDelta: -4, containerDelta: 4 });
  recordStashTransaction({ bot: "B", kind: "withdraw", item: "stone", requested: 4, verifiedDelta: 2, containerDelta: -2 });
  recordStashTransaction({ bot: "C", kind: "withdraw", item: "stone", requested: 4, verifiedDelta: 0, containerDelta: 0 });
  assert.deepEqual(getStashTransactions().slice(-3).map((entry) => entry.status), ["committed", "partial", "failed"]);
});

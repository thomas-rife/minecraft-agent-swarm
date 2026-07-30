import test from "node:test";
import assert from "node:assert/strict";
import { cancelActiveOperation, runControlledOperation } from "./controller.js";
import { succeeded } from "./types.js";

function mockBot() {
  const calls = { stop: 0, stopDigging: 0, controls: 0, close: 0 };
  const bot = {
    pathfinder: { stop: () => calls.stop++ },
    stopDigging: () => calls.stopDigging++,
    setControlState: () => calls.controls++,
    currentWindow: { id: 1 },
    closeWindow: () => calls.close++,
  } as any;
  return { bot, calls };
}

test("operation controller times out and performs full cleanup", async () => {
  const { bot, calls } = mockBot();
  const result = await runControlledOperation(bot, "action", 10, async () => new Promise(() => {}));
  assert.equal(result.status, "timed_out");
  assert.equal(result.code, "OPERATION_TIMED_OUT");
  assert.ok(calls.stop >= 1);
  assert.ok(calls.stopDigging >= 1);
  assert.ok(calls.controls >= 7);
  assert.ok(calls.close >= 1);
});

test("operation controller rejects concurrent work", async () => {
  const { bot } = mockBot();
  let finish!: () => void;
  const first = runControlledOperation(bot, "skill", 1_000, async () => {
    await new Promise<void>((resolve) => (finish = resolve));
    return succeeded("FIRST_DONE", "done");
  });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await runControlledOperation(bot, "action", 100, async () => succeeded("SECOND_DONE", "done"));
  assert.equal(second.code, "OPERATION_ALREADY_ACTIVE");
  finish();
  await first;
});

test("cancelled operation ignores a late completion", async () => {
  const { bot } = mockBot();
  let finish!: () => void;
  const pending = runControlledOperation(bot, "action", 1_000, async () => {
    await new Promise<void>((resolve) => (finish = resolve));
    return succeeded("LATE_SUCCESS", "too late");
  });
  await new Promise((resolve) => setImmediate(resolve));
  await cancelActiveOperation(bot);
  finish();
  const result = await pending;
  assert.equal(result.status, "cancelled");
  assert.equal(result.code, "STALE_OPERATION_RESULT_IGNORED");
});

test("death cancellation cleans controls and invalidates late work", async () => {
  const { bot, calls } = mockBot();
  let finish!: () => void;
  const pending = runControlledOperation(bot, "skill", 1_000, async () => {
    await new Promise<void>((resolve) => (finish = resolve));
    return succeeded("POST_DEATH_MUTATION", "must be ignored");
  });
  await new Promise((resolve) => setImmediate(resolve));
  await cancelActiveOperation(bot);
  finish();
  const result = await pending;
  assert.equal(result.status, "cancelled");
  assert.ok(calls.stop >= 1);
  assert.ok(calls.controls >= 7);
});

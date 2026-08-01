import test from "node:test";
import assert from "node:assert/strict";
import { LlmQueueWaitTimeoutError, SerialTaskQueue } from "./scheduler.js";

test("local LLM tasks run one at a time in arrival order", async () => {
  const queue = new SerialTaskQueue();
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = queue.run(async () => {
    events.push("first:start");
    await firstGate;
    events.push("first:end");
    return 1;
  });
  const second = queue.run(async () => {
    events.push("second:start");
    events.push("second:end");
    return 2;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
});

test("a failed LLM task does not block the queue", async () => {
  const queue = new SerialTaskQueue();
  const failed = queue.run(async () => {
    throw new Error("expected");
  });
  const next = queue.run(async () => "recovered");

  await assert.rejects(failed, /expected/);
  assert.equal(await next, "recovered");
});

test("a stale queued LLM task rejects before the running request completes", async () => {
  const queue = new SerialTaskQueue();
  let releaseFirst!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const first = queue.run(async () => gate);
  let secondRan = false;
  const second = queue.run(
    async () => {
      secondRan = true;
    },
    { maxQueueWaitMs: 10 },
  );

  await assert.rejects(second, LlmQueueWaitTimeoutError);
  assert.equal(secondRan, false);
  releaseFirst();
  await first;
});

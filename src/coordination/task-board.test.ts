import test from "node:test";
import assert from "node:assert/strict";
import { claimTask, getTask, publishTask, recordTaskResult, resetTaskBoard, restoreTaskBoard } from "./task-board.js";
import { failed, succeeded } from "../operations/types.js";

test("task leases prevent duplicate claims", () => {
  resetTaskBoard();
  publishTask({ id: "task-1", capability: "build_farm", description: "Build the shared farm" });
  assert.equal(claimTask("task-1", "Flora"), true);
  assert.equal(claimTask("task-1", "Atlas"), false);
});

test("retryable failures release a task while verified success completes it", () => {
  resetTaskBoard();
  publishTask({ id: "task-2", capability: "strip_mine", description: "Find iron" });
  claimTask("task-2", "Forge");
  recordTaskResult("task-2", failed("NO_PATH", "blocked", { retryable: true }));
  assert.equal(getTask("task-2")?.status, "open");
  assert.equal(claimTask("task-2", "Atlas"), true);
  recordTaskResult("task-2", succeeded("IRON_FOUND", "done"));
  assert.equal(getTask("task-2")?.status, "completed");
  assert.ok(getTask("task-2")?.evidence?.postconditions);
});

test("restart releases expired leases and preserves live ownership", () => {
  const now = Date.now();
  restoreTaskBoard(
    [
      { id: "expired", capability: "build", description: "old", status: "claimed", owner: "Mason", leaseUntil: now - 1, createdAt: now - 10, updatedAt: now - 10, prerequisites: [] },
      { id: "live", capability: "mine", description: "new", status: "claimed", owner: "Forge", leaseUntil: now + 10_000, createdAt: now, updatedAt: now, prerequisites: [] },
    ],
    now,
  );
  assert.equal(getTask("expired")?.status, "open");
  assert.equal(getTask("expired")?.owner, undefined);
  assert.equal(getTask("live")?.owner, "Forge");
});

test("task prerequisites prevent premature claims", () => {
  resetTaskBoard();
  publishTask({ id: "foundation", capability: "build", description: "foundation" });
  publishTask({ id: "roof", capability: "build", description: "roof", prerequisites: ["foundation"] });
  assert.equal(claimTask("roof", "Mason"), false);
  claimTask("foundation", "Mason");
  recordTaskResult("foundation", succeeded("FOUNDATION_VERIFIED", "done"));
  assert.equal(claimTask("roof", "Mason"), true);
});

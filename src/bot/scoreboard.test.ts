import assert from "node:assert/strict";
import test from "node:test";
import { isFarmCompletionResult } from "./scoreboard.js";

test("farm milestone accepts the deterministic build_farm completion result", () => {
  assert.equal(
    isFarmCompletionResult("Farm planted! 12 wheat seeds near water at -120, -1222. Wheat grows in ~5 minutes!"),
    true,
  );
  assert.equal(isFarmCompletionResult("Farm complete beside the village."), true);
});

test("farm milestone rejects sapling planting and partial farm activity", () => {
  assert.equal(isFarmCompletionResult("Gathered 5 logs. Replanted 2 saplings."), false);
  assert.equal(
    isFarmCompletionResult("Couldn't reach any trees, so planted 4 saplings on open ground instead."),
    false,
  );
  assert.equal(isFarmCompletionResult("Planted 3/12 wheat"), false);
  assert.equal(isFarmCompletionResult("Harvested 4 wheat and replanted the field."), false);
});

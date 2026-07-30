import test from "node:test";
import assert from "node:assert/strict";
import { isServerFeedbackMessage } from "./chat-classifier.js";

test("spreadplayers confirmations are classified as server feedback", () => {
  assert.equal(
    isServerFeedbackMessage(
      "Spread 1 entity/entities around 183.5, 186.5 with an average distance of 0.00 block(s) apart]",
    ),
    true,
  );
});

test("other command confirmations are classified as server feedback", () => {
  assert.equal(isServerFeedbackMessage("Gamerule keepInventory is now set to: true"), true);
  assert.equal(isServerFeedbackMessage("Teleported Milo to 116.5, 66.0, 256.5"), true);
  assert.equal(isServerFeedbackMessage("Set spawn point to 116, 66, 256"), true);
});

test("ordinary player chat is not classified as server feedback", () => {
  assert.equal(isServerFeedbackMessage("Milo, can you spread these seeds around the farm?"), false);
});

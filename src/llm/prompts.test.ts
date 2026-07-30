import test from "node:test";
import assert from "node:assert/strict";
import { buildStrategicPrompt } from "./prompts.js";

test("strategic prompt exposes only configured skills", () => {
  const prompt = buildStrategicPrompt({
    name: "Test",
    personality: "careful",
    allowedActions: ["explore", "place_block", "craft"],
    allowedSkills: ["build_farm"],
  });
  assert.match(prompt, /SKILL: build_farm/);
  assert.match(prompt, /PURPOSE:/);
  assert.match(prompt, /PRECONDITIONS:/);
  assert.match(prompt, /SUCCESS:/);
  assert.match(prompt, /RECOVERY:/);
  assert.doesNotMatch(prompt, /build_house/);
  assert.doesNotMatch(prompt, /generate_skill/);
  assert.doesNotMatch(prompt, /place_block/);
  assert.doesNotMatch(prompt, /go_to/);
  assert.doesNotMatch(prompt, /mine_block/);
});

test("strategic prompt does not advertise invoke_skill when role has no skills", () => {
  const prompt = buildStrategicPrompt({
    name: "Scout",
    personality: "curious",
    allowedActions: ["explore"],
    allowedSkills: [],
  });
  assert.doesNotMatch(prompt, /invoke_skill/);
  assert.doesNotMatch(prompt, /Dynamic skills/);
});

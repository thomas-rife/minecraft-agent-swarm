import test from "node:test";
import assert from "node:assert/strict";
import { buildStrategicPrompt } from "./prompts.js";

test("strategic prompt asks only for durable intent, never an action", () => {
  const prompt = buildStrategicPrompt({
    name: "Test",
    personality: "careful",
    allowedActions: ["explore", "place_block", "craft"],
    allowedSkills: ["build_farm"],
  });
  assert.match(prompt, /OVERALL GOAL/);
  assert.match(prompt, /deterministic\s+controller/);
  assert.match(prompt, /"goal"/);
  assert.doesNotMatch(prompt, /"action"/);
  assert.doesNotMatch(prompt, /"params"/);
});

test("strategic prompt does not expose low-level capabilities", () => {
  const prompt = buildStrategicPrompt({
    name: "Scout",
    personality: "curious",
    allowedActions: ["explore"],
    allowedSkills: [],
  });
  assert.doesNotMatch(prompt, /invoke_skill/);
  assert.doesNotMatch(prompt, /gather_wood/);
});

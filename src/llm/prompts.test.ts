import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStrategicPrompt, type RoleContext } from "./prompts.js";
import type { ActionOption } from "../bot/action-menu.js";

function role(allowedSkills?: string[], actionOptions?: ActionOption[]): RoleContext {
  return {
    name: "TestBot",
    personality: "A test bot.",
    role: "Tester",
    allowedActions: ["explore"],
    allowedSkills,
    actionOptions,
  };
}

test("buildStrategicPrompt: explicit empty skill list does not expand the registry", () => {
  const prompt = buildStrategicPrompt(role([]));
  assert.doesNotMatch(prompt, /^- build_house:/m);
  assert.doesNotMatch(prompt, /^- strip_mine:/m);
});

test("buildStrategicPrompt: configured skills are listed compactly", () => {
  const prompt = buildStrategicPrompt(role(["strip_mine", "smelt_ores"]));
  assert.match(
    prompt,
    /^ROLE SPECIALTIES \(they appear above only when currently relevant\): strip_mine, smelt_ores$/m,
  );
  assert.match(prompt, /Roles guide priorities, not permanent permissions/i);
  assert.doesNotMatch(prompt, /^- build_house:/m);
});

test("buildStrategicPrompt: only the live deterministic menu is advertised", () => {
  const prompt = buildStrategicPrompt(
    role(
      ["strip_mine"],
      [
        { action: "explore", signature: 'explore {"direction":"north"}', description: "Scout." },
        {
          action: "invoke_skill",
          skill: "strip_mine",
          signature: 'invoke_skill {"skill":"strip_mine"}',
          description: "Mine.",
        },
      ],
    ),
  );
  assert.match(prompt, /^AVAILABLE NOW .*$/m);
  assert.match(prompt, /^- explore /m);
  assert.match(prompt, /^- invoke_skill \{"skill":"strip_mine"\}/m);
  assert.doesNotMatch(prompt, /\battack \{\}/);
  assert.doesNotMatch(prompt, /\bgenerate_skill\b/);
  assert.match(prompt, /^ROLE-PREFERRED ACTIONS \(guidance only\): explore$/m);
});

test("buildStrategicPrompt: omitted skill configuration does not expose the global registry", () => {
  const prompt = buildStrategicPrompt(role());
  assert.doesNotMatch(prompt, /^- build_house:/m);
  assert.doesNotMatch(prompt, /^- strip_mine:/m);
});

test("buildStrategicPrompt: hierarchy selection excludes legacy skill priorities", () => {
  const hierarchyRole = role(
    ["build_farm"],
    [
      {
        action: "choose_subobjective",
        signature: 'choose_subobjective {"subobjective":"establish_wheat_farm"}',
        description: "Choose the farm procedure.",
        allowedParams: { subobjective: ["establish_wheat_farm"] },
      },
    ],
  );
  hierarchyRole.priorities = "Invoke build_farm directly and gather_wood first.";

  const prompt = buildStrategicPrompt(hierarchyRole);

  assert.match(prompt, /STRATEGIC SELECTION/);
  assert.match(prompt, /"action":"choose_subobjective"/);
  assert.match(prompt, /"subobjective":"establish_wheat_farm"/);
  assert.doesNotMatch(prompt, /Invoke build_farm directly/);
  assert.doesNotMatch(prompt, /CRAFTING BASICS/);
});

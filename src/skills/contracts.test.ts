import test from "node:test";
import assert from "node:assert/strict";
import { ALL_STATIC_SKILLS } from "../bot/role.js";
import { getSkillPromptLines, skillRegistry } from "./registry.js";

test("every static skill exposes a complete deterministic contract", () => {
  for (const name of ALL_STATIC_SKILLS) {
    const skill = skillRegistry.get(name);
    assert.ok(skill, `${name} is not registered`);
    assert.ok(skill.contract?.purpose, `${name} has no purpose`);
    assert.ok(skill.contract?.requiredStatus?.length, `${name} has no preconditions summary`);
    assert.ok(skill.contract?.successCriteria?.length, `${name} has no success criteria`);
    assert.ok(skill.contract?.knownFailureCodes?.length, `${name} has no failure codes`);
    assert.ok(skill.contract?.progressPolicy, `${name} has no progress policy`);
    assert.ok(skill.contract?.recoveryPolicy, `${name} has no recovery policy`);
    assert.equal(typeof skill.contract?.postconditions, "function", `${name} has no objective verifier`);
  }
});

test("role prompt renderer includes full contracts and system-owned parameters", () => {
  const prompt = getSkillPromptLines(["setup_stash"]);
  assert.match(prompt, /SKILL: setup_stash/);
  assert.match(prompt, /system-injected/);
  assert.match(prompt, /FAILURES:/);
  assert.doesNotMatch(prompt, /SKILL: build_house/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { ALL_STATIC_SKILLS } from "../bot/role.js";
import { getSkillPromptLines, skillRegistry } from "./registry.js";
import { resetSharedWorldRegistry, upsertSharedStructure } from "../world/registry.js";

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

test("setup_stash accepts the container observation recorded by the skill without rescanning", async () => {
  resetSharedWorldRegistry();
  upsertSharedStructure({
    id: "shared-stash",
    type: "stash",
    status: "verified",
    position: { x: 116, y: 66, z: 256 },
    provenance: "world_observation",
    verifiedAt: Date.now(),
    evidence: { block: "chest", capacity: 27, items: [], openable: true },
  });
  const bot = {
    findBlock: () => {
      throw new Error("postcondition must not rescan a freshly verified stash");
    },
  } as any;
  const contract = skillRegistry.get("setup_stash")?.contract;
  const result = await contract?.postconditions?.(bot, { x: 116, y: 66, z: 256 }, {});
  assert.equal(result?.[0]?.satisfied, true);
});
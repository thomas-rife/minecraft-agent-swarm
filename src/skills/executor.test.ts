import test from "node:test";
import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import { defineSkill } from "./define.js";
import { registerBotMemory, runSkill } from "./executor.js";
import { succeeded } from "../operations/types.js";
import { getSharedStructure, resetSharedWorldRegistry, upsertSharedStructure } from "../world/registry.js";

function mockBot(name: string) {
  const bot = {
    username: name,
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [] },
    pathfinder: { stop: () => {} },
    stopDigging: () => {},
    setControlState: () => {},
    currentWindow: null,
    chat: () => {},
  } as any;
  registerBotMemory(bot, { recordSkillAttempt: () => {} } as any);
  return bot;
}

test("setup_stash is single-flight across bots and followers reuse verified state", async () => {
  resetSharedWorldRegistry();
  let executions = 0;
  const skill = defineSkill({
    name: "setup_stash",
    description: "test canonical stash setup",
    params: {},
    contract: { timeoutMs: 1_000 },
    estimateMaterials: () => ({}),
    async execute() {
      executions++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      upsertSharedStructure({
        id: "shared-stash",
        type: "stash",
        status: "verified",
        position: { x: 1, y: 64, z: 2 },
        provenance: "world_observation",
        verifiedAt: Date.now(),
        evidence: { block: "chest", openable: true },
      });
      return succeeded("TEST_STASH_READY", "stash ready");
    },
  });

  const [first, second] = await Promise.all([
    runSkill(mockBot("Milo"), skill, {}),
    runSkill(mockBot("Ava"), skill, {}),
  ]);

  assert.equal(executions, 1);
  assert.equal(first.status, "succeeded");
  assert.equal(second.code, "SKILL_ALREADY_SATISFIED");
  assert.equal(getSharedStructure("shared-stash")?.status, "verified");
});

import assert from "node:assert/strict";
import test from "node:test";
import { shouldRetireSkill } from "./reliability.js";

test("source-backed skills never become permanently retired", () => {
  assert.equal(
    shouldRetireSkill("maintain_farm", { attempts: 100, successes: 0, rate: 0 }),
    false,
  );
  assert.equal(
    shouldRetireSkill("smelt_ores", { attempts: 100, successes: 0, rate: 0 }),
    false,
  );
});

test("a genuinely broken generated skill can still be retired", () => {
  assert.equal(
    shouldRetireSkill("generated_bad_skill", { attempts: 8, successes: 0, rate: 0 }),
    true,
  );
});

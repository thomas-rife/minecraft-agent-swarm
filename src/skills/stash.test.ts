import assert from "node:assert/strict";
import test from "node:test";
import { depositCountForStack } from "./stash.js";

test("pantry deposits excess from one large food stack and keeps three items", () => {
  const kept = new Map<string, number>();
  assert.equal(depositCountForStack("bread", 50, [], kept, "pantry"), 47);
  assert.equal(kept.get("__pantry_food_items"), 3);
});

test("pantry mode ignores tools, seeds, and other non-food inventory", () => {
  const kept = new Map<string, number>();
  assert.equal(depositCountForStack("stone_pickaxe", 1, [], kept, "pantry"), 0);
  assert.equal(depositCountForStack("wheat_seeds", 64, [], kept, "pantry"), 0);
});

test("pantry reserve is shared across multiple food stacks", () => {
  const kept = new Map<string, number>();
  assert.equal(depositCountForStack("apple", 2, [], kept, "pantry"), 0);
  assert.equal(depositCountForStack("bread", 10, [], kept, "pantry"), 9);
});

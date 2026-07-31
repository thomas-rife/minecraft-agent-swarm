import test from "node:test";
import assert from "node:assert/strict";
import { routeOverallGoal } from "./goal-router.js";

test("overall farm intent routes deterministically to build_farm", () => {
  assert.deepEqual(routeOverallGoal("Establish a working wheat farm"), {
    action: "build_farm",
    params: {},
  });
});

test("overall mining intent routes to the complete mining skill", () => {
  assert.equal(routeOverallGoal("Acquire iron and coal").action, "strip_mine");
});

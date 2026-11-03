import { test } from "node:test";
import assert from "node:assert/strict";
import { actionResultSucceeded } from "./action-result.js";

const FAILURES = [
  "No oak_log in the stash. Gather it yourself instead.",
  "Couldn't plant anything near water at -93,-1169 — navigation or tilling failed. Try 'explore' first.",
  "Can't craft oak_planks — need: oak_log. Gather those first.",
  "Action failed: Path was stopped before it could be completed! Thus, the desired goal was not reached.",
  "No new tools crafted. Missing: pickaxe. Use gather_wood to get materials first.",
  "All stash chests are full! Need more chests.",
  "Nothing to smelt! Mine some ore first (strip_mine for iron, gold, copper).",
  'Blocked: "gather_wood" recently failed. Try something else.',
  "Unknown action: teleport_home",
  "Just vibing.",
  "That's 1352 blocks away — too far! Try explore instead for shorter trips.",
  "No bed and no wool to craft one (need 3 same-color wool + 3 planks). Hunt sheep for wool first!",
  "Chopped 3 logs but couldn't pick up the drops — they may be stuck in leaves or a hole.",
  "Tossed 2x oak_log toward Flora but items are still on the ground — delivery NOT confirmed.",
];

for (const result of FAILURES) {
  test(`action result: failure — ${result.slice(0, 55)}`, () => {
    assert.equal(actionResultSucceeded(result), false);
  });
}

const SUCCESSES = [
  "Deposited 521 items at the stash.",
  "Deposited 10 items. 5 items couldn't fit — stash needs expansion.",
  "Withdrew 3x oak_log from stash (wanted 8 — that's all there was).",
  "Placed 1 chest at stash (-81, 80, -1172) but couldn't place second for double chest. Terrain issue.",
  "House partially built (40/80 blocks). It has... character. Maybe patch the holes later.",
  "Strip mine complete! Dug 40-block tunnel, mined 31 blocks total. No ores this time — try a different direction!",
  "Shared mine descent advanced to Y=37; target Y=16 is not reached yet. Resume point (105, 37, 203) is remembered.",
  "Usable farm shore confirmed at (183, 77, 186) with 8 hydrated plots and a reachable dry approach.",
  "Stash already exists — chest found at -81, 80, -1172.",
  "Already here!",
  "Explored north (~83 blocks). Water/lake visible.",
  "Arrived at -81, 80, -1172.",
  "Crafted 1x wooden_pickaxe.",
  "craftWoodenPickaxe completed.",
  "Farm planted! 12 wheat seeds near water at -93, -1169.",
  "Ate cooked_beef. Hunger: 20/20",
  "Slept through the night.",
  "Smelting done! Got: iron_ingotx4.",
  'HOUSE BUILT! "Starter" at -81, 80, -1172.',
  "All materials gathered!",
  "Said: Hello world",
  "Said: Flora needs help because she is stuck.",
  "Replied: That attempt failed, so try something else.",
  "Hunted pig and collected 2 food! Eat when hungry.",
  "Hunted chicken (drops collected — check inventory).",
  "Gave 8x oak_log to Flora — delivery confirmed.",
  "Placed and verified 1 expansion chest at (132, 70, 182); shared capacity increased by 27 slots.",
  "Surveyed and recorded north sector (1/8) and returned to base. Observed: trees, water.",
  "Established a verified cow pen near the farm with 2 animals contained and breeding feed supplied.",
  "Lit up core! Verified 8 grid positions (8 new torches).",
  "Gear target work_kit already complete.",
  "Farm maintenance complete: no mature wheat needs harvesting.",
  "Farm maintenance progressed: harvested 6 mature wheat and planted 6 replacements.",
  "Animal pen shell progressed: placed 32 blocks; 16 wall blocks remain at the remembered site.",
];

for (const result of SUCCESSES) {
  test(`action result: success — ${result.slice(0, 55)}`, () => {
    assert.equal(actionResultSucceeded(result), true);
  });
}

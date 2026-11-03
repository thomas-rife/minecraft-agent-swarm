import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import {
  describeFarmSurveyFailure,
  farmWorkPositions,
  hydratedTillableBlocks,
  inspectFarmSite,
  planFarmShorePreparation,
  surveyFarmSites,
} from "./farm-site.js";

function block(
  name: string,
  boundingBox = name === "air" || name === "short_grass" || name === "tall_grass" ? "empty" : "block",
) {
  return { name, boundingBox };
}

function mockBot(
  entries: Record<string, ReturnType<typeof block>>,
  waterPositions: Vec3[],
  seedPositions: Vec3[] = [],
) {
  return {
    entity: { position: new Vec3(0, 64, 0) },
    findBlocks: ({ matching }: any) => {
      const waterProbe = matching(block("water"));
      return waterProbe ? waterPositions : seedPositions;
    },
    blockAt: (pos: Vec3) => entries[`${pos.x},${pos.y},${pos.z}`] ?? block("air"),
  } as any;
}

test("hydratedTillableBlocks accepts farmland level and one level below water", () => {
  const entries = {
    "1,64,0": block("grass_block"),
    "1,65,0": block("air"),
    "2,63,0": block("dirt"),
    "2,64,0": block("air"),
    "5,64,0": block("grass_block"),
    "5,65,0": block("air"),
  };
  const targets = hydratedTillableBlocks(mockBot(entries, [new Vec3(0, 64, 0)]), new Vec3(0, 64, 0)).map((p) =>
    p.toString(),
  );

  assert.deepEqual(targets.sort(), ["(1, 64, 0)", "(2, 63, 0)"].sort());
});

test("surveyFarmSites recognizes a valid shore even before seeds are found", () => {
  const entries: Record<string, ReturnType<typeof block>> = { "0,65,0": block("air") };
  for (let x = 1; x <= 4; x++) {
    entries[`${x},64,0`] = block("grass_block");
    entries[`${x},65,0`] = block("air");
  }
  const survey = surveyFarmSites(mockBot(entries, [new Vec3(0, 64, 0)]));

  assert.ok(survey.candidate);
  assert.equal(survey.candidate?.tillable.length, 4);
  assert.equal(survey.candidate?.seedSources, 0);
  assert.ok((survey.candidate?.approaches.length ?? 0) > 0);
});

test("farm survey rejects geometrically tillable soil with no dry standing position", () => {
  const entries: Record<string, ReturnType<typeof block>> = { "0,65,0": block("air") };
  for (const [x, z] of [
    [4, 0],
    [-4, 0],
    [0, 4],
    [0, -4],
  ]) {
    entries[`${x},64,${z}`] = block("grass_block");
    entries[`${x},65,${z}`] = block("air");
  }
  const bot = mockBot(entries, [new Vec3(0, 64, 0)]);

  assert.equal(farmWorkPositions(bot, new Vec3(0, 64, 0), hydratedTillableBlocks(bot, new Vec3(0, 64, 0))).length, 0);
  assert.equal(surveyFarmSites(bot).candidate, null);
});

test("inspectFarmSite revalidates one exact remembered water coordinate", () => {
  const entries: Record<string, ReturnType<typeof block>> = {
    "0,64,0": block("water"),
    "0,65,0": block("air"),
  };
  for (let x = 1; x <= 2; x++) {
    entries[`${x},64,0`] = block("grass_block");
    entries[`${x},65,0`] = block("air");
  }
  const bot = mockBot(entries, [new Vec3(0, 64, 0)]);

  assert.equal(inspectFarmSite(bot, new Vec3(0, 64, 0), 2)?.tillable.length, 2);
  assert.equal(inspectFarmSite(bot, new Vec3(10, 64, 10), 2), null);
});

test("farm survey distinguishes absent water from an unusable shore", () => {
  assert.match(describeFarmSurveyFailure(surveyFarmSites(mockBot({}, []))), /No water blocks are loaded/);

  const badShore = surveyFarmSites(mockBot({ "0,65,0": block("air") }, [new Vec3(0, 64, 0)]));
  assert.match(describeFarmSurveyFailure(badShore), /found surface water/i);
});

test("farm survey rejects underground water even when the cave has air above it", () => {
  const entries: Record<string, ReturnType<typeof block>> = {
    "0,64,0": block("water"),
    "0,65,0": block("air"),
    "0,69,0": block("stone"),
  };
  for (let x = 1; x <= 4; x++) {
    entries[`${x},64,0`] = block("grass_block");
    entries[`${x},65,0`] = block("air");
  }
  const survey = surveyFarmSites(mockBot(entries, [new Vec3(0, 64, 0)]));

  assert.equal(survey.candidate, null);
  assert.equal(survey.exposedWaterBlocks, 0);
  assert.match(describeFarmSurveyFailure(survey), /none are exposed/i);
});

test("a dense cave pool cannot consume the result cap and hide higher surface water", () => {
  const underground = Array.from({ length: 300 }, (_, index) => {
    const position = new Vec3(index % 20, 52, Math.floor(index / 20));
    return { ...block("water"), position };
  });
  const surfacePosition = new Vec3(30, 70, 0);
  const candidates = [...underground, { ...block("water"), position: surfacePosition }];
  const entries: Record<string, ReturnType<typeof block>> = {
    "30,71,0": block("air"),
  };
  for (let x = 31; x <= 34; x++) {
    entries[`${x},70,0`] = block("grass_block");
    entries[`${x},71,0`] = block("air");
  }
  const bot = {
    entity: { position: new Vec3(0, 70, 0) },
    findBlocks: ({ matching, count }: any) =>
      candidates
        .filter((candidate) => matching(candidate))
        .slice(0, count)
        .map((candidate) => candidate.position),
    blockAt: (pos: Vec3) => entries[`${pos.x},${pos.y},${pos.z}`] ?? block("air"),
  } as any;

  const survey = surveyFarmSites(bot, 96);
  assert.equal(survey.candidate?.water.toString(), surfacePosition.toString());
});

test("farm survey can return a two-plot starter candidate", () => {
  const entries: Record<string, ReturnType<typeof block>> = { "0,65,0": block("air") };
  for (let x = 1; x <= 2; x++) {
    entries[`${x},64,0`] = block("grass_block");
    entries[`${x},65,0`] = block("air");
  }
  const bot = mockBot(entries, [new Vec3(0, 64, 0)]);

  assert.equal(surveyFarmSites(bot).candidate, null);
  assert.equal(surveyFarmSites(bot, 96, 2).candidate?.tillable.length, 2);
});

test("shore preparation plans supported dirt cells to expand a steep bank", () => {
  const entries: Record<string, ReturnType<typeof block>> = {
    "0,65,0": block("air"),
    "1,64,0": block("grass_block"),
    "1,65,0": block("air"),
    "2,64,0": block("grass_block"),
    "2,65,0": block("air"),
    "-1,63,0": block("stone"),
    "-1,64,0": block("air"),
    "-1,65,0": block("air"),
    "0,63,1": block("stone"),
    "0,64,1": block("short_grass"),
    "0,65,1": block("air"),
  };
  const bot = mockBot(entries, [new Vec3(0, 64, 0)]);
  const plans = planFarmShorePreparation(bot, new Vec3(0, 64, 0), 4);

  assert.equal(plans.length, 2);
  assert.ok(plans.every((plan) => plan.kind === "place_dirt"));
});

test("shore preparation clears a simple obstruction above existing soil first", () => {
  const entries: Record<string, ReturnType<typeof block>> = {
    "0,65,0": block("air"),
    "1,64,0": block("grass_block"),
    "1,65,0": block("dirt"),
  };
  const bot = mockBot(entries, [new Vec3(0, 64, 0)]);
  const plans = planFarmShorePreparation(bot, new Vec3(0, 64, 0), 1);

  assert.equal(plans[0]?.kind, "clear_above");
  assert.equal(plans[0]?.target.toString(), new Vec3(1, 64, 0).toString());
});

test("shore preparation never destroys an existing upper farm plot to expose lower soil", () => {
  const entries: Record<string, ReturnType<typeof block>> = {
    "0,65,0": block("air"),
    "1,63,0": block("dirt"),
    "1,64,0": block("grass_block"),
    "1,65,0": block("air"),
  };
  const bot = mockBot(entries, [new Vec3(0, 64, 0)]);
  const plans = planFarmShorePreparation(bot, new Vec3(0, 64, 0), 2);

  assert.ok(!plans.some((plan) => plan.clear?.toString() === new Vec3(1, 64, 0).toString()));
});

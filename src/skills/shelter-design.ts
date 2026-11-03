import { Ollama } from "ollama";
import { config } from "../config.js";
import type { Blueprint, BlueprintBlock } from "./types.js";
import { finishBlueprint } from "./blueprints/helpers.js";

export interface ShelterDesign {
  name: string;
  width: number;
  depth: number;
  wallHeight: number;
  doorSide: "north" | "south" | "east" | "west";
  windows: boolean;
}

export const FALLBACK_SHELTER_DESIGN: ShelterDesign = {
  name: "Compact Trail Cabin",
  width: 4,
  depth: 5,
  wallHeight: 2,
  doorSide: "south",
  windows: true,
};

const SIDES = new Set<ShelterDesign["doorSide"]>(["north", "south", "east", "west"]);

export function normalizeShelterDesign(value: unknown): ShelterDesign {
  if (!value || typeof value !== "object") return { ...FALLBACK_SHELTER_DESIGN };
  const candidate = value as Record<string, unknown>;
  const number = (key: string, fallback: number, min: number, max: number) => {
    const parsed = Number(candidate[key]);
    return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : fallback;
  };
  const rawName = typeof candidate.name === "string" ? candidate.name.replace(/[^a-z0-9 '\-]/gi, "").trim() : "";
  const side = SIDES.has(candidate.doorSide as ShelterDesign["doorSide"])
    ? (candidate.doorSide as ShelterDesign["doorSide"])
    : FALLBACK_SHELTER_DESIGN.doorSide;
  return {
    name: rawName.slice(0, 48) || FALLBACK_SHELTER_DESIGN.name,
    width: number("width", FALLBACK_SHELTER_DESIGN.width, 4, 5),
    depth: number("depth", FALLBACK_SHELTER_DESIGN.depth, 4, 5),
    wallHeight: number("wallHeight", FALLBACK_SHELTER_DESIGN.wallHeight, 2, 3),
    doorSide: side,
    windows: typeof candidate.windows === "boolean" ? candidate.windows : FALLBACK_SHELTER_DESIGN.windows,
  };
}

export function shelterBlueprint(design: ShelterDesign): Blueprint {
  const blocks: BlueprintBlock[] = [];
  const { width, depth, wallHeight } = design;
  const door =
    design.doorSide === "north"
      ? { x: Math.floor(width / 2), z: 0 }
      : design.doorSide === "south"
        ? { x: Math.floor(width / 2), z: depth - 1 }
        : design.doorSide === "west"
          ? { x: 0, z: Math.floor(depth / 2) }
          : { x: width - 1, z: Math.floor(depth / 2) };

  for (let x = 0; x < width; x++)
    for (let z = 0; z < depth; z++) blocks.push({ pos: [x, 0, z], block: "oak_planks", phase: "structure" });

  for (let y = 1; y <= wallHeight; y++) {
    for (let x = 0; x < width; x++) {
      for (let z = 0; z < depth; z++) {
        if (x !== 0 && x !== width - 1 && z !== 0 && z !== depth - 1) continue;
        if (x === door.x && z === door.z && y <= 2) continue;
        const window =
          design.windows &&
          y === 2 &&
          ((z === 0 || z === depth - 1) ? x === Math.floor((width - 1) / 2) : z === Math.floor((depth - 1) / 2));
        if (!window) blocks.push({ pos: [x, y, z], block: "oak_planks", phase: "structure" });
      }
    }
  }
  for (let x = 0; x < width; x++)
    for (let z = 0; z < depth; z++)
      blocks.push({ pos: [x, wallHeight + 1, z], block: "oak_planks", phase: "structure" });

  const entrance: Blueprint["entrance"] = {
    pos: [door.x, 1, door.z],
    facing: design.doorSide,
  };
  return finishBlueprint(design.name, [width, wallHeight + 2, depth], blocks, entrance);
}

export function encodeShelterDesign(design: ShelterDesign): string {
  return Buffer.from(JSON.stringify(design)).toString("base64url");
}

export function decodeShelterDesign(notes?: string): ShelterDesign | null {
  const encoded = notes?.match(/\[shelter-design:([A-Za-z0-9_-]+)\]/)?.[1];
  if (!encoded) return null;
  try {
    return normalizeShelterDesign(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

export async function createShelterDesign(): Promise<ShelterDesign> {
  const prompt = `Design one practical early-game Minecraft shelter for an autonomous builder. Return JSON only with: name, width (4 or 5), depth (4 or 5), wallHeight (2 or 3), doorSide (north/south/east/west), windows (boolean). Keep it compact because the builder has at most 128 planks. Give it some personality while remaining buildable as a rectangular floor, perimeter wall, and flat roof.`;
  try {
    const response = await new Ollama({ host: config.ollama.host }).chat({
      model: config.ollama.model,
      think: false,
      format: "json",
      messages: [{ role: "user", content: prompt }],
      options: { temperature: 0.8, num_predict: 300 },
    });
    return normalizeShelterDesign(JSON.parse(response.message.content));
  } catch (error) {
    console.warn(`[Shelter] Model design failed; using compact fallback: ${error instanceof Error ? error.message : error}`);
    return { ...FALLBACK_SHELTER_DESIGN };
  }
}

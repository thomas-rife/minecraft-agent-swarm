import fs from "node:fs";
import path from "node:path";

export function defaultStateFile(name: string): string {
  const root = process.env.SWARM_STATE_DIR || path.join(process.cwd(), "data");
  return path.join(root, name);
}

export function loadJsonFile<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (error) {
    console.warn(`[State] Failed to load ${file}:`, error);
    return fallback;
  }
}

export function saveJsonFile(file: string, value: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
    fs.renameSync(temporary, file);
  } catch (error) {
    console.warn(`[State] Failed to save ${file}:`, error);
  }
}

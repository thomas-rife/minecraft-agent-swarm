import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadJsonFile, saveJsonFile } from "./json-store.js";

test("atomic JSON state survives a write and reload", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-state-"));
  const file = path.join(directory, "state.json");
  try {
    saveJsonFile(file, { version: 1, tasks: ["a"] });
    assert.deepEqual(loadJsonFile(file, null), { version: 1, tasks: ["a"] });
    saveJsonFile(file, { version: 2, tasks: ["a", "b"] });
    assert.deepEqual(loadJsonFile(file, null), { version: 2, tasks: ["a", "b"] });
    assert.equal(fs.readdirSync(directory).some((name) => name.endsWith(".tmp")), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

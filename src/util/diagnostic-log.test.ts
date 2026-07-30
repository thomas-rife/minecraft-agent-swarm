import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CompactDiagnosticLog } from "./diagnostic-log.js";
import { failed, succeeded } from "../operations/types.js";

test("compact diagnostics aggregate successes and deduplicate repeated failures", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-diagnostics-"));
  try {
    const log = new CompactDiagnosticLog({
      directory,
      enabled: true,
      summaryIntervalMs: 60_000,
      maxBytes: 1024 * 1024,
      dedupeWindowMs: 60_000,
    });
    const filePath = log.start({ bots: ["Milo", "Ava", "Peter"] });
    assert.ok(filePath);

    log.recordOperation("Milo", "explore", succeeded("EXPLORE_OK", "Explored nearby terrain"));
    log.recordOperation("Milo", "explore", succeeded("EXPLORE_OK", "Explored nearby terrain"));
    const failure = failed("NO_PATH", "No safe path found", { retryable: true });
    log.recordOperation("Peter", "strip_mine", failure);
    log.recordOperation("Peter", "strip_mine", failure);
    log.flushSummary("test");
    log.stop("test_complete");

    const lines = fs.readFileSync(filePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.filter((line) => line.type === "operation_outcome").length, 1);
    const summary = lines.find((line) => line.type === "summary" && line.reason === "test");
    assert.ok(summary);
    assert.equal(
      summary.outcomes.find((outcome: { code: string }) => outcome.code === "EXPLORE_OK")?.count,
      2,
    );
    assert.equal(summary.suppressedEvents[0]?.count, 1);
    assert.equal(lines.at(-1)?.type, "session_end");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

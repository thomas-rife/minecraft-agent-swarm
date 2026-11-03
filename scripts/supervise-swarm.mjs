import { spawn } from "node:child_process";

const RESTART_DELAY_MS = Number.parseInt(process.env.SWARM_RESTART_DELAY_MS || "15000", 10);
let stopping = false;
let child = null;

function launch() {
  if (stopping) return;
  const startedAt = Date.now();
  child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    stdio: "inherit",
    env: process.env,
  });
  console.log(`[Supervisor] Swarm child started (pid=${child.pid}).`);
  child.once("exit", (code, signal) => {
    child = null;
    if (stopping) return;
    const runtimeSec = Math.round((Date.now() - startedAt) / 1000);
    console.error(
      `[Supervisor] Swarm child exited after ${runtimeSec}s (code=${code ?? "none"}, signal=${signal ?? "none"}).`,
    );
    setTimeout(launch, Math.max(1000, RESTART_DELAY_MS));
  });
}

function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[Supervisor] ${signal}; stopping swarm child.`);
  if (child && !child.killed) child.kill("SIGTERM");
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
launch();

import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

test("separate OMP processes retain each other's session state", async () => {
  const tempRoot = mkdtempSync(path.join(import.meta.dir, "..", "temp", "cross-process-"));
  const piRoot = path.join(tempRoot, "pi-agent");
  const piSessions = path.join(tempRoot, "pi-sessions");
  const ompRoot = path.join(tempRoot, "omp", "agent");
  const sessionDir = path.join(ompRoot, "sessions", "--C--work-demo--");
  const barrierDir = path.join(tempRoot, "barrier");
  mkdirSync(piRoot, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(barrierDir, { recursive: true });
  writeFileSync(path.join(piRoot, "models.json"), JSON.stringify({ providers: {} }));
  writeFileSync(path.join(ompRoot, "omp-pi-bridge-state.json"), JSON.stringify({ version: 1, backfillDone: true, sessions: {} }));
  writeFileSync(path.join(ompRoot, "omp-pi-bridge-state.lock"), JSON.stringify({ pid: 2_147_483_647, token: "abandoned" }));
  writeFileSync(path.join(sessionDir, "bootstrap.jsonl"), JSON.stringify({ type: "session", version: 3, id: "bootstrap", timestamp: "2026-10-14T00:00:00.000Z", cwd: "C:\\work\\demo" }));

  const worker = path.join(import.meta.dir, "fixtures", "state-writer.ts");
  const runWriter = (sessionId: string) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [worker], {
      env: {
        ...process.env,
        OMP_PI_CONFIG_DIR: piRoot,
        PI_CODING_AGENT_SESSION_DIR: piSessions,
        BRIDGE_SESSION_ID: sessionId,
        BRIDGE_PROJECT_SESSION_DIR: sessionDir,
        BRIDGE_BARRIER_DIR: barrierDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });

  try {
    const results = await Promise.all([runWriter("writer-a"), runWriter("writer-b")]);
    expect(results.map((result) => result.code)).toEqual([0, 0]);
    expect(results.map((result) => result.output)).toEqual(["", ""]);
    const state = JSON.parse(readFileSync(path.join(ompRoot, "omp-pi-bridge-state.json"), "utf8"));
    expect(state.sessions).toHaveProperty("writer-a");
    expect(state.sessions).toHaveProperty("writer-b");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

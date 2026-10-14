import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import ompPiBridge from "../../src/index.ts";

const sessionId = process.env.BRIDGE_SESSION_ID!;
const sessionDir = process.env.BRIDGE_PROJECT_SESSION_DIR!;
const barrierDir = process.env.BRIDGE_BARRIER_DIR!;
const handlers = new Map<string, Function>();

ompPiBridge({
  registerProvider() {},
  on(name: string, handler: Function) { handlers.set(name, handler); },
});

function context(id: string, file: string) {
  const header = { id, timestamp: "2026-10-14T00:00:00.000Z", cwd: "C:\\work\\demo" };
  return {
    hasUI: true,
    ui: { select: async () => "同步完整对话与 Token 用量到 Pi" },
    cwd: header.cwd,
    modelRegistry: { getProviderModels: () => [], getAll: () => [] },
    sessionManager: {
      getHeader: () => header,
      getSessionId: () => id,
      getSessionDir: () => sessionDir,
      getSessionFile: () => file,
      getEntries: () => [{ type: "not-mirrored" }],
    },
  };
}

const start = handlers.get("session_start")!;
const bootstrapFile = path.join(sessionDir, "bootstrap.jsonl");
await start({}, context("bootstrap", bootstrapFile));
writeFileSync(path.join(barrierDir, `${sessionId}.ready`), "ready");

const deadline = Date.now() + 10000;
while (!existsSync(path.join(barrierDir, "writer-a.ready")) || !existsSync(path.join(barrierDir, "writer-b.ready"))) {
  if (Date.now() >= deadline) throw new Error("Timed out waiting for both OMP writers.");
  await new Promise((resolve) => setTimeout(resolve, 10));
}

const sessionFile = path.join(sessionDir, `${sessionId}.jsonl`);
mkdirSync(sessionDir, { recursive: true });
writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-10-14T00:00:00.000Z", cwd: "C:\\work\\demo" }));
await start({}, context(sessionId, sessionFile));

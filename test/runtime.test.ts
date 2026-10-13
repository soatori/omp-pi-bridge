import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getPiSessionPath, makePiSessionHeader } from "../src/bridge.ts";
import ompPiBridge from "../src/index.ts";

const tempRoot = mkdtempSync(path.join(import.meta.dir, "..", "temp", "runtime-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
const piAgentDir = path.join(tempRoot, "pi-agent");
const piSessionDir = path.join(tempRoot, "pi-sessions");
const ompAgentDir = path.join(tempRoot, "omp", "agent");
const ompSessionDir = path.join(ompAgentDir, "sessions", "--C--work-demo--");
const sourceSessionId = "session-live-1";

mkdirSync(piAgentDir, { recursive: true });
mkdirSync(ompSessionDir, { recursive: true });
writeFileSync(path.join(piAgentDir, "models.json"), JSON.stringify({ providers: {
  "cc-switch-test": {
    baseUrl: "https://api.example.invalid/v1",
    api: "openai-completions",
    apiKey: "$BRIDGE_TEST_KEY",
    models: [{ id: "test-model", name: "Test model", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 1024 }],
  },
} }));
writeFileSync(path.join(ompSessionDir, "2026-10-13T12-00-00.000Z_old-session.jsonl"), [
  JSON.stringify({ type: "title", title: "Old session" }).padEnd(256, " "),
  JSON.stringify({ type: "session", version: 3, id: "old-session", timestamp: "2026-10-13T12:00:00.000Z", cwd: "C:\\work\\demo", title: "Old session" }),
  JSON.stringify({ type: "message", id: "old-assistant", timestamp: "2026-10-13T12:00:01.000Z", message: { role: "assistant", provider: "cc-switch-test", model: "test-model", content: [{ type: "text", text: "private historical transcript" }], usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 6, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }),
  JSON.stringify({ type: "model_usage", id: "old-helper", timestamp: "2026-10-13T12:00:02.000Z", provider: "cc-switch-test", model: "test-model", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }),
].join("\n") + "\n");
process.env.PI_CODING_AGENT_DIR = piAgentDir;
process.env.PI_CODING_AGENT_SESSION_DIR = piSessionDir;

afterAll(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
  else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("OMP startup registers Pi providers and dialogue events mirror once into a Pi session", async () => {
  const handlers = new Map<string, Function>();
  const registrations: Array<{ id: string; config: Record<string, any> }> = [];
  const pi = {
    registerProvider(id: string, config: Record<string, any>) { registrations.push({ id, config }); },
    on(name: string, handler: Function) { handlers.set(name, handler); },
  };
  const entries: any[] = [];
  const header = { id: sourceSessionId, timestamp: "2026-10-14T00:00:00.000Z", cwd: "C:\\work\\demo", title: "Live test" };
  const sessionFile = path.join(ompSessionDir, "2026-10-14T00-00-00.000Z_session-live-1.jsonl");
  const target = getPiSessionPath({ piAgentDir, cwd: header.cwd, sessionId: sourceSessionId, timestamp: header.timestamp, env: { PI_CODING_AGENT_SESSION_DIR: piSessionDir } })!;
  mkdirSync(target.root, { recursive: true });
  writeFileSync(target.filePath, `${JSON.stringify(makePiSessionHeader(header))}\n{"type":"message","id":"torn"`);
  const ctx = {
    cwd: header.cwd,
    modelRegistry: { getProviderModels: () => [], getAll: () => [] },
    sessionManager: {
      getHeader: () => header,
      getSessionId: () => sourceSessionId,
      getSessionDir: () => ompSessionDir,
      getSessionFile: () => sessionFile,
      getRecordedCwd: () => header.cwd,
      getEntries: () => entries,
    },
  };

  ompPiBridge(pi);
  expect(registrations[0]).toMatchObject({ id: "cc-switch-test", config: { models: [{ id: "test-model" }] } });
  await handlers.get("session_start")?.({}, ctx);
  expect(registrations.at(-1)).toMatchObject({ id: "cc-switch-test", config: { apiKey: "BRIDGE_TEST_KEY" } });
  expect(registrations.at(-1)?.config.models.map((model: any) => model.id)).toEqual(["test-model"]);

  const userMessage = { role: "user", content: "question", timestamp: 1791936000000 };
  const answer = { role: "assistant", provider: "cc-switch-test", model: "test-model", content: [{ type: "text", text: "answer" }], timestamp: 1791936001000, usage: { input: 9, output: 5, cacheRead: 2, cacheWrite: 0, totalTokens: 16, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  await handlers.get("message_end")?.({ message: userMessage }, ctx);
  await handlers.get("message_end")?.({ message: answer }, ctx);
  entries.push(
    { type: "message", id: "omp-user", timestamp: "2026-10-14T00:00:00.100Z", message: userMessage },
    { type: "message", id: "omp-answer", timestamp: "2026-10-14T00:00:01.000Z", message: { ...answer, contextSnapshot: { tools: ["bash"] }, duration: 900, ttft: 150, completedAt: 1791936001200, errorId: "diag-test" } },
    { type: "model_usage", id: "omp-helper", timestamp: "2026-10-14T00:00:02.000Z", provider: "cc-switch-test", model: "test-model", usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
  );
  await handlers.get("turn_end")?.({}, ctx);

  const sessionFiles = awaitArrayFiles(piSessionDir);
  expect(sessionFiles).toHaveLength(2);
  const liveFile = sessionFiles.find((file) => readFileSync(file, "utf8").includes(sourceSessionId))!;
  const text = readFileSync(liveFile, "utf8");
  const rows = text.split(/\r?\n/).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  expect(rows[0]).toMatchObject({ type: "session", id: sourceSessionId, cwd: header.cwd });
  expect(rows.filter((row) => row.type === "message" && row.message.role === "user")).toHaveLength(1);
  expect(rows.filter((row) => row.type === "message" && row.message.role === "assistant" && row.message.usage)).toHaveLength(2);
  expect(text).toContain("question");
  expect(text).toContain("answer");
  expect(text).not.toContain("BRIDGE_TEST_KEY");
  expect(text).toContain('"id":"torn"');

  const historicalFile = sessionFiles.find((file) => readFileSync(file, "utf8").includes("old-session"))!;
  const historicalText = readFileSync(historicalFile, "utf8");
  const historicalRows = historicalText.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  expect(historicalRows.slice(1)).toHaveLength(2);
  expect(historicalRows.slice(1).every((row) => row.message?.content?.length === 0)).toBe(true);
  expect(historicalText).not.toContain("private historical transcript");
});

function awaitArrayFiles(root: string): string[] {
  return readdirSync(root).flatMap((name: string) => {
    const full = path.join(root, name);
    return statSync(full).isDirectory() ? awaitArrayFiles(full) : [full];
  });
}

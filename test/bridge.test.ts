import { expect, test } from "bun:test";
import {
  getPiSessionPath,
  mergeProviderModels,
  normalizePiApiKey,
  ompSessionAgentDir,
  parseOmpSession,
  toPiLiveEntry,
  toPiUsageEntries,
} from "../src/bridge.ts";

test("provider sync overlays Pi models and keeps unrelated OMP models", () => {
  const merged = mergeProviderModels(
    [
      { id: "shared", name: "OMP name", reasoning: false, input: ["text"], cost: { input: 2, output: 3, cacheRead: 1, cacheWrite: 1 }, contextWindow: 1000, maxTokens: 100 },
      { id: "omp-only", name: "OMP only", reasoning: false, input: ["text"], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 2000, maxTokens: 200 },
    ],
    [{ id: "shared", name: "Pi name", reasoning: true, input: ["text", "image"], contextWindow: 4000, maxTokens: 400 }, { id: "pi-only", name: "Pi only", reasoning: false, input: ["text"], contextWindow: 3000, maxTokens: 300 }],
    "openai-completions",
  );

  expect(merged.map((model) => model.id)).toEqual(["shared", "omp-only", "pi-only"]);
  expect(merged[0]).toMatchObject({ name: "Pi name", api: "openai-completions", reasoning: true, cost: { input: 2, output: 3 }, contextWindow: 4000 });
});

test("Pi API key syntax maps to OMP env and command syntax", () => {
  expect(normalizePiApiKey("$PI_TOKEN")).toBe("PI_TOKEN");
  expect(normalizePiApiKey("${PI_TOKEN}")).toBe("PI_TOKEN");
  expect(normalizePiApiKey("!powershell -NoProfile -Command 'Write-Output key'")).toBe("!powershell -NoProfile -Command 'Write-Output key'");
  expect(normalizePiApiKey("literal-key")).toBe("literal-key");
});

test("live conversation entries retain message content and usage", () => {
  const source = { type: "message", id: "omp-entry", parentId: null, timestamp: "2026-10-14T00:00:00.000Z", message: { role: "assistant", provider: "provider-a", model: "model-a", content: [{ type: "text", text: "answer" }], usage: { input: 11, output: 7, cacheRead: 3, cacheWrite: 0, totalTokens: 21, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } };
  const mapped = toPiLiveEntry(source, "session-1", null);

  expect(mapped).toMatchObject({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input: 11, output: 7 } } });
  expect(mapped?.id).toMatch(/^[a-f0-9]{16}$/);
  expect(mapped?.id).toBe(toPiUsageEntries([source], "session-1")[0]?.id);
  expect(toPiLiveEntry({ type: "message", message: { role: "system", content: "private system prompt" } }, "session-1", null)).toBeNull();
});

test("historical usage backfill omits transcript text and converts model_usage", () => {
  const rows = toPiUsageEntries([
    { type: "message", id: "assistant-1", timestamp: "2026-10-14T00:00:01.000Z", message: { role: "assistant", provider: "provider-a", model: "model-a", content: [{ type: "text", text: "private transcript" }], usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 0, totalTokens: 16, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } },
    { type: "model_usage", id: "usage-1", timestamp: "2026-10-14T00:00:02.000Z", provider: "provider-a", model: "model-a", usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 4, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
  ], "session-1");

  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ type: "message", message: { role: "assistant", provider: "provider-a", usage: { input: 10, output: 4 }, content: [] } });
  expect(JSON.stringify(rows)).not.toContain("private transcript");
  expect(rows[1]).toMatchObject({ type: "message", message: { role: "assistant", model: "model-a", usage: { input: 3, output: 1 }, content: [] } });
  expect(rows[1]?.id).toBe(toPiLiveEntry({ type: "model_usage", id: "usage-1", timestamp: "2026-10-14T00:00:02.000Z", provider: "provider-a", model: "model-a", usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 4 } }, "session-1", null)?.id);
});

test("OMP title slot is skipped when reading the session header", () => {
  const parsed = parseOmpSession([
    JSON.stringify({ type: "title", title: "OMP session" }).padEnd(256, " "),
    JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: "2026-10-14T00:00:00.000Z", cwd: "C:\\work", title: "work" }),
    JSON.stringify({ type: "message", id: "entry-1", parentId: null, timestamp: "2026-10-14T00:00:01.000Z", message: { role: "assistant", content: "ok" } }),
  ].join("\n"));

  expect(parsed.header).toMatchObject({ id: "session-1", cwd: "C:\\work" });
  expect(parsed.entries).toHaveLength(1);
});

test("Pi session files use project folders and honor an absolute custom sessionDir", () => {
  const standard = getPiSessionPath({ piAgentDir: "C:\\Users\\cbsjz\\.pi\\agent", cwd: "C:\\work\\demo", sessionId: "session-1", timestamp: "2026-10-14T00:00:00.000Z" });
  expect(standard.filePath).toContain("--C--work-demo--");
  expect(standard.filePath).toContain("session-1.jsonl");

  const custom = getPiSessionPath({ piAgentDir: "C:\\Users\\cbsjz\\.pi\\agent", cwd: "C:\\work", sessionId: "session-2", timestamp: "2026-10-14T00:00:00.000Z", settings: { sessionDir: "D:\\PiSessions" } });
  expect(custom.root).toBe("D:\\PiSessions");
  expect(custom.flat).toBe(true);
});

test("only OMP project session directories are mapped to an agent state directory", () => {
  expect(ompSessionAgentDir("C:\\Users\\cbsjz\\.omp\\agent\\sessions\\--C--work--")).toBe("C:\\Users\\cbsjz\\.omp\\agent");
  expect(ompSessionAgentDir("E:\\Develop\\omp-pi-bridge")).toBeNull();
});

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import ompPiBridge from "../src/index.ts";
import { getPiSessionPath } from "../src/bridge.ts";

const tempRoot = mkdtempSync(path.join(import.meta.dir, "..", "temp", "consent-"));
const previousPiConfigDir = process.env.OMP_PI_CONFIG_DIR;
const previousPiSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;

afterAll(() => {
  if (previousPiConfigDir === undefined) delete process.env.OMP_PI_CONFIG_DIR;
  else process.env.OMP_PI_CONFIG_DIR = previousPiConfigDir;
  if (previousPiSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
  else process.env.PI_CODING_AGENT_SESSION_DIR = previousPiSessionDir;
  rmSync(tempRoot, { recursive: true, force: true });
});

function setup(name: string, providers: Record<string, unknown> = {}) {
  const piRoot = path.join(tempRoot, name, "pi-agent");
  const piSessions = path.join(tempRoot, name, "pi-sessions");
  const ompRoot = path.join(tempRoot, name, "omp", "agent");
  const sessionDir = path.join(ompRoot, "sessions", "--C--work-demo--");
  const oldHeader = { id: `${name}-old`, timestamp: "2026-10-13T12:00:00.000Z", cwd: "C:\\work\\demo" };
  mkdirSync(piRoot, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(path.join(piRoot, "models.json"), JSON.stringify({ providers }));
  writeFileSync(path.join(sessionDir, "history.jsonl"), [
    JSON.stringify({ type: "session", version: 3, ...oldHeader }),
    JSON.stringify({ type: "message", id: "old-entry", timestamp: "2026-10-13T12:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "private old conversation" }], provider: "provider", model: "model", usage: { input: 4, output: 2 } } }),
  ].join("\n"));
  process.env.OMP_PI_CONFIG_DIR = piRoot;
  process.env.PI_CODING_AGENT_SESSION_DIR = piSessions;

  const handlers = new Map<string, Function>();
  ompPiBridge({ registerProvider() {}, on(name: string, handler: Function) { handlers.set(name, handler); } });
  const header = { id: `${name}-active`, timestamp: "2026-10-14T00:00:00.000Z", cwd: "C:\\work\\demo" };
  const ctx: any = {
    cwd: header.cwd,
    hasUI: true,
    ui: { select: async () => "本次跳过同步" },
    modelRegistry: { getProviderModels: () => [], getAll: () => [] },
    sessionManager: {
      getHeader: () => header,
      getSessionId: () => header.id,
      getSessionDir: () => sessionDir,
      getSessionFile: () => path.join(sessionDir, `${header.id}.jsonl`),
      getEntries: () => [],
    },
  };
  return { handlers, ctx, header, oldHeader, piRoot, piSessions, ompRoot };
}

test("an empty Pi provider config asks before starting any session sync", async () => {
  const fixture = setup("declined");
  const prompts: Array<[string, string[]]> = [];
  fixture.ctx.ui.select = async (title: string, options: string[]) => {
    prompts.push([title, options]);
    return options[0];
  };

  await fixture.handlers.get("session_start")?.({}, fixture.ctx);
  await fixture.handlers.get("turn_end")?.({}, fixture.ctx);

  expect(prompts).toHaveLength(1);
  expect(prompts[0][0]).toContain("Pi");
  expect(prompts[0][0]).toContain("Token");
  expect(prompts[0][1][0]).toBe("本次跳过同步");
  expect(existsSync(fixture.piSessions)).toBe(false);
  expect(existsSync(path.join(fixture.ompRoot, "omp-pi-bridge-state.json"))).toBe(false);
});

test("an empty Pi provider config syncs sessions only after confirmation", async () => {
  const fixture = setup("accepted");
  let promptCount = 0;
  fixture.ctx.ui.select = async (_title: string, options: string[]) => { promptCount++; return options[1]; };

  await fixture.handlers.get("session_start")?.({}, fixture.ctx);

  const target = getPiSessionPath({ piAgentDir: fixture.piRoot, cwd: fixture.oldHeader.cwd, sessionId: fixture.oldHeader.id, timestamp: fixture.oldHeader.timestamp, env: { PI_CODING_AGENT_SESSION_DIR: fixture.piSessions } })!;
  const rows = readFileSync(target.filePath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  expect(promptCount).toBe(1);
  expect(rows[1].message.content).toEqual([]);
  expect(rows[1].message.usage).toMatchObject({ input: 4, output: 2 });
});

test("empty Pi config skips mirroring when no confirmation UI exists", async () => {
  const fixture = setup("headless");
  fixture.ctx.hasUI = false;
  let promptCount = 0;
  fixture.ctx.ui.select = async () => { promptCount++; return "同步完整对话与 Token 用量到 Pi"; };

  await fixture.handlers.get("session_start")?.({}, fixture.ctx);

  expect(promptCount).toBe(0);
  expect(existsSync(fixture.piSessions)).toBe(false);
  expect(existsSync(path.join(fixture.ompRoot, "omp-pi-bridge-state.json"))).toBe(false);
});

test("configured Pi providers do not trigger the empty-config prompt", async () => {
  const fixture = setup("configured", {
    "pi-provider": { api: "openai-completions", baseUrl: "https://api.example.invalid/v1", models: [{ id: "test-model" }] },
  });
  let promptCount = 0;
  fixture.ctx.ui.select = async () => { promptCount++; return "本次跳过同步"; };

  await fixture.handlers.get("session_start")?.({}, fixture.ctx);

  expect(promptCount).toBe(0);
});

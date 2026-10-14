import { existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  getPiSessionPath,
  makePiSessionHeader,
  mergeProviderModels,
  ompSessionAgentDir,
  parseOmpSession,
  piProviderAgentDir,
  providerRuntimeConfig,
  toPiLiveEntry,
  toPiUsageEntries,
} from "./bridge.ts";

type Dict = Record<string, any>;
type SavedSession = {
  sourceFile?: string;
  sourceSize?: number;
  sourceMtimeMs?: number;
  cursor: number;
  targetFile: string;
  lastTargetEntryId: string | null;
};
type BridgeState = {
  version: 1;
  backfillDone: boolean;
  sessions: Record<string, SavedSession>;
};

type PiProvider = { id: string; data: Dict };
type SessionContext = { manager: any; sessionId: string; header: Dict; agentDir: string };

const startupByAgentDir = new Map<string, Promise<void>>();
const stateByAgentDir = new Map<string, BridgeState>();
const seenBySession = new Map<string, { ids: Set<string>; lastId: string | null; needsSeparator: boolean }>();
const sessionQueues = new Map<string, Promise<void>>();
const stateSaveQueues = new Map<string, Promise<void>>();
const sessionSyncConsentByAgentDir = new Map<string, Promise<boolean>>();
const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[omp-pi-bridge] ${message}`);
}

function errorDetail(error: unknown): string {
  if (!(error instanceof Error)) return "unknown error";
  const code = (error as Error & { code?: string }).code;
  return `${code ? `${code}: ` : ""}${error.message.slice(0, 240)}`;
}

function loadPiConfig(): { piAgentDir: string; providers: PiProvider[]; settings: Dict } {
  const piAgentDir = piProviderAgentDir();
  const modelsPath = path.join(piAgentDir, "models.json");
  const settingsPath = path.join(piAgentDir, "settings.json");
  let settings: Dict = {};
  let providers: PiProvider[] = [];

  try {
    if (existsSync(settingsPath)) {
      const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
      if (parsed && typeof parsed === "object") settings = parsed;
    }
  } catch {
    warnOnce(`settings:${settingsPath}`, "Pi settings.json could not be read; using the default sessions directory.");
  }

  try {
    if (!existsSync(modelsPath)) {
      warnOnce(`models:${modelsPath}`, "Pi models.json was not found; provider synchronization is skipped.");
      return { piAgentDir, providers, settings };
    }
    const parsed = JSON.parse(readFileSync(modelsPath, "utf8"));
    const raw = parsed?.providers;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      warnOnce(`providers:${modelsPath}`, "Pi models.json has no providers object; provider synchronization is skipped.");
      return { piAgentDir, providers, settings };
    }
    providers = Object.entries(raw).filter(([, value]) => value && typeof value === "object").map(([id, data]) => ({ id, data: data as Dict }));
  } catch {
    warnOnce(`models-parse:${modelsPath}`, "Pi models.json could not be parsed; provider synchronization is skipped.");
  }
  return { piAgentDir, providers, settings };
}

function initialState(): BridgeState {
  return { version: 1, backfillDone: false, sessions: {} };
}

async function getBridgeState(agentDir: string): Promise<BridgeState> {
  const cached = stateByAgentDir.get(agentDir);
  if (cached) return cached;
  const file = path.join(agentDir, "omp-pi-bridge-state.json");
  let state = initialState();
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    if (parsed?.version === 1 && parsed.sessions && typeof parsed.sessions === "object") {
      state = { version: 1, backfillDone: parsed.backfillDone === true, sessions: parsed.sessions };
    }
  } catch {
    // A missing or damaged cursor is recovered by stable entry IDs in the Pi files.
  }
  stateByAgentDir.set(agentDir, state);
  return state;
}

async function acquireBridgeStateLock(agentDir: string): Promise<() => Promise<void>> {
  const lockFile = path.join(agentDir, "omp-pi-bridge-state.lock");
  const deadline = Date.now() + 10_000;
  while (true) {
    const token = randomUUID();
    try {
      const handle = await fs.open(lockFile, "wx");
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token }), "utf8");
      } catch (writeError) {
        await handle.close();
        await fs.rm(lockFile, { force: true }).catch(() => {});
        throw writeError;
      }
      await handle.close();
      return async () => {
        try {
          const owner = JSON.parse(await fs.readFile(lockFile, "utf8"));
          if (owner.token === token) await fs.rm(lockFile, { force: true });
        } catch {
          // A stale-lock recovery may already have removed this lock.
        }
      };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      let stale = false;
      let observedToken: string | undefined;
      try {
        const owner = JSON.parse(await fs.readFile(lockFile, "utf8"));
        observedToken = owner.token;
        const age = Date.now() - (await fs.stat(lockFile)).mtimeMs;
        try {
          process.kill(Number(owner.pid), 0);
          stale = age > 120_000;
        } catch (processError: any) {
          stale = processError?.code === "ESRCH" || age > 120_000;
        }
      } catch {
        try {
          stale = Date.now() - (await fs.stat(lockFile)).mtimeMs > 5_000;
        } catch {
          continue;
        }
      }
      if (stale) {
        try {
          if (observedToken !== undefined) {
            const owner = JSON.parse(await fs.readFile(lockFile, "utf8"));
            if (owner.token !== observedToken) continue;
          }
          const staleFile = `${lockFile}.${randomUUID()}.stale`;
          await fs.rename(lockFile, staleFile);
          await fs.rm(staleFile, { force: true });
          continue;
        } catch (staleError: any) {
          if (staleError?.code === "ENOENT") continue;
          throw staleError;
        }
      }
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the OMP Pi bridge state lock.");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

async function mergeSavedState(agentDir: string, state: BridgeState): Promise<void> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(agentDir, "omp-pi-bridge-state.json"), "utf8"));
    if (parsed?.version !== 1 || !parsed.sessions || typeof parsed.sessions !== "object") return;
    state.backfillDone ||= parsed.backfillDone === true;
    for (const [sessionId, saved] of Object.entries(parsed.sessions) as Array<[string, SavedSession]>) {
      if (!saved || !Number.isFinite(saved.cursor)) continue;
      const current = state.sessions[sessionId];
      if (!current || saved.cursor > current.cursor || (saved.cursor === current.cursor && (saved.sourceMtimeMs ?? 0) > (current.sourceMtimeMs ?? 0))) {
        state.sessions[sessionId] = saved;
      }
    }
  } catch {
    // A missing or damaged state file is recovered by stable IDs in Pi sessions.
  }
}

async function saveBridgeState(agentDir: string, state: BridgeState): Promise<void> {
  const previous = stateSaveQueues.get(agentDir) ?? Promise.resolve();
  const current = previous.then(async () => {
    await fs.mkdir(agentDir, { recursive: true });
    const release = await acquireBridgeStateLock(agentDir);
    const file = path.join(agentDir, "omp-pi-bridge-state.json");
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mergeSavedState(agentDir, state);
      await fs.writeFile(temporary, JSON.stringify(state), "utf8");
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
      await release();
    }
  });
  stateSaveQueues.set(agentDir, current.catch(() => {}));
  await current;
}

async function walkJsonl(root: string): Promise<{ files: string[]; complete: boolean }> {
  const result: string[] = [];
  const pending = [root];
  let complete = true;
  while (pending.length) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error: any) {
      if (current !== root || error?.code !== "ENOENT") complete = false;
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) result.push(fullPath);
    }
  }
  return { files: result, complete };
}

async function readTargetIndex(file: string): Promise<{ ids: Set<string>; lastId: string | null; needsSeparator: boolean }> {
  const ids = new Set<string>();
  let lastId: string | null = null;
  let contents: string;
  try {
    contents = await fs.readFile(file, "utf8");
  } catch {
    return { ids, lastId, needsSeparator: false };
  }
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record?.type === "session") continue;
      if (typeof record?.id === "string") {
        ids.add(record.id);
        lastId = record.id;
      }
    } catch {
      // Ignore a torn final line; subsequent appends remain recoverable.
    }
  }
  return { ids, lastId, needsSeparator: contents.length > 0 && !/[\r\n]$/.test(contents) };
}

async function getSeen(agentDir: string, sessionId: string, targetFile: string, saved: SavedSession): Promise<{ ids: Set<string>; lastId: string | null; needsSeparator: boolean }> {
  const key = `${agentDir}\0${sessionId}\0${targetFile}`;
  let value = seenBySession.get(key);
  if (!value) {
    value = await readTargetIndex(targetFile);
    seenBySession.set(key, value);
  }
  saved.lastTargetEntryId = value.lastId;
  return value;
}

async function ensureTarget(target: { filePath: string; root: string }, header: Dict): Promise<void> {
  await fs.mkdir(target.root, { recursive: true });
  try {
    await fs.writeFile(target.filePath, `${JSON.stringify(makePiSessionHeader(header))}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
    const firstLine = (await fs.readFile(target.filePath, "utf8")).split(/\r?\n/, 1)[0];
    let existing: Dict;
    try {
      existing = JSON.parse(firstLine);
    } catch {
      throw new Error("Existing Pi mirror session has an invalid header.");
    }
    if (existing.type !== "session" || existing.id !== header.id) {
      throw new Error("Pi mirror session path belongs to another session.");
    }
  }
}

async function appendRecords(
  target: { filePath: string; root: string },
  header: Dict,
  records: Dict[],
  seen: { ids: Set<string>; lastId: string | null; needsSeparator: boolean },
): Promise<void> {
  const pending: Dict[] = [];
  let parentId = seen.lastId;
  for (const record of records) {
    if (!record || typeof record.id !== "string" || seen.ids.has(record.id)) continue;
    record.parentId = parentId;
    pending.push(record);
    parentId = record.id;
  }
  if (!pending.length) return;
  await ensureTarget(target, header);
  const separator = seen.needsSeparator ? "\n" : "";
  await fs.appendFile(target.filePath, `${separator}${pending.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  for (const record of pending) seen.ids.add(record.id);
  seen.lastId = pending[pending.length - 1].id;
  seen.needsSeparator = false;
}

function targetForSession(header: Dict, config: ReturnType<typeof loadPiConfig>) {
  return getPiSessionPath({
    piAgentDir: config.piAgentDir,
    cwd: String(header.cwd ?? ""),
    sessionId: String(header.id),
    timestamp: String(header.timestamp ?? ""),
    settings: config.settings,
    env: process.env,
  });
}

async function statSource(file: string | undefined): Promise<{ size?: number; mtimeMs?: number }> {
  if (!file) return {};
  try {
    const info = await fs.stat(file);
    return { size: info.size, mtimeMs: info.mtimeMs };
  } catch {
    return {};
  }
}

async function reconcileAllSessions(agentDir: string, config: ReturnType<typeof loadPiConfig>): Promise<void> {
  const state = await getBridgeState(agentDir);
  const root = path.join(agentDir, "sessions");
  const scan = await walkJsonl(root);
  let backfillComplete = scan.complete;
  const files = scan.files;
  for (const sourceFile of files) {
    const info = await statSource(sourceFile);
    const prior = Object.values(state.sessions).find((session) => session.sourceFile === sourceFile);
    if (state.backfillDone && prior && prior.sourceSize === info.size && prior.sourceMtimeMs === info.mtimeMs && prior.cursor >= 0) continue;
    let contents: string;
    try {
      contents = await fs.readFile(sourceFile, "utf8");
    } catch {
      backfillComplete = false;
      continue;
    }
    const parsed = parseOmpSession(contents);
    const header = parsed.header;
    if (!header || typeof header.id !== "string" || typeof header.cwd !== "string") {
      backfillComplete = false;
      continue;
    }
    const target = targetForSession(header, config);
    if (!target) {
      warnOnce("relative-session-dir", "Pi uses a relative sessionDir, which CC Switch cannot scan globally; session mirroring is skipped.");
      backfillComplete = false;
      continue;
    }
    const saved = state.sessions[header.id] ?? {
      sourceFile,
      cursor: 0,
      targetFile: target.filePath,
      lastTargetEntryId: null,
    };
    if (saved.targetFile !== target.filePath) {
      saved.targetFile = target.filePath;
      saved.lastTargetEntryId = null;
    }
    const seen = await getSeen(agentDir, header.id, target.filePath, saved);
    const cursor = Math.min(saved.cursor, parsed.entries.length);
    const historical = saved.cursor === 0 && (!state.backfillDone || !prior);
    for (let index = cursor; index < parsed.entries.length; index++) {
      const source = parsed.entries[index];
      const mapped = historical
        ? toPiUsageEntries([source], header.id)
        : [toPiLiveEntry(source, header.id, seen.lastId)].filter(Boolean) as Dict[];
      await appendRecords(target, header, mapped, seen);
    }
    saved.sourceFile = sourceFile;
    saved.sourceSize = info.size;
    saved.sourceMtimeMs = info.mtimeMs;
    saved.cursor = parsed.entries.length;
    saved.lastTargetEntryId = seen.lastId;
    state.sessions[header.id] = saved;
    await saveBridgeState(agentDir, state);
  }
  if (!state.backfillDone && backfillComplete) {
    state.backfillDone = true;
    await saveBridgeState(agentDir, state);
  }
}

function contextData(ctx: any): SessionContext | null {
  const manager = ctx.sessionManager;
  if (!manager || typeof manager.getSessionDir !== "function" || typeof manager.getSessionId !== "function") return null;
  const sessionDir = manager.getSessionDir();
  if (typeof sessionDir !== "string") return null;
  const agentDir = ompSessionAgentDir(sessionDir);
  if (!agentDir) return null;
  const original = manager.getHeader() ?? {};
  const sessionId = String(manager.getSessionId());
  const header = {
    ...original,
    id: String(original.id ?? sessionId),
    cwd: String(original.cwd ?? manager.getRecordedCwd?.() ?? ctx.cwd ?? ""),
    timestamp: original.timestamp ?? new Date().toISOString(),
  };
  return { manager, sessionId: header.id, header, agentDir };
}

function enqueueSession(agentDir: string, sessionId: string, task: () => Promise<void>): Promise<void> {
  const key = `${agentDir}\0${sessionId}`;
  const previous = sessionQueues.get(key) ?? Promise.resolve();
  const current = previous.then(task, task);
  sessionQueues.set(key, current.catch(() => {}));
  return current;
}

function ensureStartup(agentDir: string, config: ReturnType<typeof loadPiConfig>): Promise<void> {
  let pending = startupByAgentDir.get(agentDir);
  if (!pending) {
    pending = reconcileAllSessions(agentDir, config).catch((error) => {
      startupByAgentDir.delete(agentDir);
      warnOnce(`startup:${agentDir}`, `Existing OMP session sync failed (${errorDetail(error)}); the current OMP session will continue and retry on its next event or startup.`);
    });
    startupByAgentDir.set(agentDir, pending);
  }
  return pending;
}

function allowPiSessionSync(ctx: any, data: SessionContext, config: ReturnType<typeof loadPiConfig>): Promise<boolean> {
  if (config.providers.length) return Promise.resolve(true);
  const existing = sessionSyncConsentByAgentDir.get(data.agentDir);
  if (existing) return existing;
  if (ctx?.hasUI !== true || typeof ctx.ui?.select !== "function") {
    warnOnce(`empty-pi-config-no-ui:${data.agentDir}`, "Pi has no configured providers and this OMP session has no confirmation UI; Pi session mirroring is skipped.");
    return Promise.resolve(false);
  }

  const pending = Promise.resolve()
    .then(() => ctx.ui.select(
      "Pi 配置为空：要把 OMP 对话和 Token 用量写入 Pi 会话文件吗？",
      ["本次跳过同步", "同步完整对话与 Token 用量到 Pi"],
    ))
    .then((choice: unknown) => choice === "同步完整对话与 Token 用量到 Pi")
    .catch((error) => {
      warnOnce(`empty-pi-config-confirm:${data.agentDir}`, `Pi session mirroring was skipped because confirmation failed (${errorDetail(error)}).`);
      return false;
    });
  sessionSyncConsentByAgentDir.set(data.agentDir, pending);
  return pending;
}

async function initializeSession(data: SessionContext, config: ReturnType<typeof loadPiConfig>): Promise<void> {
  const { manager, sessionId, header, agentDir } = data;
  await ensureStartup(agentDir, config);
  const state = await getBridgeState(agentDir);
  const target = targetForSession(header, config);
  if (!target) return;
  const seen = await getSeen(agentDir, sessionId, target.filePath, state.sessions[sessionId] ?? {
    cursor: 0, targetFile: target.filePath, lastTargetEntryId: null,
  });
  const entries = manager.getEntries();
  let saved = state.sessions[sessionId];
  const historical = !saved;
  if (!saved) {
    saved = { cursor: 0, targetFile: target.filePath, lastTargetEntryId: seen.lastId };
    state.sessions[sessionId] = saved;
  }
  if (saved.targetFile !== target.filePath) saved.targetFile = target.filePath;
  const index = Math.min(saved.cursor, entries.length);
  for (let i = index; i < entries.length; i++) {
    const mapped = historical
      ? toPiUsageEntries([entries[i]], sessionId)
      : [toPiLiveEntry(entries[i], sessionId, seen.lastId)].filter(Boolean) as Dict[];
    await appendRecords(target, header, mapped, seen);
  }
  saved.cursor = entries.length;
  saved.lastTargetEntryId = seen.lastId;
  saved.sourceFile = manager.getSessionFile?.();
  const sourceInfo = await statSource(saved.sourceFile);
  saved.sourceSize = sourceInfo.size;
  saved.sourceMtimeMs = sourceInfo.mtimeMs;
  await saveBridgeState(agentDir, state);
}

async function syncManager(data: SessionContext, config: ReturnType<typeof loadPiConfig>): Promise<void> {
  const { manager, sessionId, header, agentDir } = data;
  await ensureStartup(agentDir, config);
  const state = await getBridgeState(agentDir);
  const target = targetForSession(header, config);
  if (!target) return;
  let saved = state.sessions[sessionId];
  const historical = !saved;
  if (!saved) {
    saved = { cursor: 0, targetFile: target.filePath, lastTargetEntryId: null };
    state.sessions[sessionId] = saved;
  }
  if (saved.targetFile !== target.filePath) {
    saved.targetFile = target.filePath;
    saved.lastTargetEntryId = null;
  }
  const seen = await getSeen(agentDir, sessionId, target.filePath, saved);
  const entries = manager.getEntries();
  const cursor = Math.min(saved.cursor, entries.length);
  for (let i = cursor; i < entries.length; i++) {
    const mapped = historical
      ? toPiUsageEntries([entries[i]], sessionId)
      : [toPiLiveEntry(entries[i], sessionId, seen.lastId)].filter(Boolean) as Dict[];
    await appendRecords(target, header, mapped, seen);
  }
  saved.cursor = entries.length;
  saved.lastTargetEntryId = seen.lastId;
  saved.sourceFile = manager.getSessionFile?.();
  const sourceInfo = await statSource(saved.sourceFile);
  saved.sourceSize = sourceInfo.size;
  saved.sourceMtimeMs = sourceInfo.mtimeMs;
  await saveBridgeState(agentDir, state);
}

function registerProviders(pi: any, ctx: any, providers: PiProvider[]): void {
  for (const provider of providers) {
    try {
      const base = ctx.modelRegistry.getProviderModels(provider.id);
      const catalog = ctx.modelRegistry.getAll("all");
      const models = mergeProviderModels(base, Array.isArray(provider.data.models) ? provider.data.models : [], provider.data.api, catalog);
      if (models.length) pi.registerProvider(provider.id, { ...providerRuntimeConfig(provider.data), models });
    } catch {
      warnOnce(`provider:${provider.id}`, `Pi provider '${provider.id}' could not be registered in OMP; other providers remain available.`);
    }
  }
}

export default function ompPiBridge(pi: any): void {
  const config = loadPiConfig();
  for (const provider of config.providers) {
    try {
      const customModels = provider.id.startsWith("cc-switch-")
        ? mergeProviderModels([], Array.isArray(provider.data.models) ? provider.data.models : [], provider.data.api)
        : [];
      pi.registerProvider(provider.id, {
        ...providerRuntimeConfig(provider.data),
        ...(customModels.length ? { models: customModels } : {}),
      });
    } catch {
      warnOnce(`provider-base:${provider.id}`, `Pi provider '${provider.id}' configuration was skipped by OMP.`);
    }
  }

  const withSession = (ctx: any, operation: (data: SessionContext) => Promise<void>) => {
    const data = contextData(ctx);
    if (!data) return Promise.resolve();
    return enqueueSession(data.agentDir, data.sessionId, async () => {
      if (!await allowPiSessionSync(ctx, data, config)) return;
      await ensureStartup(data.agentDir, config);
      await operation(data);
    }).catch((error) => {
      warnOnce(`write:${data.sessionId}`, `A Pi mirror write failed (${errorDetail(error)}); OMP will keep running and retry on a later session event.`);
    });
  };

  pi.on("session_start", async (_event: unknown, ctx: any) => {
    registerProviders(pi, ctx, config.providers);
    const data = contextData(ctx);
    if (!data) return;
    await withSession(ctx, (activeData) => initializeSession(activeData, config));
  });

  pi.on("message_end", async (event: any, ctx: any) => {
    await withSession(ctx, async (data) => {
      const state = await getBridgeState(data.agentDir);
      const target = targetForSession(data.header, config);
      if (!target) return;
      const saved = state.sessions[data.sessionId] ?? { cursor: 0, targetFile: target.filePath, lastTargetEntryId: null };
      if (saved.targetFile !== target.filePath) saved.targetFile = target.filePath;
      const seen = await getSeen(data.agentDir, data.sessionId, target.filePath, saved);
      const message = event?.message;
      const record = toPiLiveEntry({ type: "message", timestamp: message?.timestamp ?? new Date().toISOString(), message }, data.sessionId, seen.lastId);
      if (record) await appendRecords(target, data.header, [record], seen);
      saved.lastTargetEntryId = seen.lastId;
      state.sessions[data.sessionId] = saved;
      await saveBridgeState(data.agentDir, state);
    });
  });

  for (const eventName of ["turn_start", "turn_end", "session_shutdown"]) {
    pi.on(eventName, async (_event: unknown, ctx: any) => {
      await withSession(ctx, (data) => syncManager(data, config));
    });
  }
}

import { createHash } from "node:crypto";
import path from "node:path";

type Dict = Record<string, any>;

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function isObject(value: unknown): value is Dict {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function copyJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!isObject(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

export function stableEntryId(sessionId: string, sourceId: string, kind: string): string {
  return createHash("sha256").update(`${sessionId}\0${kind}\0${sourceId}`).digest("hex").slice(0, 16);
}

export function messageEntryId(sessionId: string, message: unknown): string {
  if (!isObject(message)) return stableEntryId(sessionId, canonical(message), "live-message");
  const identity: Dict = {};
  for (const key of ["role", "api", "provider", "model", "responseModel", "responseId", "content", "usage", "stopReason", "errorMessage", "toolCallId", "toolName", "isError", "timestamp"]) {
    if (message[key] !== undefined) identity[key] = message[key];
  }
  return stableEntryId(sessionId, canonical(identity), "live-message");
}

export function normalizePiApiKey(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (value.startsWith("!")) return value;
  const braced = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  if (braced) return braced[1];
  const plain = value.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
  if (plain) return plain[1];
  return value;
}

export function providerRuntimeConfig(provider: Dict): Dict {
  const config: Dict = {};
  for (const key of ["baseUrl", "api", "headers", "compat", "authHeader"]) {
    if (provider[key] !== undefined) config[key] = provider[key];
  }
  const apiKey = normalizePiApiKey(provider.apiKey);
  if (apiKey !== undefined) config.apiKey = apiKey;
  return config;
}

function modelCost(model: Dict, fallback?: Dict): Dict {
  const candidate = isObject(model.cost) ? model.cost : fallback?.cost;
  if (!isObject(candidate)) return { ...ZERO_COST };
  return {
    input: finite(candidate.input) ? candidate.input : 0,
    output: finite(candidate.output) ? candidate.output : 0,
    cacheRead: finite(candidate.cacheRead) ? candidate.cacheRead : 0,
    cacheWrite: finite(candidate.cacheWrite) ? candidate.cacheWrite : 0,
  };
}

function positiveInt(value: unknown, fallback: number): number {
  return finite(value) && value > 0 ? Math.floor(value) : fallback;
}

function normalizedInput(model: Dict, fallback?: Dict): string[] {
  const supported = Array.isArray(model.input)
    ? model.input.filter((item: unknown) => item === "text" || item === "image")
    : [];
  if (supported.length) return [...new Set(supported)];
  if (Array.isArray(fallback?.input) && fallback.input.length) return [...fallback.input];
  return ["text"];
}

function asProviderModel(model: Dict, providerApi?: string, fallback?: Dict): Dict {
  const result: Dict = {
    id: String(model.id),
    name: typeof model.name === "string" && model.name ? model.name : fallback?.name ?? String(model.id),
    api: typeof model.api === "string" ? model.api : providerApi ?? fallback?.api,
    reasoning: typeof model.reasoning === "boolean" ? model.reasoning : Boolean(fallback?.reasoning),
    input: normalizedInput(model, fallback),
    cost: modelCost(model, fallback),
    contextWindow: positiveInt(model.contextWindow, positiveInt(fallback?.contextWindow, 128000)),
    maxTokens: positiveInt(model.maxTokens, positiveInt(fallback?.maxTokens, 8192)),
  };
  for (const key of ["kind", "thinking", "preferWebsockets", "headers", "compat"]) {
    if (model[key] !== undefined) result[key] = model[key];
    else if (fallback?.[key] !== undefined) result[key] = fallback[key];
  }
  return result;
}

export function mergeProviderModels(
  baseModels: Dict[],
  piModels: Dict[],
  providerApi?: string,
  catalogModels: Dict[] = [],
): Dict[] {
  const catalogById = new Map<string, Dict>();
  for (const model of [...catalogModels, ...baseModels]) {
    if (typeof model.id === "string") catalogById.set(model.id, model);
  }
  const merged = new Map<string, Dict>();
  for (const model of baseModels) {
    if (typeof model.id === "string") merged.set(model.id, asProviderModel(model, providerApi));
  }
  for (const model of piModels) {
    if (!isObject(model) || typeof model.id !== "string" || !model.id) continue;
    const fallback = merged.get(model.id) ?? catalogById.get(model.id);
    merged.set(model.id, asProviderModel(model, providerApi, fallback));
  }
  return [...merged.values()];
}

function timestamp(value: unknown, fallback = new Date().toISOString()): string {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return fallback;
}

function hasUsage(value: unknown): value is Dict {
  return isObject(value);
}

function usageMessage(entry: Dict, sessionId: string, parentId: string | null, sourceIndex: number): Dict | null {
  const sourceType = entry.type;
  const sourceId = typeof entry.id === "string" ? entry.id : String(sourceIndex);
  const usage = sourceType === "message" ? entry.message?.usage : entry.usage;
  if (!hasUsage(usage)) return null;

  if (sourceType === "message") {
    const source = entry.message;
    if (!isObject(source) || !["assistant", "toolResult"].includes(source.role)) return null;
    const message: Dict = { role: source.role, content: [], usage: copyJson(usage) };
    for (const key of ["api", "provider", "model", "responseModel", "responseId", "stopReason", "errorMessage", "toolCallId", "toolName", "isError", "timestamp"]) {
      if (source[key] !== undefined) message[key] = copyJson(source[key]);
    }
    return {
      type: "message",
      id: messageEntryId(sessionId, source),
      parentId,
      timestamp: timestamp(entry.timestamp, timestamp(source.timestamp)),
      message,
    };
  }

  if (sourceType === "model_usage") {
    const message: Dict = { role: "assistant", content: [], usage: copyJson(usage) };
    for (const key of ["api", "provider", "model", "stopReason", "errorMessage"]) {
      if (entry[key] !== undefined) message[key] = copyJson(entry[key]);
    }
    message.timestamp = Date.parse(timestamp(entry.timestamp));
    return {
      type: "message",
      id: stableEntryId(sessionId, sourceId, "live-model_usage"),
      parentId,
      timestamp: timestamp(entry.timestamp),
      message,
    };
  }

  if (sourceType === "compaction" || sourceType === "branch_summary") {
    const id = stableEntryId(sessionId, sourceId, `live-${sourceType}`);
    return {
      type: sourceType,
      id,
      parentId,
      timestamp: timestamp(entry.timestamp),
      usage: copyJson(usage),
      ...(sourceType === "compaction" ? { firstKeptEntryId: id } : { fromId: parentId ?? "root" }),
    };
  }
  return null;
}

export function toPiUsageEntries(entries: Dict[], sessionId: string): Dict[] {
  const result: Dict[] = [];
  let parentId: string | null = null;
  entries.forEach((entry, index) => {
    const mapped = usageMessage(entry, sessionId, parentId, index);
    if (!mapped) return;
    result.push(mapped);
    parentId = mapped.id;
  });
  return result;
}

export function toPiLiveEntry(entry: Dict, sessionId: string, parentId: string | null): Dict | null {
  if (entry.type === "message") {
    if (!isObject(entry.message) || !["user", "assistant", "toolResult", "bashExecution", "pythonExecution"].includes(entry.message.role)) return null;
    return {
      type: "message",
      id: messageEntryId(sessionId, entry.message),
      parentId,
      timestamp: timestamp(entry.timestamp, timestamp(entry.message.timestamp)),
      message: copyJson(entry.message),
    };
  }

  const sourceId = typeof entry.id === "string" ? entry.id : canonical(entry);
  const id = stableEntryId(sessionId, sourceId, `live-${entry.type}`);
  const common = { id, parentId, timestamp: timestamp(entry.timestamp) };

  if (entry.type === "model_usage") {
    const mapped = usageMessage(entry, sessionId, parentId, 0);
    if (!mapped) return null;
    mapped.id = id;
    return mapped;
  }

  if (entry.type === "compaction") {
    return {
      type: "compaction",
      ...common,
      summary: entry.summary ?? "",
      firstKeptEntryId: id,
      ...(entry.shortSummary !== undefined ? { shortSummary: entry.shortSummary } : {}),
      ...(entry.tokensBefore !== undefined ? { tokensBefore: entry.tokensBefore } : {}),
      ...(entry.tokensAfter !== undefined ? { tokensAfter: entry.tokensAfter } : {}),
      ...(hasUsage(entry.usage) ? { usage: copyJson(entry.usage) } : {}),
    };
  }

  if (entry.type === "branch_summary") {
    return {
      type: "branch_summary",
      ...common,
      fromId: parentId ?? "root",
      summary: entry.summary ?? "",
      ...(hasUsage(entry.usage) ? { usage: copyJson(entry.usage) } : {}),
    };
  }

  if (entry.type === "custom_message") {
    return { ...copyJson(entry), ...common };
  }

  return null;
}

export function parseOmpSession(contents: string): { header: Dict | null; entries: Dict[] } {
  let header: Dict | null = null;
  const entries: Dict[] = [];
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(value)) continue;
    if (value.type === "title") continue;
    if (!header) {
      if (value.type === "session") header = value;
      continue;
    }
    entries.push(value);
  }
  return { header, entries };
}

export function encodePiCwd(cwd: string): string {
  const normalized = cwd.replace(/^[\\/]+/, "").replace(/[\\/:]/g, "-").replace(/-+$/, "");
  return `--${normalized}--`;
}

function pathApi(value: string) {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\") ? path.win32 : path;
}

function expandHome(value: string, home: string, api: typeof path) {
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) return api.join(home, value.slice(2));
  return value;
}

export function getPiSessionPath(input: {
  piAgentDir: string;
  cwd: string;
  sessionId: string;
  timestamp?: string;
  settings?: Dict;
  env?: Dict;
  home?: string;
}): { root: string; filePath: string; flat: boolean } | null {
  const pathLike = input.env?.PI_CODING_AGENT_SESSION_DIR || input.settings?.sessionDir;
  const api = pathApi(pathLike || input.piAgentDir);
  const home = input.home ?? (process.env.USERPROFILE || process.env.HOME || "");
  let root: string;
  let flat = false;
  if (typeof pathLike === "string" && pathLike.trim()) {
    const expanded = expandHome(pathLike.trim(), home, api);
    if (!api.isAbsolute(expanded)) return null;
    root = api.resolve(expanded);
    flat = true;
  } else {
    const rootApi = pathApi(input.piAgentDir);
    root = rootApi.join(input.piAgentDir, "sessions", encodePiCwd(input.cwd));
  }
  const date = new Date(timestamp(input.timestamp));
  const stamp = date.toISOString().replace(/[:.]/g, "-");
  const id = input.sessionId.replace(/[^A-Za-z0-9_.-]/g, "-");
  return { root, filePath: api.join(root, `${stamp}_${id}.jsonl`), flat };
}

export function makePiSessionHeader(source: Dict): Dict {
  const title = typeof source.title === "string" && source.title.trim() ? source.title.trim() : source.cwd;
  return {
    type: "session",
    version: 3,
    id: String(source.id),
    timestamp: timestamp(source.timestamp),
    cwd: String(source.cwd ?? ""),
    title: `OMP mirror · ${title}`,
  };
}

export function piProviderAgentDir(env: Dict = process.env, home = process.env.USERPROFILE || process.env.HOME || "") {
  const custom = env.PI_CODING_AGENT_DIR;
  if (typeof custom === "string" && custom.trim()) return pathApi(custom).resolve(custom);
  return path.join(home, ".pi", "agent");
}

export function ompSessionAgentDir(sessionDir: string): string | null {
  const api = pathApi(sessionDir);
  const projectSessionDir = api.resolve(sessionDir);
  const sessionsRoot = api.dirname(projectSessionDir);
  if (api.basename(sessionsRoot).toLowerCase() !== "sessions") return null;
  return api.dirname(sessionsRoot);
}

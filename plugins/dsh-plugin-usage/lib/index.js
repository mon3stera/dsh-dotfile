/**
 * dsh-plugin-usage: token-usage dashboard for DSH Web sessions.
 *
 * The host half reads session logs offline and serves usage facts:
 *
 *   GET /usage/overview?cwd=<abs path>   one summary row per session of one
 *                                        workspace (omit cwd for every
 *                                        project directory)
 *   GET /usage/session?id=<session id>   full detail for one session: exact
 *                                        per-request rows, aggregates, and
 *                                        the estimated composition
 *   &cwd= narrows the lookup to one project directory
 *
 * Everything derives from the committed log, so the numbers match what the
 * provider billed: `assistant/message` events carry the exact usage
 * (`inputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `outputTokens`),
 * `request/header` carries the assembled system prompt and tool definitions,
 * and message events carry the conversation material for the composition
 * estimate. The composition is an estimate (CJK-aware character heuristic,
 * normalized to the last request's exact total); all of the per-request and
 * cumulative numbers are exact.
 *
 * Logs are decompressed through the `zstd` CLI because DSH writes many
 * concatenated frames per log, which the one-shot zlib zstd functions do not
 * decode. Parsed results are cached per log path and invalidated by
 * (mtimeMs, size), so a live session re-reads only when its log grows.
 *
 * One session can carry several logs: a format migration materialises the
 * rewritten log beside the original as `session.v<version>.jsonl.zstd`, leaving
 * `session.jsonl.zstd` frozen at the migration point. Every lookup here
 * resolves the HIGHEST generation present — the older file would report a
 * truncated session and pre-migration accounting.
 *
 * @module dsh-plugin-usage
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { collectUsage, parseLog, summarizeUsage } from "./collect.js";

export const name = "dsh-plugin-usage";

const SESSION_ID_PATTERN = /^session-[0-9a-fA-F-]{8,}$/;
const LOG_NAME = "session.jsonl.zstd";
const CACHE_LIMIT = 64;

/** Sessions root for the deployment. */
export function sessionsRoot() {
  return join(resolveDshHome(), "sessions");
}

/**
 * The current log of one session directory: the highest format generation
 * present (`session.v3.jsonl.zstd` beats `session.jsonl.zstd`).
 * @param dir - session directory.
 * @returns the absolute log path, or null when the directory has no log.
 */
export function currentLogPath(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  let best = null;
  let generation = -1;
  for (const name of entries) {
    const match = /^session\.v(\d+)\.jsonl\.zstd$/.exec(name);
    const value = match === null ? (name === LOG_NAME ? 0 : -1) : Number(match[1]);
    if (value > generation) {
      generation = value;
      best = join(dir, name);
    }
  }
  return best;
}

/** Decompress a (possibly multi-frame) zstd log via the CLI.
 *
 * The plaintext goes through a temporary file: piping hundreds of megabytes
 * through spawnSync's stdout buffer is unreliable (ENOBUFS).
 */
function decompressLog(path) {
  const dst = join(tmpdir(), `dsh-plugin-usage-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    execFileSync("zstd", ["-dc", "-o", dst, path], { maxBuffer: 1024 * 1024 });
    return readFileSync(dst);
  } finally {
    try { unlinkSync(dst); } catch { /* already gone */ }
  }
}

/**
 * Parsed-log cache keyed by absolute path. A live session appends to its log
 * between requests, so the entry stores the stat pair it was built from and
 * re-parses whenever either value moves.
 */
const parsedCache = new Map();

function loadLog(path) {
  const stat = statSync(path);
  const cached = parsedCache.get(path);
  if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.value;

  const text = decompressLog(path).toString("utf8");
  const { header, rows } = parseLog(text);
  const collected = collectUsage(rows, header);
  const value = { header, collected };
  const entry = { mtimeMs: stat.mtimeMs, size: stat.size, value };
  parsedCache.delete(path);
  parsedCache.set(path, entry);
  if (parsedCache.size > CACHE_LIMIT) {
    const oldest = parsedCache.keys().next().value;
    parsedCache.delete(oldest);
  }
  return value;
}

/** Absolute log path for one session, or null when absent. */
export function sessionLogPath(cwd, sessionId) {
  if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) return null;
  const dir = cwd ? join(sessionsRoot(), projectKey(cwd)) : sessionsRoot();
  const direct = currentLogPath(join(dir, sessionId));
  if (direct !== null) return direct;

  // Session directories may be encoded differently by the storage backend;
  // scan one level when the plain name is absent.
  if (cwd) {
    try {
      for (const entry of readdirSync(dir)) {
        const candidate = currentLogPath(join(dir, entry, sessionId));
        if (candidate !== null) return candidate;
      }
    } catch {
      return null;
    }
  }
  return null;
}

/** Locate one session's log by searching every project directory. */
function findSessionLogEverywhere(sessionId) {
  if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) return null;
  for (const entry of readdirSync(sessionsRoot())) {
    const candidate = currentLogPath(join(sessionsRoot(), entry, sessionId));
    if (candidate !== null) return candidate;
  }
  return null;
}

/** Map a workspace path to its sessions project directory name. */
function projectKey(cwd) {
  return "--" + cwd.split("/").filter(Boolean).join("-") + "--";
}

/** Every project directory under the sessions root. */
function projectDirs() {
  try {
    return readdirSync(sessionsRoot());
  } catch {
    return [];
  }
}

/**
 * Summarize every session of one project directory (or every directory).
 * Only summary facts are returned; use /usage/session for the full rows.
 */
export function overviewSessions(cwd) {
  const dirs = cwd ? [projectKey(cwd)] : projectDirs();
  const sessions = [];

  for (const dir of dirs) {
    let entries;
    try {
      entries = readdirSync(join(sessionsRoot(), dir));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = currentLogPath(join(sessionsRoot(), dir, entry));
      if (path === null) continue;
      try {
        const { header, collected } = loadLog(path);
        const meta = { projectDir: dir, sizeBytes: statSync(path).size };
        sessions.push(summarizeUsage(collected, header, meta));
      } catch {
        // A half-written or unreadable log yields no row rather than failing
        // the whole overview.
      }
    }
  }

  sessions.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
  return sessions;
}

/** Full usage detail for one session, or null when the log is missing. */
export function sessionDetail(cwd, sessionId) {
  const path = sessionLogPath(cwd, sessionId) ?? findSessionLogEverywhere(sessionId);
  if (path === null) return null;
  const { header, collected } = loadLog(path);
  return {
    sessionId: header?.id ?? sessionId,
    createdAt: header?.createdAt ?? null,
    agentPreset: header?.agentPreset ?? null,
    cwd: header?.cwd ?? null,
    path,
    sizeBytes: statSync(path).size,
    ...collected
  };
}

/** End a JSON response. */
function writeJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

/**
 * GET /usage/overview - one summary row per session, optionally narrowed to
 * one workspace with ?cwd=<abs path>.
 */
async function handleOverview(req, res) {
  const url = new URL(req.url ?? "/", "http://x");
  const cwd = url.searchParams.get("cwd") ?? "";
  const sessions = overviewSessions(cwd || undefined);
  writeJson(res, 200, { ok: true, sessions });
}

/**
 * GET /usage/session?id=<session id>&cwd=<abs path> - full detail for one
 * session.
 */
async function handleSession(req, res) {
  const url = new URL(req.url ?? "/", "http://x");
  const id = url.searchParams.get("id") ?? "";
  const cwd = url.searchParams.get("cwd") ?? "";
  const detail = sessionDetail(cwd || undefined, id);
  if (detail === null) {
    writeJson(res, 404, { error: `no session log for "${id}"` });
    return;
  }
  writeJson(res, 200, { ok: true, ...detail });
}

/**
 * Cordis plugin entry. Registers the overview / session routes when the
 * optional Host HTTP service is composed.
 */
export function apply(ctx) {
  ctx.inject(["webServer"], (httpCtx) => {
    const routes = [
      ["/usage/overview", handleOverview],
      ["/usage/session", handleSession]
    ];

    for (const [path, handler] of routes) {
      httpCtx.effect(() => httpCtx.webServer.register({ kind: "exact", path, handler }), `dsh-plugin-usage: ${path}`);
    }
  });
}

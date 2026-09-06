/**
 * dsh-plugin-session-repair: offline repair for session logs whose event
 * sequence numbering collided (backward seq gap in the committed region).
 *
 * The corruption is produced by a harness-side race: a turn is interrupted
 * while a tool call is pending, the interrupt persists a synthetic
 * `interrupted-tool-result` batch, and the original session object later
 * commits the real tool result with its pre-interrupt event counter. The
 * persistence reader then fails closed with
 * "corrupt session log: seq gap in committed region".
 *
 * Routes (registered when the optional Host HTTP service is composed):
 *
 *   GET  /session-repair/scan?cwd=<abs path>   scan one workspace's sessions
 *                                              (omit cwd to scan every
 *                                              project directory)
 *   POST /session-repair/repair                {cwd?, sessionId, dryRun?}
 *   POST /session-repair/restore               {cwd?, sessionId} restore the
 *                                              newest .bak-<ts> backup
 *
 * The log is rewritten with the fixed pattern in lib/repair.js. The original
 * file is kept beside the log as `session.jsonl.zstd.bak-<unix-ms>` before any
 * write; repair is atomic (temporary file plus rename).
 *
 * The zstd codec is the `zstd` CLI: DSH writes session logs as many
 * concatenated frames (one per append batch), which the one-shot zlib zstd
 * functions do not decode.
 *
 * @module dsh-plugin-session-repair
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { encodeSegment, parseLog, projectKey, repairRows, scanRows, serializeLog } from "./repair.js";

export const name = "dsh-plugin-session-repair";

const SESSION_ID_PATTERN = /^session-[0-9a-fA-F-]{8,}$/;
const LOG_NAME = "session.jsonl.zstd";

/** Sessions root for the deployment. */
export function sessionsRoot() {
  return join(resolveDshHome(), "sessions");
}

/** Decompress a (possibly multi-frame) zstd log via the CLI.
 *
 * The plaintext goes through a temporary file: piping hundreds of megabytes
 * through spawnSync's stdout buffer is unreliable (ENOBUFS) and the largest
 * real logs decompress to several hundred megabytes.
 */
function decompressLog(path) {
  const dst = join(tmpdir(), `dsh-session-repair-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    execFileSync("zstd", ["-dc", "-o", dst, path], { maxBuffer: 1024 * 1024 });
    return readFileSync(dst);
  } finally {
    try { unlinkSync(dst); } catch { /* already gone */ }
  }
}

/** Compress one JSONL text into a valid session-log container via the CLI.
 *
 * DSH's reader asserts that the first frame decodes to exactly the header
 * line (`assertZstdHeaderFrame`), so the rewritten file must keep that
 * framing: frame 1 = the header line, frame 2 = every event row. Each frame
 * compresses through a temporary file because spawnSync's input pipe fails
 * with ENOBUFS on the multi-hundred-megabyte logs this repair handles.
 */
function compressLog(text) {
  const headerEnd = text.indexOf("\n");
  if (headerEnd === -1) throw new Error("log has no header line");
  const frame = (plaintext) => {
    const src = join(tmpdir(), `dsh-session-repair-${process.pid}-${randomBytes(4).toString("hex")}`);
    const dst = `${src}.zst`;
    try {
      writeFileSync(src, plaintext);
      execFileSync("zstd", ["-q", "-3", "-f", "-o", dst, src], { maxBuffer: 1024 * 1024 });
      return readFileSync(dst);
    } finally {
      try { unlinkSync(src); } catch { /* already gone */ }
      try { unlinkSync(dst); } catch { /* already gone */ }
    }
  };

  const headerFrame = frame(text.slice(0, headerEnd + 1));
  const eventFrame = frame(text.slice(headerEnd + 1));
  return Buffer.concat([headerFrame, eventFrame]);
}

/** Absolute log path for one session, or null when the directory is absent. */
export function sessionLogPath(cwd, sessionId) {
  if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) return null;
  const dir = cwd === undefined || cwd === null || cwd === ""
    ? sessionsRoot()
    : join(sessionsRoot(), projectKey(cwd));
  const path = join(dir, encodeSegment(sessionId), LOG_NAME);
  return existsSync(path) ? path : null;
}

/** Locate one session's log by searching every project directory. */
function findSessionLogEverywhere(sessionId) {
  if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) return null;
  for (const entry of readdirSync(sessionsRoot())) {
    const candidate = join(sessionsRoot(), entry, encodeSegment(sessionId), LOG_NAME);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Backups of one log, newest first. */
function listBackups(path) {
  const dir = path.slice(0, path.lastIndexOf("/"));
  const prefix = LOG_NAME + ".bak-";
  return readdirSync(dir)
    .filter((name) => name.startsWith(prefix))
    .sort()
    .reverse()
    .map((name) => join(dir, name));
}

/**
 * Scan one log file. Decompresses and applies the exact contiguity scan, so
 * this is O(log size); a full-workspace scan reads every log once.
 */
export function scanSessionFile(path) {
  const stat = statSync(path);
  const parsed = parseLog(decompressLog(path).toString("utf8"));
  const scan = scanRows(parsed.rows);
  const gap = scan.gap;
  const session = { sessionId: parsed.header?.id ?? null, sizeBytes: stat.size, mtimeMs: stat.mtimeMs, events: scan.events, lastSeq: scan.lastSeq, corrupted: !scan.ok, gap: null, hasSyntheticBatch: false, backups: listBackups(path) };

  if (gap !== null && gap.got !== null) {
    session.gap = { expected: gap.expected, got: gap.got, row: gap.index };
    // Cheap lookahead for the fixed pattern's synthetic batch marker.
    session.hasSyntheticBatch = parsed.rows.slice(Math.max(0, gap.index - 32), gap.index)
      .some((row) => typeof row.obj?.data?.message?.id === "string" && row.obj.data.message.id.startsWith("interrupted-tool-result-"));
  } else if (gap !== null) {
    session.gap = { expected: gap.expected, got: null, row: gap.index };
  }
  return session;
}

/** Scan one workspace directory (or every project directory when omitted). */
export function scanWorkspaces(cwd) {
  const root = sessionsRoot();
  const dirs = cwd === undefined || cwd === null || cwd === ""
    ? readdirSync(root)
    : [projectKey(cwd)];

  const sessions = [];
  const healthy = [];
  for (const dir of dirs) {
    let entries;
    try {
      entries = readdirSync(join(root, dir));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(root, dir, entry, LOG_NAME);
      if (!existsSync(path)) continue;
      try {
        const info = scanSessionFile(path);
        info.projectDir = dir;
        (info.corrupted ? sessions : healthy).push(info);
      } catch (error) {
        sessions.push({ sessionId: entry, projectDir: dir, corrupted: true, error: String(error?.message ?? error), backups: [] });
      }
    }
  }
  return { sessions, healthyCount: healthy.length };
}

/** End a JSON response. */
function writeJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

/** Read a JSON request body up to 1 MiB. */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) return null;
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * GET /session-repair/scan - scan one workspace (?cwd=<abs path>, empty to
 * scan every project directory) and report corrupted logs plus repair plans.
 */
async function handleScan(req, res) {
  const url = new URL(req.url ?? "/", "http://x");
  const cwd = url.searchParams.get("cwd") ?? "";
  const started = Date.now();
  const { sessions, healthyCount } = scanWorkspaces(cwd || undefined);
  writeJson(res, 200, { ok: true, scannedInMs: Date.now() - started, healthyCount, sessions });
}

/**
 * POST /session-repair/repair - repair one corrupted log. Body:
 * {cwd?, sessionId, dryRun?}. With dryRun the repaired text is built and
 * verified but nothing is written.
 */
async function handleRepair(req, res) {
  const body = await readJsonBody(req);
  if (body === null) {
    writeJson(res, 400, { error: "invalid JSON body" });
    return;
  }
  const { cwd, sessionId, dryRun } = body;
  const path = sessionLogPath(cwd, sessionId) ?? findSessionLogEverywhere(sessionId);
  if (path === null) {
    writeJson(res, 404, { error: `no session log for "${sessionId}"` });
    return;
  }

  let parsed;
  try {
    parsed = parseLog(decompressLog(path).toString("utf8"));
  } catch (error) {
    writeJson(res, 500, { error: `decompress failed: ${error?.message ?? error}` });
    return;
  }

  const before = scanRows(parsed.rows);
  if (before.ok) {
    writeJson(res, 409, { error: "session log is not corrupted" });
    return;
  }

  const repaired = repairRows(parsed);
  if (!repaired.ok) {
    writeJson(res, 422, { error: repaired.error, gap: before.gap });
    return;
  }

  const summary = {
    ok: true,
    dryRun: dryRun === true,
    sessionId,
    path,
    gap: { expected: before.gap.expected, got: before.gap.got },
    passes: repaired.passes,
    eventsBefore: before.events,
    eventsAfter: repaired.scan.events,
    lastSeq: repaired.scan.lastSeq,
    backups: listBackups(path)
  };
  if (summary.dryRun) {
    writeJson(res, 200, summary);
    return;
  }

  const backupPath = `${path}.bak-${Date.now()}`;
  copyFileSync(path, backupPath);
  summary.backup = backupPath;

  const tmpPath = `${path}.repair-tmp-${process.pid}`;
  writeFileSync(tmpPath, compressLog(serializeLog(parsed)));
  renameSync(tmpPath, path);

  // Refuse to report success unless the written file passes the exact scan.
  const verify = scanRows(parseLog(decompressLog(path).toString("utf8")).rows);
  if (!verify.ok) {
    writeJson(res, 500, { error: `post-repair verification failed: expected ${verify.gap?.expected}, got ${verify.gap?.got}`, backup: backupPath });
    return;
  }
  summary.verified = true;
  writeJson(res, 200, summary);
}

/**
 * POST /session-repair/restore - restore the newest backup of one log. The
 * current (possibly repaired) file is kept as .pre-restore-<ts>.
 */
async function handleRestore(req, res) {
  const body = await readJsonBody(req);
  if (body === null) {
    writeJson(res, 400, { error: "invalid JSON body" });
    return;
  }
  const { cwd, sessionId } = body;
  const path = sessionLogPath(cwd, sessionId) ?? findSessionLogEverywhere(sessionId);
  if (path === null) {
    writeJson(res, 404, { error: `no session log for "${sessionId}"` });
    return;
  }
  const [newest] = listBackups(path);
  if (newest === undefined) {
    writeJson(res, 404, { error: "no backup found" });
    return;
  }

  copyFileSync(path, `${path}.pre-restore-${Date.now()}`);
  copyFileSync(newest, path);
  writeJson(res, 200, { ok: true, sessionId, restoredFrom: newest });
}

/**
 * Cordis plugin entry. Registers the scan / repair / restore routes when the
 * optional Host HTTP service is composed.
 */
export function apply(ctx) {
  ctx.inject(["webServer"], (httpCtx) => {
    const routes = [
      ["/session-repair/scan", handleScan],
      ["/session-repair/repair", handleRepair],
      ["/session-repair/restore", handleRestore]
    ];

    for (const [path, handler] of routes) {
      httpCtx.effect(() => httpCtx.webServer.register({ kind: "exact", path, handler }), `dsh-plugin-session-repair: ${path}`);
    }
  });
}

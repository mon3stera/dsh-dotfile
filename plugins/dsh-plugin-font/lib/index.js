/**
 * Node half of dsh-plugin-font: a single plugin-owned config route.
 *   GET  /font/config   — read the persisted font settings (404 until set)
 *   POST /font/config   — validate and atomically persist font settings
 * Persistence lives in $DSH_HOME/font/config.json (plugin-owned, survives
 * restarts independently of the Host settings document).
 */
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";

export const name = "dsh-plugin-font";

/** Durable font settings schema (empty family = system default). */
export const FontSettingsSchema = z.object({
  family: z.string().max(200).default(""),
  codeFamily: z.string().max(200).default(""),
  /** Base markdown font size in px (16 = default). */
  fontSize: z.number().min(8).max(32).default(16),
  /** Base code font size in px (14 = default). */
  codeFontSize: z.number().min(8).max(32).default(14)
});

/** Absolute path of the plugin-owned font config file. */
export function configPath() {
  return join(resolveDshHome(), "font", "config.json");
}

/**
 * Read the request body up to a byte limit; null when the limit is exceeded.
 * On overflow the body is still fully drained before returning, so the 413
 * response reaches the client only after the upload finished — cutting the
 * connection mid-body makes browsers (notably Firefox) report a network
 * error instead of the status code.
 */
async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  let overflow = false;
  for await (const chunk of req) {
    if (overflow) continue;
    size += chunk.length;
    if (size > limit) {
      overflow = true;
      continue;
    }
    chunks.push(chunk);
  }
  if (overflow) return null;
  return Buffer.concat(chunks);
}

/** End a JSON response. */
function writeJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

/** Parse `fc-list` output into a deduped, sorted family list (comma-joined aliases split apart). */
export function parseFcFamilies(output) {
  const seen = new Set();
  for (const line of String(output || "").split("\n")) {
    for (const part of line.split(",")) {
      const family = part.trim();
      if (family) seen.add(family);
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b, "zh"));
}

let fontRunner = (query, cb) => {
  execFile("fc-list", [query, "family"], { timeout: 3000 }, (err, stdout) => {
    if (err) { cb(err); return; }
    cb(null, stdout);
  });
};

/** Test seam: replace the fc-list runner (used by dsh-font-smoke.mjs). */
export function _setFontRunner(runner) {
  fontRunner = runner;
}

/** Test seam: drop the cached catalog (used by dsh-font-smoke.mjs). */
export function _resetFontCache() {
  fontCache = null;
  fontCacheAt = 0;
}

let fontCache = null;
let fontCacheAt = 0;
const FONT_CACHE_TTL_MS = 60_000;

/** Enumerate installed fonts via fontconfig: all families + monospace ones. */
export async function enumerateFonts() {
  if (fontCache !== null && Date.now() - fontCacheAt < FONT_CACHE_TTL_MS) return fontCache;
  const result = await new Promise((resolve) => {
    fontRunner(":", (err, allOut) => {
      if (err) {
        resolve(null);
        return;
      }
      fontRunner(":spacing=100", (err2, monoOut) => {
        if (err2) {
          resolve({ families: parseFcFamilies(allOut), mono: [] });
          return;
        }
        resolve({ families: parseFcFamilies(allOut), mono: parseFcFamilies(monoOut) });
      });
    });
  });
  if (result !== null) {
    fontCache = result;
    fontCacheAt = Date.now();
  }
  return result;
}

/** GET /font/list — installed font catalog for the picker dropdowns. */
export async function handleFontList(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    res.end();
    return;
  }
  const catalog = await enumerateFonts();
  if (catalog === null) {
    writeJson(res, 200, { ok: false, families: [], mono: [] });
    return;
  }
  writeJson(res, 200, { ok: true, families: catalog.families, mono: catalog.mono });
}

/** GET/POST /font/config — read or persist the plugin-owned font settings. */
export async function handleConfig(req, res) {
  if (req.method === "GET" || req.method === "HEAD") {
    let data;
    try {
      data = readFileSync(configPath());
    } catch {
      writeJson(res, 404, { error: "not found" });
      return;
    }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" });
    res.end(data);
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405);
    res.end();
    return;
  }
  const body = await readBody(req, 16 * 1024);
  if (body === null) {
    writeJson(res, 413, { error: "config too large" });
    return;
  }
  let candidate;
  try {
    candidate = JSON.parse(body.toString("utf8"));
  } catch {
    writeJson(res, 400, { error: "invalid JSON" });
    return;
  }
  const validated = FontSettingsSchema["~standard"].validate(candidate);
  if (validated.issues !== undefined) {
    writeJson(res, 400, { error: validated.issues[0]?.message ?? "invalid config" });
    return;
  }
  const dir = join(resolveDshHome(), "font");
  mkdirSync(dir, { recursive: true });
  const target = configPath();
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(validated.value, null, 2));
  renameSync(tmp, target);
  writeJson(res, 200, { ok: true, config: validated.value });
}

/**
 * Register the config route when the optional Host HTTP service is composed.
 */
export function apply(ctx) {
  ctx.inject(["webServer"], (httpCtx) => {
    httpCtx.effect(() => httpCtx.webServer.register({ kind: "exact", path: "/font/config", handler: handleConfig }), "dsh-plugin-font: config route");
    httpCtx.effect(() => httpCtx.webServer.register({ kind: "exact", path: "/font/list", handler: handleFontList }), "dsh-plugin-font: font list route");
  });
}

/**
 * Node half of dsh-plugin-font: plugin-owned config/font routes.
 *   GET  /font/config   — read the persisted font settings (404 until set)
 *   POST /font/config   — validate and atomically persist font settings
 *   GET  /font/list     — installed font catalog for the picker dropdowns
 *   GET  /font/file     — serve one enumerated font file as a web font
 * Persistence lives in $DSH_HOME/font/config.json (plugin-owned, survives
 * restarts independently of the Host settings document).
 */
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";

export const name = "dsh-plugin-font";

/**
 * Durable font settings schema. `families`/`codeFamilies` are ordered fallback
 * stacks (first entry wins). Empty family/stack = system default. Absent or
 * null size = follow the theme's own content font-size axis; the client omits
 * those keys in that state, so stored configs simply lack them. Weights are
 * deltas (-200..200) relative to each theme token's own weight, omitted at 0.
 * `family`/`codeFamily` are the legacy single-font fields, kept so old configs
 * still validate; the client migrates them into the stacks on load.
 */
export const FontSettingsSchema = z.object({
  family: z.string().max(200).default(""),
  codeFamily: z.string().max(200).default(""),
  families: z.array(z.string().max(200)).default([]),
  codeFamilies: z.array(z.string().max(200)).default([]),
  /** Serve the selected stack families as web fonts for clients without them. */
  serveFontFiles: z.boolean().default(true),
  /** Desired markdown base size in px; null/absent follows the theme. */
  fontSize: z.union([z.number().min(8).max(32), z.const(null)]).default(null),
  /** Desired inline-code size in px; null/absent follows the theme. */
  codeFontSize: z.union([z.number().min(8).max(32), z.const(null)]).default(null),
  /** Body weight delta applied to every body-family token. */
  fontWeight: z.union([z.number().min(-200).max(200), z.const(null)]).default(null),
  /** Code weight delta applied to every code-family token. */
  codeFontWeight: z.union([z.number().min(-200).max(200), z.const(null)]).default(null)
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

/**
 * fc-list invocation for the per-face catalog: file path, family aliases and
 * fontconfig's numeric weight/slant per face, joined by the ASCII unit
 * separator (a byte no font path, family or style token contains). The
 * trailing newline is required - a custom --format replaces the default
 * format whole, newline included, so without it every face lands on one line.
 */
const FC_FACES_ARGS = [":", `--format=%{file}\u001F%{family}\u001F%{weight}\u001F%{slant}\u001F%{index}\n`];

/** Bitmap formats fontconfig can enumerate but a browser cannot use. */
const FACE_SKIP_EXT = new Set(["bdf", "pcf", "pf", "snf", "gz"]);

/** Content type per font file extension; unknown extensions are not served. */
const FACE_MIME = { ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2", ttc: "font/collection" };

/** @import('font-face') format() token per font file extension. */
export function faceFormat(ext) {
  return { ttf: "truetype", otf: "opentype", woff: "woff", woff2: "woff2", ttc: "collection" }[ext] || null;
}

/**
 * Parse the unit-separated fc-list template output into per-family face
 * lists: `{ [family]: [{ path, ext, weight, slant }] }`, insertion-ordered and
 * deduped per (family, file, face index). One file listing several families
 * contributes a face to each of them; bitmap formats are skipped.
 */
export function parseFcFaces(output) {
  const faces = {};
  const seen = new Set();
  for (const line of String(output || "").split("\n")) {
    const parts = line.split("\u001F");
    if (parts.length < 5) continue;
    const [file, families, weight, slant, faceIndex] = parts;
    const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();

    if (!file || !families || !FACE_MIME[ext]) continue;
    const numericWeight = Number(weight);
    const numericSlant = Number(slant);
    const numericIndex = Number(faceIndex);
    if (!Number.isFinite(numericWeight) || !Number.isFinite(numericSlant) || !Number.isFinite(numericIndex)) continue;
    const key = `${file}\u001F${numericIndex}`;
    for (const raw of families.split(",")) {
      const family = raw.trim();
      if (!family || seen.has(family + key)) continue;
      seen.add(family + key);
      (faces[family] ??= []).push({ path: file, ext, weight: numericWeight, slant: numericSlant, faceIndex: numericIndex });
    }
  }
  return faces;
}

let fontRunner = (args, cb) => {
  execFile("fc-list", args, { timeout: 3000 }, (err, stdout) => {
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

/** Enumerate installed fonts via fontconfig: families + monospace + per-family faces. */
export async function enumerateFonts() {
  if (fontCache !== null && Date.now() - fontCacheAt < FONT_CACHE_TTL_MS) return fontCache;
  const result = await new Promise((resolve) => {
    fontRunner(FC_FACES_ARGS, (err, allOut) => {
      if (err) {
        resolve(null);
        return;
      }
      const faces = parseFcFaces(allOut);
      fontRunner([":spacing=100", "family"], (err2, monoOut) => {
        const mono = err2 ? [] : parseFcFamilies(monoOut);
        resolve({ families: Object.keys(faces).sort((a, b) => a.localeCompare(b, "zh")), mono, faces });
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
    writeJson(res, 200, { ok: false, families: [], mono: [], faces: {} });
    return;
  }
  /* the wire projection never exposes server-side file paths */
  const wireFaces = {};
  for (const [family, list] of Object.entries(catalog.faces)) {
    wireFaces[family] = list.map(({ ext, weight, slant }) => ({ ext, weight, slant }));
  }
  writeJson(res, 200, { ok: true, families: catalog.families, mono: catalog.mono, faces: wireFaces });
}

/**
 * GET /font/file?family=<name>&index=<n> — serve one enumerated face as a web
 * font. The family/index pair is the whole addressing surface: no path ever
 * crosses the wire, so nothing outside the fc-list enumeration is reachable.
 */
export async function handleFontFile(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    res.end();
    return;
  }
  let query;
  try {
    query = new URL(req.url, "http://localhost").searchParams;
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  const family = query.get("family") || "";
  const index = Number(query.get("index") ?? "0");
  const catalog = await enumerateFonts();
  const faces = catalog?.faces?.[family];
  if (!Array.isArray(faces) || !Number.isInteger(index) || index < 0 || index >= faces.length) {
    res.writeHead(404);
    res.end();
    return;
  }
  const face = faces[index];
  let data;
  try {
    /* follow the enumeration's own path; realpath is the identity check */
    if (realpathSync(face.path) !== face.path) throw new Error("renamed since enumeration");
    if (!statSync(face.path).isFile()) throw new Error("not a file");
    data = readFileSync(face.path);
  } catch {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, {
    "content-type": FACE_MIME[face.ext],
    "content-length": data.length,
    /* face files are system-managed and effectively never change in place */
    "cache-control": "public, max-age=31536000, immutable"
  });
  res.end(req.method === "HEAD" ? undefined : data);
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
 * Register the config/font routes when the optional Host HTTP service is composed.
 */
export function apply(ctx) {
  ctx.inject(["webServer"], (httpCtx) => {
    httpCtx.effect(() => httpCtx.webServer.register({ kind: "exact", path: "/font/config", handler: handleConfig }), "dsh-plugin-font: config route");
    httpCtx.effect(() => httpCtx.webServer.register({ kind: "exact", path: "/font/list", handler: handleFontList }), "dsh-plugin-font: font list route");
    httpCtx.effect(() => httpCtx.webServer.register({ kind: "exact", path: "/font/file", handler: handleFontFile }), "dsh-plugin-font: font file route");
  });
}

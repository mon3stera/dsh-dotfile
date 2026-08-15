/**
 * Node half of dsh-plugin-background: registers the durable `ui-background`
 * settings namespace (persisted in $DSH_HOME/settings.yaml) and the local
 * wallpaper upload/serve routes:
 *   POST /background/upload   — raw image bytes → saved under $DSH_HOME/background
 *   GET  /background/<file>   — serve uploaded wallpaper files (long cache)
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";

export const name = "dsh-plugin-background";

/** Settings namespace owned by this plugin. */
export const SETTINGS_NAMESPACE = "ui-background";

/** Built-in wallpaper ids accepted at the settings boundary. */
export const WALLPAPERS = [
  "none",
  "custom"
];

/** Default wallpaper selection. */
export const DEFAULT_WALLPAPER = "none";

/** Default wallpaper layer opacity (0..1). */
export const DEFAULT_OPACITY = 0.2;

/** M3 dynamic-color variant ids accepted at the settings boundary. */
export const VARIANTS = [
  "tonalSpot",
  "vibrant",
  "expressive",
  "fidelity",
  "content",
  "rainbow",
  "fruitSalad",
  "monochrome",
  "neutral"
];

/** Default M3 variant. */
export const DEFAULT_VARIANT = "tonalSpot";

/** Durable wallpaper schema; also the wire envelope the browser scope validates against. */
export const BackgroundSettingsSchema = z.object({
  wallpaper: z.union([...WALLPAPERS]).default(DEFAULT_WALLPAPER),
  customUrl: z.string().default(""),
  opacity: z.number().min(0).max(1).default(DEFAULT_OPACITY),
  themeFromWallpaper: z.boolean().default(true),
  variant: z.union([...VARIANTS]).default(DEFAULT_VARIANT)
});

/** Subdirectory of the DSH home holding uploaded wallpaper files. */
export const UPLOAD_DIR = "background";

/** Uploaded wallpaper file prefix (replace semantics: one wallpaper at a time). */
export const UPLOAD_PREFIX = "wallpaper-";

/** Max accepted upload size in bytes (ultra-HD wallpapers can be large). */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** Accepted upload content types → saved file extension. */
export const ALLOWED_UPLOAD_TYPES = Object.freeze({
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif"
});

/** Extension → response content type for served wallpaper files. */
const EXT_CONTENT_TYPES = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif"
});

/** Absolute directory holding uploaded wallpapers. */
export function uploadsDir() {
  return join(resolveDshHome(), UPLOAD_DIR);
}

/** Plugin-owned wallpaper config file (single source of truth for persistence). */
export function configPath() {
  return join(uploadsDir(), "config.json");
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

/** POST /background/upload — raw image bytes saved under the DSH home. */
export async function handleUpload(req, res) {
  const contentType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  const ext = ALLOWED_UPLOAD_TYPES[contentType];
  if (ext === void 0) {
    writeJson(res, 415, { error: `unsupported content type "${contentType}"` });
    return;
  }
  const body = await readBody(req, MAX_UPLOAD_BYTES);
  if (body === null) {
    writeJson(res, 413, { error: `upload exceeds ${MAX_UPLOAD_BYTES} bytes`, limit: MAX_UPLOAD_BYTES });
    return;
  }
  if (body.length === 0) {
    writeJson(res, 400, { error: "empty upload" });
    return;
  }
  const dir = uploadsDir();
  mkdirSync(dir, { recursive: true });
  // Replace semantics: a new wallpaper supersedes previous uploads.
  for (const entry of readdirSync(dir)) {
    if (!entry.startsWith(UPLOAD_PREFIX)) continue;
    try {
      unlinkSync(join(dir, entry));
    } catch {
      /* best effort */
    }
  }
  const fileName = `${UPLOAD_PREFIX}${Date.now()}${ext}`;
  writeFileSync(join(dir, fileName), body);
  writeJson(res, 200, { url: `/background/${fileName}` });
}

/** GET /background/<file> — serve an uploaded wallpaper with a long cache. */
export function handleWallpaper(req, res) {
  const pathname = new URL(req.url ?? "/", "http://x").pathname;
  const name = pathname.slice(`/${UPLOAD_DIR}/`.length);
  if (name.length === 0 || name.includes("/") || name.includes("..") || !name.startsWith(UPLOAD_PREFIX)) {
    writeJson(res, 404, { error: "not found" });
    return;
  }
  let data;
  try {
    data = readFileSync(join(uploadsDir(), name));
  } catch {
    writeJson(res, 404, { error: "not found" });
    return;
  }
  res.writeHead(200, {
    "content-type": EXT_CONTENT_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream",
    "cache-control": "public, max-age=31536000, immutable"
  });
  res.end(data);
}

/** GET/POST /background/config — read or persist the plugin-owned configuration. */
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
  const body = await readBody(req, 64 * 1024);
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
  const validated = BackgroundSettingsSchema["~standard"].validate(candidate);
  if (validated.issues !== undefined) {
    writeJson(res, 400, { error: validated.issues[0]?.message ?? "invalid config" });
    return;
  }
  const dir = uploadsDir();
  mkdirSync(dir, { recursive: true });
  const target = configPath();
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(validated.value, null, 2));
  renameSync(tmp, target);
  writeJson(res, 200, { ok: true, config: validated.value });
}

/**
 * Register the upload/serve/config routes when the optional Host HTTP service
 * is composed. Persistence is plugin-owned (config.json next to the uploads),
 * so wallpaper configuration survives restarts without depending on the
 * Host settings document or its registration timing.
 * @param ctx - Host context that may acquire the HTTP service.
 */
export function apply(ctx) {
  ctx.inject(["webServer"], (httpCtx) => {
    httpCtx.effect(() => httpCtx.webServer.register({ kind: "exact", path: "/background/upload", handler: handleUpload }), "dsh-plugin-background: upload route");
    httpCtx.effect(() => httpCtx.webServer.register({ kind: "exact", path: "/background/config", handler: handleConfig }), "dsh-plugin-background: config route");
    httpCtx.effect(() => httpCtx.webServer.register({ kind: "prefix", path: "/background", handler: handleWallpaper }), "dsh-plugin-background: wallpaper files route");
  });
}

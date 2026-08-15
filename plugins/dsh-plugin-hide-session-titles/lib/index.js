/**
 * Node half of dsh-plugin-hide-session-titles: a single plugin-owned config
 * route.
 *   GET  /session-titles/config   — read the persisted toggle state (404 until set)
 *   POST /session-titles/config   — validate and atomically persist it
 * Persistence lives in $DSH_HOME/session-titles/config.json (plugin-owned,
 * survives restarts independently of the Host settings document).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";

export const name = "dsh-plugin-hide-session-titles";

/** Durable toggle schema (hidden = session titles hidden in the workspace). */
export const HideSessionTitlesSchema = z.object({
  hidden: z.boolean().default(false)
});

/** Absolute path of the plugin-owned config file. */
export function configPath() {
  return join(resolveDshHome(), "session-titles", "config.json");
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

/** GET/POST /session-titles/config — read or persist the toggle state. */
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
  const validated = HideSessionTitlesSchema["~standard"].validate(candidate);
  if (validated.issues !== undefined) {
    writeJson(res, 400, { error: validated.issues[0]?.message ?? "invalid config" });
    return;
  }
  const dir = join(resolveDshHome(), "session-titles");
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
    httpCtx.effect(() => httpCtx.webServer.register({ kind: "exact", path: "/session-titles/config", handler: handleConfig }), "dsh-plugin-hide-session-titles: config route");
  });
}

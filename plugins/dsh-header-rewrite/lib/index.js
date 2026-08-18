/**
 * dsh-header-rewrite: rewrite HTTP request headers for LLM provider calls.
 *
 * Provider SDKs read the global `fetch` when they build a client, so wrapping
 * it here applies to every provider request the harness makes - deepseek's
 * direct fetch, pi-ai's Anthropic/OpenAI SDK clients, and model discovery -
 * without touching adapter code. This is the seam a deployment needs when an
 * upstream gateway enforces a strict client policy (e.g. a User-Agent
 * allowlist that rejects the harness attribution header).
 *
 * Configuration sources, in priority order:
 *  1. the persisted file $DSH_HOME/header-rewrite/config.yaml (written by the
 *     web settings section via POST /header-rewrite/config; takes effect
 *     immediately, no restart),
 *  2. the `config` passed from the profile loader patch (cordis.patch.yml),
 *     used as the seed until the file exists.
 *
 * File format (YAML):
 *
 *   rules:
 *     - match:
 *         host: agentrouter.org      # hostname; `*` wildcards; omit = any
 *         path: /v1/messages         # pathname; `*` wildcards; omit = any
 *         model: "*"                 # model id read from the JSON body
 *         method: POST               # uppercase; omit = any
 *       headers:
 *         User-Agent: claude-cli/1.0.0 (external, cli)
 *         X-Drop-This: null          # null deletes the header
 *
 * `match` fields are ANDed; every matching rule applies in config order, so a
 * later rule wins when two rules set the same header.
 *
 * @module dsh-header-rewrite
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";

export const name = "dsh-header-rewrite";

const HEADER_VALUE = z.union([z.string(), z.const(null)]);

// Note: schemastery object fields are optional by default; a missing
// `match` yields `undefined`, which apply() treats as "no constraints".
export const Config = z.object({
  rules: z
    .array(
      z.object({
        match: z.object({
          host: z.string(),
          path: z.string(),
          model: z.string(),
          method: z.string(),
        }),
        headers: z.dict(HEADER_VALUE),
      }),
    )
    .default([]),
});

/**
 * Currently active rules. Module-level so the fetch wrapper (installed once)
 * reads the latest rules on every request while a settings save updates them
 * in place; `apply()` reseeds it from the persisted file or the patch config.
 */
let currentRules = [];

/** Absolute path of the plugin-owned config file. */
export function configPath() {
  return join(resolveDshHome(), "header-rewrite", "config.yaml");
}

/** Parse YAML text into a validated rules array; throws on bad YAML/schema. */
export function parseRulesYaml(text) {
  let doc;
  try {
    doc = parseYaml(text ?? "");
  } catch (error) {
    throw new Error(`invalid YAML: ${error?.message ?? error}`);
  }
  if (doc === null || doc === undefined) return [];
  if (typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("top level must be an object with a rules list");
  }
  const validated = Config["~standard"].validate(doc);
  if (validated.issues !== undefined) {
    throw new Error(validated.issues[0]?.message ?? "invalid config");
  }
  return validated.value.rules;
}

/** Load persisted rules; null when the file is absent or invalid. */
export function loadPersistedRules() {
  try {
    return parseRulesYaml(readFileSync(configPath(), "utf8"));
  } catch {
    return null;
  }
}

/** Validate, persist, and return the rules parsed from YAML text. */
export function saveRulesYaml(text) {
  const rules = parseRulesYaml(text);
  const dir = join(resolveDshHome(), "header-rewrite");
  mkdirSync(dir, { recursive: true });
  const target = configPath();
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, text.trimEnd() + "\n");
  renameSync(tmp, target);
  return rules;
}

/**
 * Read the request body up to a byte limit; null when the limit is exceeded.
 * On overflow the body is still fully drained before returning.
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

/**
 * GET/POST /header-rewrite/config - read or persist the plugin config.
 * GET returns the current YAML text ({ ok, yaml }); POST takes the raw YAML
 * body, validates it, persists it atomically, and applies it immediately.
 */
export async function handleConfig(req, res) {
  if (req.method === "GET" || req.method === "HEAD") {
    let text = null;
    try {
      text = readFileSync(configPath(), "utf8");
    } catch {
      /* no file yet: fall through to the in-memory seed */
    }
    if (text === null) text = stringifyYaml({ rules: currentRules });
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" });
    res.end(JSON.stringify({ ok: true, yaml: text }));
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405);
    res.end();
    return;
  }
  const body = await readBody(req, 64 * 1024);
  if (body === null) {
    writeJson(res, 413, { error: "config too large (max 64 KiB)" });
    return;
  }
  let rules;
  try {
    rules = saveRulesYaml(body.toString("utf8"));
  } catch (error) {
    writeJson(res, 400, { error: String(error?.message ?? error) });
    return;
  }
  currentRules = rules;
  writeJson(res, 200, { ok: true });
}

/** Convert a `*` glob to an anchored RegExp; other characters are literal. */
function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);
}

/** True when `actual` satisfies the optional pattern (`undefined`/`*` match all). */
function matches(actual, pattern) {
  if (pattern === undefined || pattern === "*") return true;
  try {
    return globToRegExp(pattern).test(actual ?? "");
  } catch {
    return false;
  }
}

/** Extract the model id from a JSON fetch body, when the body carries one. */
function bodyModel(init) {
  if (typeof init?.body !== "string") return undefined;
  try {
    const parsed = JSON.parse(init.body);
    return typeof parsed?.model === "string" ? parsed.model : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Cordis plugin entry. Seeds `currentRules`, wraps the global fetch once
 * (later `apply` calls reseed rules but never stack another wrapper), and
 * registers the config route when the optional Host HTTP service is composed.
 */
export function apply(ctx, config = {}) {
  currentRules = loadPersistedRules() ?? (config.rules ?? []);

  if (typeof globalThis.fetch === "function" && !globalThis.__dshHeaderRewritePatched) {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (input, init = {}) => {
      let url;
      try {
        url = new URL(typeof input === "string" ? input : input.url);
      } catch {
        return originalFetch.call(undefined, input, init);
      }

      const rules = currentRules;
      const model = bodyModel(init);
      const method = (init.method ?? "GET").toUpperCase();
      let effective = init;

      for (const rule of rules) {
        const m = rule.match ?? {};
        if (!matches(url.hostname, m.host)) continue;
        if (!matches(url.pathname, m.path)) continue;
        if (!matches(model, m.model)) continue;
        if (!matches(method, m.method === undefined ? undefined : m.method.toUpperCase())) continue;

        const headers = new Headers(effective.headers);
        for (const [headerName, value] of Object.entries(rule.headers)) {
          if (value === null) headers.delete(headerName);
          else headers.set(headerName, value);
        }
        effective = { ...effective, headers };
      }

      return originalFetch.call(undefined, input, effective);
    };

    globalThis.__dshHeaderRewritePatched = true;
  }

  ctx.inject(["webServer"], (httpCtx) => {
    httpCtx.effect(() => httpCtx.webServer.register({ kind: "exact", path: "/header-rewrite/config", handler: handleConfig }), "dsh-header-rewrite: config route");
  });
}

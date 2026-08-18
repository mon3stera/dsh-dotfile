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
 * Config (cordis.patch.yml):
 *
 *   - id: dsh-header-rewrite
 *     name: dsh-header-rewrite
 *     config:
 *       rules:
 *         - match:
 *             host: agentrouter.org      # hostname; `*` wildcards; omit = any
 *             path: /v1/messages         # pathname; `*` wildcards; omit = any
 *             model: "*"                 # model id read from the JSON body
 *             method: POST               # uppercase; omit = any
 *           headers:
 *             User-Agent: claude-cli/1.0.0 (external, cli)
 *             X-Drop-This: null          # null deletes the header
 *
 * `match` fields are ANDed; every matching rule applies in config order, so a
 * later rule wins when two rules set the same header. A value of `null`
 * deletes the header instead of setting it.
 *
 * @module dsh-header-rewrite
 */
import z from "@deepseek-ai/schemastery";

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
 * Cordis plugin entry. Wraps the global fetch once; later `apply` calls are
 * no-ops so hot reload cannot stack wrappers.
 */
export function apply(_ctx, config = {}) {
  const rules = config.rules ?? [];
  if (rules.length === 0) return;
  if (globalThis.__dshHeaderRewritePatched) return;

  const originalFetch = globalThis.fetch;
  if (typeof originalFetch !== "function") return;

  globalThis.fetch = async (input, init = {}) => {
    let url;
    try {
      url = new URL(typeof input === "string" ? input : input.url);
    } catch {
      return originalFetch.call(undefined, input, init);
    }

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

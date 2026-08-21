/**
 * File-backed settings and their HTTP bridge for the settings panel.
 *
 * The panel cannot reuse the host's provider editor. That editor picks its form
 * by settings namespace (`layoutOf`: `llm-deepseek`, `llm-pi-ai`, else
 * `unknown`), and an unknown namespace renders a hint with the submit button
 * disabled - visible but not editable. So this plugin owns its own section and
 * its own storage, and registers it through the same public `settings.section`
 * slot the host's Models page uses.
 *
 * Secrets never live in this file. A route stores only a credential
 * *reference*, and the value goes to the host credential store, which is also
 * where an environment variable is resolved from.
 *
 * @module dsh-plugin-image-model/settings
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { isCredentialRef, mergeProviders, normalizeRoutes } from "./config.js";

/** Bound on an accepted request body, so a bad client cannot exhaust memory. */
const MAX_BODY_BYTES = 512 * 1024;

/** Where the panel's document lives. */
export function configPath(home = process.env.DSH_HOME ?? join(process.env.HOME ?? ".", ".dsh")) {
  return join(home, "image-model", "config.json");
}

/**
 * Read the persisted document, tolerating absence and corruption.
 *
 * A missing file is the normal first-run state. An unreadable one must not stop
 * the plugin from loading, because that would take the settings panel - the only
 * way to fix it - down with it.
 *
 * @param path - the document path.
 * @returns the stored document, or an empty one.
 */
export function readConfig(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return {
      providers: Array.isArray(parsed?.providers) ? parsed.providers : [],
      removed: Array.isArray(parsed?.removed) ? parsed.removed : [],
    };
  } catch {
    return { providers: [], removed: [] };
  }
}

/**
 * Persist the document atomically.
 *
 * Written to a sibling temporary file and renamed, so a crash mid-write cannot
 * leave a half-written document that the next read would discard.
 *
 * @param path - the document path.
 * @param document - the document to store.
 */
export function writeConfig(path, document) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(document, undefined, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/** Send a JSON response. */
function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/**
 * Read a bounded JSON request body.
 * @param req - the incoming request.
 * @returns the parsed body.
 */
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Describe every credential reference the effective routes name.
 *
 * The panel needs to show whether a key is present and whether it can write
 * one, and must never receive the value itself.
 *
 * @param credentials - getter for the host credential service, if mounted.
 * @param routes - the effective routes.
 * @returns reference name to configured/writable facts.
 */
export async function describeCredentials(credentials, routes) {
  const described = {};
  const store = credentials?.();
  if (store === undefined) return described;
  for (const route of routes) {
    const ref = route.apiKeyRef;
    if (ref === undefined || described[ref] !== undefined) continue;
    try {
      const info = await store.describe(credentialRef(ref));
      described[ref] = { configured: info.configured === true, writable: info.writable === true, ...info.source === undefined ? {} : { source: info.source } };
    } catch {
      described[ref] = { configured: false, writable: false };
    }
  }
  return described;
}

/**
 * Build the settings bridge: two routes plus the live-apply hook.
 *
 * @param options - the seed providers, the persistence path, the credential
 *   service getter, and the callback that re-registers routes after a write.
 * @returns the route handlers and the effective-route resolver.
 */
export function createSettingsBridge({ seed, path, credentials, onChange, logger }) {
  let document = readConfig(path);

  const effective = () => normalizeRoutes(mergeProviders(seed, document));

  async function handleConfig(req, res) {
    if (req.method === "GET" || req.method === "HEAD") {
      const routes = effective();
      json(res, 200, {
        ok: true,
        providers: routes,
        seeded: (Array.isArray(seed) ? seed : []).map((provider) => provider?.id).filter((id) => typeof id === "string"),
        credentials: await describeCredentials(credentials, routes),
      });
      return;
    }
    if (req.method !== "POST" && req.method !== "PUT") {
      res.writeHead(405, { allow: "GET, HEAD, POST, PUT" });
      res.end();
      return;
    }
    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      json(res, 400, { ok: false, error: error instanceof Error ? error.message : "invalid body" });
      return;
    }
    const providers = Array.isArray(body?.providers) ? body.providers : [];
    // Normalizing before persisting keeps the file free of entries the runtime
    // would silently drop, so what the panel shows next is what is in effect.
    const accepted = normalizeRoutes(providers);
    const seedIds = new Set((Array.isArray(seed) ? seed : []).map((provider) => provider?.id));
    const keptIds = new Set(accepted.map((route) => route.id));
    const next = {
      providers: accepted,
      removed: [...seedIds].filter((id) => typeof id === "string" && !keptIds.has(id)),
    };
    try {
      writeConfig(path, next);
    } catch (error) {
      json(res, 500, { ok: false, error: error instanceof Error ? error.message : "could not persist" });
      return;
    }
    document = next;
    const routes = effective();
    try {
      onChange?.(routes);
    } catch (error) {
      logger?.warn?.(`dsh-plugin-image-model: could not apply routes: ${error instanceof Error ? error.message : String(error)}`);
      json(res, 200, {
        ok: true,
        providers: routes,
        credentials: await describeCredentials(credentials, routes),
        warning: "saved, but the running process could not re-register the routes; restart to apply",
      });
      return;
    }
    json(res, 200, { ok: true, providers: routes, credentials: await describeCredentials(credentials, routes) });
  }

  async function handleCredential(req, res) {
    if (req.method !== "POST" && req.method !== "PUT") {
      res.writeHead(405, { allow: "POST, PUT" });
      res.end();
      return;
    }
    const store = credentials?.();
    if (store === undefined) {
      json(res, 503, { ok: false, error: "no credential service is mounted" });
      return;
    }
    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      json(res, 400, { ok: false, error: error instanceof Error ? error.message : "invalid body" });
      return;
    }
    const ref = typeof body?.ref === "string" ? body.ref.trim() : "";
    if (!isCredentialRef(ref)) {
      json(res, 400, { ok: false, error: "a credential reference must be a POSIX identifier such as OPENAI_API_KEY" });
      return;
    }
    const value = typeof body?.value === "string" ? body.value : "";
    try {
      if (value === "") await store.unset(credentialRef(ref));
      else await store.set(credentialRef(ref), value);
    } catch (error) {
      json(res, 400, { ok: false, error: error instanceof Error ? error.message : "could not store the credential" });
      return;
    }
    json(res, 200, { ok: true, credentials: await describeCredentials(credentials, effective()) });
  }

  return { handleConfig, handleCredential, effective };
}

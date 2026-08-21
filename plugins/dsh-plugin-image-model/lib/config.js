/**
 * Route normalization shared by the loader patch and the settings file.
 *
 * Both sources describe the same thing, so both are normalized here: a route is
 * dropped rather than registered when it cannot work, because registering it
 * would put a provider in the model selector that fails on first use.
 *
 * @module dsh-plugin-image-model/config
 */
import { DEFAULT_CONTEXT_WINDOW } from "./adapter.js";

/** A credential reference is a POSIX shell identifier, as the store requires. */
const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Optional string fields copied verbatim onto a model when non-empty. */
const MODEL_OPTIONS = ["description", "size", "quality", "background", "outputFormat", "responseFormat"];

/** Read a trimmed string field, or an empty string when it is absent. */
function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Validate a credential reference.
 *
 * The store brands references as POSIX shell identifiers, so anything else is
 * rejected here rather than at resolution time, where it would look like a
 * missing key.
 *
 * @param value - the candidate reference.
 * @returns true when the reference is usable.
 */
export function isCredentialRef(value) {
  return CREDENTIAL_REF.test(value);
}

/**
 * Normalize one model entry.
 * @param model - the raw model entry.
 * @returns the normalized model, or undefined when it has no id.
 */
export function normalizeModel(model) {
  const id = text(model?.id);
  if (id === "") return undefined;
  const normalized = { id, name: text(model?.name) === "" ? id : text(model.name) };
  for (const key of MODEL_OPTIONS) {
    const value = text(model?.[key]);
    if (value !== "") normalized[key] = value;
  }
  return normalized;
}

/**
 * Validate and normalize one configured route.
 *
 * @param route - one raw configuration entry.
 * @returns the normalized route, or undefined when it is unusable.
 */
export function normalizeRoute(route) {
  const id = text(route?.id);
  const baseURL = text(route?.baseURL);
  if (id === "" || baseURL === "") return undefined;
  const models = (Array.isArray(route.models) ? route.models : [])
    .map(normalizeModel)
    .filter((model) => model !== undefined);
  if (models.length === 0) return undefined;
  // `apiKeyEnv` is the older name for the same thing: a reference the credential
  // store resolves, which for the local provider includes the environment.
  const apiKeyRef = text(route.apiKeyRef) === "" ? text(route.apiKeyEnv) : text(route.apiKeyRef);
  const contextWindow = Number.isSafeInteger(route.contextWindow) && route.contextWindow > 0
    ? route.contextWindow
    : DEFAULT_CONTEXT_WINDOW;
  return {
    id,
    name: text(route.name) === "" ? id : text(route.name),
    baseURL,
    ...apiKeyRef !== "" && isCredentialRef(apiKeyRef) ? { apiKeyRef } : {},
    edits: route.edits !== false,
    contextWindow,
    models,
  };
}

/**
 * Normalize the whole provider list, rejecting duplicate ids.
 * @param providers - the raw configured provider list.
 * @returns usable routes in configuration order.
 */
export function normalizeRoutes(providers) {
  const seen = new Set();
  const routes = [];
  for (const raw of Array.isArray(providers) ? providers : []) {
    const route = normalizeRoute(raw);
    if (route === undefined || seen.has(route.id)) continue;
    seen.add(route.id);
    routes.push(route);
  }
  return routes;
}

/**
 * Merge the loader-patch seed with the persisted settings file.
 *
 * The file wins per provider id: the patch is a deployment seed, while the file
 * is what the settings panel edits. A provider the user removed in the panel
 * must not come back from the seed, so the file also records `removed` ids.
 *
 * @param seed - providers from the loader patch.
 * @param stored - the persisted settings document.
 * @returns the effective provider list, unnormalized.
 */
export function mergeProviders(seed, stored) {
  const removed = new Set((Array.isArray(stored?.removed) ? stored.removed : []).map(text).filter((id) => id !== ""));
  const fileProviders = Array.isArray(stored?.providers) ? stored.providers : [];
  const byId = new Map();
  for (const provider of Array.isArray(seed) ? seed : []) {
    const id = text(provider?.id);
    if (id === "" || removed.has(id)) continue;
    byId.set(id, provider);
  }
  for (const provider of fileProviders) {
    const id = text(provider?.id);
    if (id === "") continue;
    byId.set(id, provider);
  }
  return [...byId.values()];
}

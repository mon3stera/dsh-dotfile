/**
 * OpenAI-compatible images API client.
 *
 * Two endpoints, two body encodings: `/images/generations` takes JSON, and
 * `/images/edits` takes multipart form-data because it carries image bytes.
 * Both answer with the same `{ data: [{ b64_json | url, revised_prompt? }] }`
 * envelope, so the response path is shared.
 *
 * Failures are classified into the harness `LlmError` codes rather than thrown
 * raw, because the retry layer routes on `code` and never parses messages.
 *
 * @module dsh-plugin-image-model/images-api
 */
import { LlmError, attributionHeaders } from "@deepseek-ai/dsh-llm";

/** Magic-byte signatures for the media types the attachment store accepts. */
const SIGNATURES = [
  { mediaType: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mediaType: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mediaType: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] },
];

/** Bound on a downloaded image so a hostile URL cannot exhaust memory. */
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

/**
 * Identify image bytes by signature rather than trusting the provider.
 *
 * `attachments.saveImage()` verifies the declared media type against the fully
 * decoded raster and rejects a mismatch with `IMAGE_TYPE_MISMATCH`, so guessing
 * from a request parameter would turn a provider quirk into a failed save.
 *
 * @param data - encoded image bytes.
 * @returns the detected media type.
 */
export function detectMediaType(data) {
  for (const { mediaType, bytes } of SIGNATURES) {
    if (data.length < bytes.length) continue;
    let matched = true;
    for (let i = 0; i < bytes.length; i += 1) {
      if (data[i] !== bytes[i]) { matched = false; break; }
    }
    if (matched) return mediaType;
  }
  // RIFF....WEBP: the size field between the two tags is not part of the tag.
  if (
    data.length >= 12 &&
    data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
    data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
  ) return "image/webp";
  throw new LlmError(
    "the image endpoint returned bytes that are not PNG, JPEG, WebP, or GIF",
    "INVALID_RESPONSE",
  );
}

/**
 * Map one transport or HTTP failure onto a harness failure class.
 * @param status - HTTP status, or undefined for a transport-level failure.
 * @returns the stable failure code the retry layer routes on.
 */
export function failureCodeForStatus(status) {
  if (status === undefined) return "TRANSPORT";
  if (status === 401 || status === 403) return "AUTH";
  if (status === 429) return "RATE_LIMIT";
  if (status >= 500) return "SERVER";
  if (status === 408) return "TIMEOUT";
  return "INVALID_REQUEST";
}

/**
 * Reduce a provider error body to one bounded human-readable line.
 *
 * A gateway may answer with an HTML error page; that text can reach durable
 * surfaces, so it is flattened and truncated instead of forwarded verbatim.
 *
 * @param body - raw response body text.
 * @param limit - maximum characters to keep.
 * @returns a single-line description.
 */
export function describeErrorBody(body, limit = 240) {
  const text = typeof body === "string" ? body : "";
  let detail = "";
  try {
    const parsed = JSON.parse(text);
    const error = parsed?.error;
    detail = typeof error?.message === "string" ? error.message : typeof parsed?.message === "string" ? parsed.message : "";
  } catch {
    detail = /<html|<!doctype/i.test(text) ? "provider returned an HTML error page" : text;
  }
  const flat = detail.replace(/\s+/g, " ").trim();
  if (flat === "") return "no error detail";
  return flat.length > limit ? `${flat.slice(0, limit - 3)}...` : flat;
}

/** Join a base URL and a path without doubling or dropping the separator. */
function endpoint(baseURL, path) {
  return `${baseURL.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** Headers common to both endpoints; attribution is contractually mandatory. */
function requestHeaders(apiKey, extra) {
  return {
    ...attributionHeaders(),
    ...apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` },
    ...extra,
  };
}

/**
 * Read a response body without throwing, so error classification always has
 * something to report.
 * @param response - the fetch response.
 * @returns the body text, or an empty string when it cannot be read.
 */
async function safeText(response) {
  try { return await response.text(); } catch { return ""; }
}

/**
 * Extract the first image and its optional revised prompt from a response.
 * @param payload - the parsed response envelope.
 * @param signal - cancellation for a URL-delivered image.
 * @returns the encoded bytes plus any provider-revised prompt and usage.
 */
async function readImagePayload(payload, signal) {
  const entry = Array.isArray(payload?.data) ? payload.data[0] : undefined;
  if (entry === undefined) {
    throw new LlmError("the image endpoint returned no image", "EMPTY_RESPONSE");
  }
  let data;
  if (typeof entry.b64_json === "string" && entry.b64_json !== "") {
    data = new Uint8Array(Buffer.from(entry.b64_json, "base64"));
  } else if (typeof entry.url === "string" && entry.url !== "") {
    const response = await fetch(entry.url, { headers: attributionHeaders(), signal });
    if (!response.ok) {
      throw new LlmError(
        `could not download the generated image: HTTP ${response.status}`,
        failureCodeForStatus(response.status),
      );
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      throw new LlmError("the generated image exceeds the size bound", "INVALID_RESPONSE");
    }
    data = new Uint8Array(buffer);
  } else {
    throw new LlmError("the image endpoint returned neither b64_json nor url", "INVALID_RESPONSE");
  }
  if (data.length === 0) throw new LlmError("the image endpoint returned empty image bytes", "EMPTY_RESPONSE");
  const usage = payload?.usage;
  return {
    data,
    mediaType: detectMediaType(data),
    ...typeof entry.revised_prompt === "string" && entry.revised_prompt !== ""
      ? { revisedPrompt: entry.revised_prompt }
      : {},
    ...usage === undefined ? {} : { usage },
  };
}

/**
 * Perform one images request and return its decoded image.
 *
 * @param route - resolved provider route (baseURL and credential).
 * @param request - the prepared request: model, prompt, options, and optional source image.
 * @param signal - cancellation for the provider call.
 * @param fetchImpl - injectable fetch, used by tests.
 * @returns the encoded image bytes plus metadata.
 */
export async function requestImage(route, request, signal, fetchImpl = fetch) {
  const editing = request.image !== undefined;
  const url = endpoint(route.baseURL, editing ? "images/edits" : "images/generations");
  let init;
  if (editing) {
    const form = new FormData();
    form.set("model", request.model);
    form.set("prompt", request.prompt);
    for (const [key, value] of Object.entries(request.options ?? {})) {
      if (value !== undefined) form.set(key, String(value));
    }
    form.set(
      "image",
      new Blob([request.image.data], { type: request.image.mediaType }),
      request.image.name ?? "image.png",
    );
    // Content-Type is deliberately unset: fetch must add the multipart boundary.
    init = { method: "POST", headers: requestHeaders(route.apiKey), body: form, signal };
  } else {
    init = {
      method: "POST",
      headers: requestHeaders(route.apiKey, { "content-type": "application/json" }),
      body: JSON.stringify({ model: request.model, prompt: request.prompt, n: 1, ...request.options }),
      signal,
    };
  }

  let response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    if (signal?.aborted === true) throw error;
    throw new LlmError(
      `the image endpoint could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      "TRANSPORT",
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new LlmError(
      `the image endpoint failed with HTTP ${response.status}: ${describeErrorBody(await safeText(response))}`,
      failureCodeForStatus(response.status),
    );
  }
  const text = await safeText(response);
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new LlmError(
      `the image endpoint returned a non-JSON body: ${describeErrorBody(text)}`,
      "INVALID_RESPONSE",
      { cause: error },
    );
  }
  return await readImagePayload(payload, signal);
}

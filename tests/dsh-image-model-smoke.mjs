// Smoke test for dsh-plugin-image-model.
//
// The plugin depends on three host contracts that live outside this repository:
// `image` must stay a declared content-block type, the client must keep mapping
// an image block into an assistant node, and `registerAdapter` must stay the
// registration seam. Those are cross-checked against the installed host, so a
// future upgrade fails here instead of silently producing invisible images.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import vm from "node:vm";

// Imports target the mirrored runtime copy, per the repository test convention.

import {
  Config,
  apply,
  name as pluginName,
  isCredentialRef,
  mergeProviders,
  normalizeRoute,
  normalizeRoutes,
} from "/home/mon3tr/.dsh/profiles/node_modules/dsh-plugin-image-model/lib/index.js";
import {
  configPath,
  createSettingsBridge,
  describeCredentials,
  readConfig,
  writeConfig,
} from "/home/mon3tr/.dsh/profiles/node_modules/dsh-plugin-image-model/lib/settings.js";
import {
  DEFAULT_CONTEXT_WINDOW,
  ImageModelAdapter,
  admissionFailure,
  fileNameFor,
  normalizeUsage,
} from "/home/mon3tr/.dsh/profiles/node_modules/dsh-plugin-image-model/lib/adapter.js";
import {
  describeErrorBody,
  detectMediaType,
  failureCodeForStatus,
  requestImage,
} from "/home/mon3tr/.dsh/profiles/node_modules/dsh-plugin-image-model/lib/images-api.js";
import {
  findSourceImage,
  messageText,
  modelOptions,
  isHumanMessage,
  resolvePrompt,
  shouldGenerate,
  stripSystemReminders,
} from "/home/mon3tr/.dsh/profiles/node_modules/dsh-plugin-image-model/lib/request.js";

let checks = 0;
function ok(condition, message) {
  checks += 1;
  if (!condition) throw new Error(`FAIL: ${message}`);
}
function eq(actual, expected, message) {
  ok(actual === expected, `${message} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
async function throwsWithCode(fn, code, message) {
  try {
    await fn();
  } catch (error) {
    eq(error?.code, code, message);
    return error;
  }
  throw new Error(`FAIL: ${message} (did not throw)`);
}

const HOST = "/home/mon3tr/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function userMessage(text, images = [], source = { kind: "user" }) {
  return {
    role: "user",
    source,
    content: [
      ...text === undefined ? [] : [{ type: "text", text }],
      ...images.map((attachment) => ({ type: "image", attachment })),
    ],
  };
}
function assistantImage(attachment) {
  return { role: "assistant", source: { kind: "model" }, content: [{ type: "image", attachment }] };
}
/** Producer-supplied context, which the harness also delivers as a user-role message. */
function pluginContext(text, images = []) {
  return userMessage(text, images, { kind: "plugin", plugin: "dsh-agent-instructions", form: "snapshot" });
}
function ref(id) {
  return { attachmentId: id, mediaType: "image/png", bytes: 11, width: 8, height: 8 };
}

// ------------------------------------------------------------------- config
eq(pluginName, "dsh-plugin-image-model", "plugin name");
const parsed = new Config({
  providers: [{ id: "img", baseURL: "https://example.test/v1", models: [{ id: "m1" }] }],
});
ok(Array.isArray(parsed.providers), "config parses a provider list");
eq(parsed.providers[0].edits, true, "edits defaults on");
eq(parsed.providers[0].contextWindow, DEFAULT_CONTEXT_WINDOW, "context window defaults");

eq(normalizeRoute({ baseURL: "https://x/v1", models: [{ id: "m" }] }), undefined, "a route without an id is dropped");
eq(normalizeRoute({ id: "a", models: [{ id: "m" }] }), undefined, "a route without a baseURL is dropped");
eq(normalizeRoute({ id: "a", baseURL: "https://x/v1", models: [] }), undefined, "a route with no model is dropped");
eq(normalizeRoute({ id: "a", baseURL: "https://x/v1", models: [{ name: "no id" }] }), undefined, "a model without an id is dropped");

const route = normalizeRoute({
  id: " img ",
  baseURL: " https://example.test/v1 ",
  apiKeyEnv: "IMG_KEY",
  models: [{ id: "gpt-image-1", size: "1024x1024" }],
});
eq(route.id, "img", "route id trimmed");
eq(route.baseURL, "https://example.test/v1", "baseURL trimmed");
eq(route.name, "img", "name falls back to the id");
eq(route.models[0].name, "gpt-image-1", "model name falls back to the id");
eq(route.edits, true, "edits default preserved");
eq(normalizeRoute({ id: "a", baseURL: "https://x/v1", edits: false, models: [{ id: "m" }] }).edits, false, "edits can be disabled");

const routes = normalizeRoutes([
  { id: "dup", baseURL: "https://x/v1", models: [{ id: "m" }] },
  { id: "dup", baseURL: "https://y/v1", models: [{ id: "n" }] },
  { id: "bad" },
]);
eq(routes.length, 1, "duplicate and unusable routes are rejected");

// apply() always takes the llm dependency now: the settings panel can add the
// first provider while the process runs, so registration is deferred, not skipped.
let injected = false;
apply({ inject: () => { injected = true; }, logger: { info() {} } }, { providers: [] });
eq(injected, true, "apply injects llm even with nothing configured, so a later save can register");

// ------------------------------------------------------------------ request
eq(messageText(userMessage("hello")), "hello", "text extracted");
eq(resolvePrompt([userMessage("first"), assistantImage(ref("a")), userMessage("second")]), "second", "prompt is the newest user text");
eq(resolvePrompt([userMessage("keep"), userMessage(undefined, [ref("a")])]), "keep", "an image-only message is not a prompt");
eq(resolvePrompt([]), "", "no prompt yields empty");
eq(resolvePrompt([{ role: "assistant", content: [{ type: "text", text: "no" }] }]), "", "assistant text is not a prompt");

eq(findSourceImage([userMessage("x")]), undefined, "no image means generation");
eq(findSourceImage([assistantImage(ref("old")), userMessage("refine")]).attachmentId, "old", "refines the previous generated image");
eq(
  findSourceImage([assistantImage(ref("old")), userMessage("edit this", [ref("attached")])]).attachmentId,
  "attached",
  "an attached image wins over the previous generation",
);

const generateOptions = modelOptions({ size: "1024x1024", responseFormat: "b64_json", quality: "high" }, false);
eq(generateOptions.size, "1024x1024", "declared size is sent");
eq(generateOptions.response_format, "b64_json", "response_format is sent when generating");
eq(modelOptions({ responseFormat: "b64_json" }, true).response_format, undefined, "response_format is never sent when editing");
eq(Object.keys(modelOptions({}, false)).length, 0, "undeclared options are not defaulted");

// ---------------------------------------------------------------- images api
eq(detectMediaType(PNG), "image/png", "PNG detected");
eq(detectMediaType(new Uint8Array([0xff, 0xd8, 0xff, 0])), "image/jpeg", "JPEG detected");
eq(detectMediaType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0])), "image/gif", "GIF detected");
eq(
  detectMediaType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 9, 9, 9, 9, 0x57, 0x45, 0x42, 0x50])),
  "image/webp",
  "WebP detected past the size field",
);
await throwsWithCode(() => detectMediaType(new Uint8Array([1, 2, 3, 4])), "INVALID_RESPONSE", "unknown bytes rejected");

eq(failureCodeForStatus(429), "RATE_LIMIT", "429 maps to RATE_LIMIT");
eq(failureCodeForStatus(503), "SERVER", "5xx maps to SERVER");
eq(failureCodeForStatus(401), "AUTH", "401 maps to AUTH");
eq(failureCodeForStatus(400), "INVALID_REQUEST", "400 maps to INVALID_REQUEST");
eq(failureCodeForStatus(undefined), "TRANSPORT", "transport failure maps to TRANSPORT");

eq(describeErrorBody('{"error":{"message":"no channel"}}'), "no channel", "json error message extracted");
eq(describeErrorBody("<html><body>nope</body></html>"), "provider returned an HTML error page", "html body is not forwarded verbatim");
ok(describeErrorBody("x".repeat(500)).length <= 240, "error text is bounded");

// A generation request: JSON body, attribution headers, b64 image.
let seen;
const okResponse = (payload) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(payload),
});
const generated = await requestImage(
  { baseURL: "https://example.test/v1/", apiKey: "k" },
  { model: "gpt-image-1", prompt: "a cat", options: { size: "1024x1024" } },
  undefined,
  async (url, init) => { seen = { url, init }; return okResponse({ data: [{ b64_json: Buffer.from(PNG).toString("base64") }] }); },
);
eq(seen.url, "https://example.test/v1/images/generations", "generation endpoint joined without a double slash");
eq(seen.init.method, "POST", "generation posts");
const body = JSON.parse(seen.init.body);
eq(body.model, "gpt-image-1", "model sent");
eq(body.prompt, "a cat", "prompt sent");
eq(body.size, "1024x1024", "declared option sent");
eq(body.n, 1, "one image requested");
eq(seen.init.headers.authorization, "Bearer k", "credential sent");
ok(Object.keys(seen.init.headers).some((key) => /user-agent/i.test(key)), "attribution headers included (adapter contract)");
eq(generated.mediaType, "image/png", "generated media type detected from bytes");

// An edit request: multipart, image part present, no JSON content-type.
const edited = await requestImage(
  { baseURL: "https://example.test/v1", apiKey: "k" },
  { model: "gpt-image-1", prompt: "bluer", options: {}, image: { data: PNG, mediaType: "image/png", name: "prev.png" } },
  undefined,
  async (url, init) => { seen = { url, init }; return okResponse({ data: [{ b64_json: Buffer.from(PNG).toString("base64") }] }); },
);
eq(seen.url, "https://example.test/v1/images/edits", "edit endpoint used when a source image is present");
ok(seen.init.body instanceof FormData, "edit body is multipart");
eq(seen.init.body.get("prompt"), "bluer", "edit prompt sent");
ok(seen.init.body.get("image") instanceof Blob, "source image attached");
eq(seen.init.headers["content-type"], undefined, "content-type left to fetch so the multipart boundary is set");
eq(edited.mediaType, "image/png", "edited media type detected");

// Provider failures classify rather than leak.
await throwsWithCode(
  () => requestImage({ baseURL: "https://x/v1" }, { model: "m", prompt: "p" }, undefined,
    async () => ({ ok: false, status: 429, text: async () => '{"error":{"message":"tpm"}}' })),
  "RATE_LIMIT", "429 body classified",
);
await throwsWithCode(
  () => requestImage({ baseURL: "https://x/v1" }, { model: "m", prompt: "p" }, undefined,
    async () => okResponse({ data: [] })),
  "EMPTY_RESPONSE", "an empty data array is EMPTY_RESPONSE",
);
await throwsWithCode(
  () => requestImage({ baseURL: "https://x/v1" }, { model: "m", prompt: "p" }, undefined,
    async () => { throw new Error("socket hang up"); }),
  "TRANSPORT", "network failure classified",
);

// ------------------------------------------------------------------ adapter
const saved = [];
const attachments = {
  async saveImage(input) {
    saved.push(input);
    return { ...ref("stored"), name: input.name };
  },
  async readImage(reference) {
    return { ref: reference, data: PNG };
  },
};
function makeAdapter(overrides = {}) {
  return new ImageModelAdapter({
    routes: [{
      id: "img",
      name: "Image",
      baseURL: "https://example.test/v1",
      apiKeyRef: "IMG_TEST_KEY",
      edits: true,
      contextWindow: 4096,
      models: [{ id: "gpt-image-1", name: "GPT Image 1", size: "1024x1024" }],
      ...overrides.route,
    }],
    attachments: () => (overrides.attachments === null ? undefined : overrides.attachments ?? attachments),
    fetchImpl: overrides.fetchImpl ?? (async () => okResponse({ data: [{ b64_json: Buffer.from(PNG).toString("base64") }] })),
  });
}

process.env.IMG_TEST_KEY = "secret";
const adapter = makeAdapter();

eq(adapter.providerInfo("img").name, "Image", "provider info name");
const listed = await adapter.listModels("img");
eq(listed.length, 1, "one model advertised");
eq(listed[0].provider, "img", "advertised model carries its provider (host validates this)");
ok(listed[0].name.length > 0, "advertised model has a name (host validates this)");
ok(listed[0].inputModalities.includes("image"), "an editing route declares image input");
const resolved = await adapter.resolveModel("img", "gpt-image-1");
eq(resolved.id, "gpt-image-1", "resolved id echoes the request (host validates this)");
ok(Number.isInteger(resolved.context.contextWindow) && resolved.context.contextWindow > 0, "context window is a positive integer (host validates this)");
eq(resolved.reasoning, undefined, "an image model declares no reasoning efforts");
eq((await makeAdapter({ route: { edits: false } }).listModels("img"))[0].inputModalities.includes("image"), false, "a non-editing route declares text only");
await throwsWithCode(() => adapter.providerInfo("nope"), "NO_ADAPTER", "unknown provider refused");

async function collect(iterable) {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

// A plain generation: one image block, a stop finish, and no tool call.
const chunks = await collect(adapter.stream({
  provider: "img",
  model: "gpt-image-1",
  system: "you are a coding agent",
  tools: [{ name: "read", description: "d", parameters: {} }],
  messages: [userMessage("a cat")],
}));
eq(chunks[0].type, "block-start", "stream opens a block");
eq(chunks[0].blockType, "image", "the block is an image");
eq(chunks[1].type, "block-end", "the block is closed");
eq(chunks[1].block.type, "image", "block-end carries an image content block");
eq(chunks[1].block.attachment.attachmentId, "stored", "the block carries the durable attachment reference");
eq(chunks.at(-1).type, "finish", "stream finishes");
eq(chunks.at(-1).reason.kind, "stop", "finish reason is stop, so the turn ends");
ok(!chunks.some((chunk) => chunk.type === "tool-call-delta"), "never emits a tool call, so the loop cannot continue");
ok(!chunks.some((chunk) => chunk.blockType === "text" || chunk.block?.type === "text"), "no text block without a revised prompt");
eq(saved.length, 1, "the image was committed to the attachment store");
eq(saved[0].mediaType, "image/png", "committed with the detected media type");
ok(!saved[0].name.includes("/"), "the display name cannot look like a path");

// A revised prompt becomes text beside the image.
const revised = await collect(makeAdapter({
  fetchImpl: async () => okResponse({
    data: [{ b64_json: Buffer.from(PNG).toString("base64"), revised_prompt: "a fluffy cat" }],
    usage: { input_tokens: 12, output_tokens: 34 },
  }),
}).stream({ provider: "img", model: "gpt-image-1", messages: [userMessage("a cat")] }));
eq(revised[0].blockType, "text", "revised prompt opens a text block first");
eq(revised[1].block.text, "a fluffy cat", "revised prompt text carried");
eq(revised[2].blockType, "image", "the image follows at the next index");
eq(revised[2].index, 1, "block indexes stay sequential");
const usageChunk = revised.find((chunk) => chunk.type === "usage");
eq(usageChunk.usage.inputTokens, 12, "provider usage mapped");
eq(usageChunk.usage.outputTokens, 34, "provider output usage mapped");

// Refinement routes to the edits endpoint with the previous image.
let editUrl;
await collect(makeAdapter({
  fetchImpl: async (url, init) => { editUrl = url; return okResponse({ data: [{ b64_json: Buffer.from(PNG).toString("base64") }] }); },
}).stream({
  provider: "img",
  model: "gpt-image-1",
  messages: [userMessage("a cat"), assistantImage(ref("prev")), userMessage("make it bluer")],
}));
ok(editUrl.endsWith("/images/edits"), "a follow-up message edits the previous image");

// The harness appends <system-reminder> blocks (workspace instructions, skill
// catalog) to the user turn. A real end-to-end run showed those blocks becoming
// the prompt, so the image request described the repository guide.
const reminder = "<system-reminder>\nInstructions from: AGENTS.md\nlots of text\n</system-reminder>";
eq(stripSystemReminders(`${reminder}\na blue cat`), "a blue cat", "a leading reminder block is removed");
eq(stripSystemReminders(`a blue cat\n${reminder}`), "a blue cat", "a trailing reminder block is removed");
eq(stripSystemReminders(`${reminder}\nkeep\n${reminder}`), "keep", "several reminder blocks are removed");
eq(stripSystemReminders(reminder), "", "a reminder-only message leaves no prompt");
ok(!stripSystemReminders(`${reminder}\nx`).includes("AGENTS.md"), "reminder body never survives");
eq(
  resolvePrompt([userMessage(`${reminder}\na blue cat sitting on a fence`)]),
  "a blue cat sitting on a fence",
  "the prompt is the user's own text, not the injected reminder",
);
eq(resolvePrompt([userMessage(reminder), userMessage("real prompt")]), "real prompt", "a reminder-only turn is skipped");

// Injected context arrives as a user-ROLE message with a plugin SOURCE. A real
// end-to-end run sent the runtime-context snapshot as the prompt, because role
// alone cannot tell the person's text from republished context.
ok(isHumanMessage(userMessage("hi")), "a person's message is human");
ok(!isHumanMessage(pluginContext("Current runtime context...")), "injected context is not human");
ok(!isHumanMessage({ role: "assistant", source: { kind: "model" }, content: [] }), "an assistant message is not human");
eq(
  resolvePrompt([userMessage("a blue cat"), pluginContext("Current runtime context. This snapshot supersedes...")]),
  "a blue cat",
  "injected context after the prompt does not become the prompt",
);
eq(
  resolvePrompt([pluginContext("Instructions from: AGENTS.md"), userMessage("a blue cat")]),
  "a blue cat",
  "injected context before the prompt is ignored",
);
eq(resolvePrompt([pluginContext("only context")]), "", "context alone yields no prompt");
eq(
  resolvePrompt([{ role: "user", content: [{ type: "text", text: "unsourced" }] }]),
  "unsourced",
  "a message without a declared source still yields a prompt",
);
eq(
  findSourceImage([assistantImage(ref("real")), pluginContext("ctx", [ref("injected")])]).attachmentId,
  "real",
  "an image inside injected context is not an edit target",
);

// Auxiliary consumers reuse the session route; answering them costs a billed
// image. A real run showed the session-title generator hitting the endpoint.
ok(shouldGenerate(undefined), "an unclassified call generates");
ok(shouldGenerate("assistant"), "the agent's own turn generates");
ok(!shouldGenerate("session-title"), "session titling does not generate");
ok(!shouldGenerate("compaction"), "compaction does not generate");
ok(!shouldGenerate("some-future-purpose"), "an unknown purpose refuses rather than spends");

let auxCalls = 0;
await throwsWithCode(
  () => collect(makeAdapter({ fetchImpl: async () => { auxCalls += 1; return okResponse({ data: [] }); } })
    .stream({ provider: "img", model: "gpt-image-1", purpose: "session-title", messages: [userMessage("title me")] })),
  "INVALID_REQUEST", "a session-title request is refused",
);
eq(auxCalls, 0, "a refused purpose never reaches the provider");

// Failure paths.
await throwsWithCode(
  () => collect(adapter.stream({ provider: "img", model: "gpt-image-1", messages: [userMessage(undefined, [ref("a")])] })),
  "INVALID_REQUEST", "a promptless request is refused",
);
delete process.env.IMG_TEST_KEY;
await throwsWithCode(
  () => collect(adapter.stream({ provider: "img", model: "gpt-image-1", messages: [userMessage("x")] })),
  "MISSING_CREDENTIAL", "a missing credential fails the call, not the registration",
);
process.env.IMG_TEST_KEY = "secret";
await throwsWithCode(
  () => collect(makeAdapter({ attachments: null }).stream({ provider: "img", model: "gpt-image-1", messages: [userMessage("x")] })),
  "INVARIANT", "a missing attachment store is reported clearly",
);

// An admission refusal must name the limit and the option that fixes it. The
// real store enforces 2000px per side and 3.5 MiB by default, so a large
// generation is a routine outcome rather than an exotic one.
const limits = { maxImageBytes: 3670016, maxImageDimension: 2000, maxImagePixels: 40000000 };
const tooLarge = admissionFailure(
  Object.assign(new Error("Image exceeds the configured byte limit."), { code: "IMAGE_TOO_LARGE" }),
  { data: new Uint8Array(5_000_000), mediaType: "image/png" },
  limits,
);
eq(tooLarge.code, "INVALID_RESPONSE", "an oversized image is a response problem, not a retryable one");
ok(tooLarge.message.includes("3670016"), "the byte limit is reported");
ok(tooLarge.message.includes("5000000"), "the actual size is reported");
ok(/outputFormat: jpeg/.test(tooLarge.message), "the actionable option is named");
ok(
  admissionFailure(Object.assign(new Error("x"), { code: "IMAGE_DIMENSION_TOO_LARGE" }), { data: PNG }, limits)
    .message.includes("2000px"),
  "the dimension limit is reported",
);
ok(
  admissionFailure(Object.assign(new Error("x"), { code: "IMAGE_TOO_MANY_PIXELS" }), { data: PNG }, limits)
    .message.includes("40000000"),
  "the pixel limit is reported",
);
const unrelated = new Error("disk full");
eq(admissionFailure(unrelated, { data: PNG }, limits), unrelated, "an unrelated error is passed through untouched");
eq(
  admissionFailure(Object.assign(new Error("x"), { code: "IMAGE_TOO_LARGE" }), { data: PNG }, undefined).code,
  "INVALID_RESPONSE",
  "missing limits still yield a usable message",
);

// The refusal must reach the caller through stream(), not be swallowed.
await throwsWithCode(
  () => collect(makeAdapter({
    attachments: {
      imageLimits: limits,
      async saveImage() { throw Object.assign(new Error("Image exceeds the configured byte limit."), { code: "IMAGE_TOO_LARGE" }); },
      async readImage(reference) { return { ref: reference, data: PNG }; },
    },
  }).stream({ provider: "img", model: "gpt-image-1", messages: [userMessage("x")] })),
  "INVALID_RESPONSE", "an admission refusal surfaces from stream()",
);

eq(normalizeUsage(undefined), undefined, "absent usage stays absent");
eq(normalizeUsage({ input_tokens: 0, output_tokens: 0 }), undefined, "all-zero usage is not reported");
eq(normalizeUsage({ prompt_tokens: 5 }).inputTokens, 5, "legacy usage field accepted");
eq(fileNameFor("A Cat!!", "image/png"), "a-cat.png", "file name slugged");
eq(fileNameFor("", "image/jpeg"), "image.jpg", "empty prompt yields a default name");
eq(fileNameFor("../../etc/passwd", "image/png"), "etc-passwd.png", "path separators cannot survive the slug");

// -------------------------------------------------------- settings persistence
// The settings file is the panel's storage; the loader patch is only a seed.
eq(isCredentialRef("OPENAI_API_KEY"), true, "a POSIX identifier is a valid credential reference");
eq(isCredentialRef("_key1"), true, "a leading underscore is valid");
eq(isCredentialRef("2KEY"), false, "a leading digit is rejected");
eq(isCredentialRef("MY-KEY"), false, "a hyphen is rejected");
eq(isCredentialRef("MY KEY"), false, "whitespace is rejected");
eq(isCredentialRef(""), false, "an empty reference is rejected");

const withRef = normalizeRoute({ id: "a", baseURL: "https://x/v1", apiKeyRef: "K", models: [{ id: "m" }] });
eq(withRef.apiKeyRef, "K", "apiKeyRef is kept");
const withEnv = normalizeRoute({ id: "a", baseURL: "https://x/v1", apiKeyEnv: "LEGACY_KEY", models: [{ id: "m" }] });
eq(withEnv.apiKeyRef, "LEGACY_KEY", "the older apiKeyEnv name still resolves as a credential reference");
eq(
  normalizeRoute({ id: "a", baseURL: "https://x/v1", apiKeyRef: "bad-ref", models: [{ id: "m" }] }).apiKeyRef,
  undefined,
  "an unusable reference is dropped rather than stored",
);

eq(
  mergeProviders([{ id: "seeded", baseURL: "https://seed/v1" }], { providers: [{ id: "seeded", baseURL: "https://file/v1" }] })[0].baseURL,
  "https://file/v1",
  "the settings file wins over the seed for the same id",
);
eq(
  mergeProviders([{ id: "seeded" }], { removed: ["seeded"] }).length,
  0,
  "a provider removed in the panel does not come back from the seed",
);
eq(
  mergeProviders([{ id: "seeded" }], { providers: [{ id: "added" }] }).length,
  2,
  "seed and file entries coexist when their ids differ",
);

const home = mkdtempSync(join(tmpdir(), "dsh-image-settings-"));
const path = configPath(home);
ok(path.endsWith(join("image-model", "config.json")), "config path is namespaced under the DSH home");
eq(readConfig(path).providers.length, 0, "a missing config file reads as empty");
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, "{ not json");
eq(readConfig(path).providers.length, 0, "a corrupt config file reads as empty instead of breaking the panel");
writeConfig(path, { providers: [{ id: "kept" }], removed: [] });
eq(readConfig(path).providers[0].id, "kept", "a written document round-trips");
eq(readdirSync(dirname(path)).filter((entry) => entry.endsWith(".tmp")).length, 0, "no temporary file survives an atomic write");

// ------------------------------------------------------------ settings bridge
class FakeCredentials {
  constructor() { this.values = new Map(); }
  async resolve(ref) { return this.values.has(ref) ? { value: this.values.get(ref), source: "file" } : undefined; }
  async describe(ref) { return { configured: this.values.has(ref), writable: true, source: this.values.has(ref) ? "file" : undefined }; }
  async set(ref, value) { this.values.set(ref, value); }
  async unset(ref) { this.values.delete(ref); }
}

/** Minimal request/response doubles matching what the host web server passes. */
function request(method, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  return { method, [Symbol.asyncIterator]: async function* () { yield* chunks; } };
}
function response() {
  return {
    status: undefined,
    headers: undefined,
    body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(text) { this.body = text ?? ""; },
    get json() { return this.body === "" ? undefined : JSON.parse(this.body); },
  };
}

const bridgeHome = mkdtempSync(join(tmpdir(), "dsh-image-bridge-"));
const bridgePath = configPath(bridgeHome);
const credentials = new FakeCredentials();
credentials.values.set("SEED_KEY", "secret-value");
const applied = [];
const bridge = createSettingsBridge({
  seed: [{ id: "seeded", baseURL: "https://seed/v1", apiKeyRef: "SEED_KEY", models: [{ id: "seed-model" }] }],
  path: bridgePath,
  credentials: () => credentials,
  onChange: (routes) => applied.push(routes.map((route) => route.id)),
});

let res = response();
await bridge.handleConfig(request("GET"), res);
eq(res.status, 200, "GET config answers 200");
eq(res.json.providers[0].id, "seeded", "GET config reports the seeded route");
eq(res.json.seeded[0], "seeded", "GET config marks which ids came from the loader patch");
eq(res.json.credentials.SEED_KEY.configured, true, "a configured credential is reported as configured");
ok(!res.body.includes("secret-value"), "a credential value never reaches the panel");

res = response();
await bridge.handleConfig(request("POST", {
  providers: [
    { id: "added", baseURL: "https://added/v1", apiKeyRef: "ADDED_KEY", models: [{ id: "added-model", size: "1024x1024" }] },
    { id: "junk", baseURL: "https://junk/v1", models: [] },
  ],
}), res);
eq(res.status, 200, "POST config answers 200");
eq(res.json.providers.length, 1, "a provider without a usable model is not persisted");
eq(res.json.providers[0].id, "added", "the saved provider is returned");
eq(applied.length, 1, "saving re-registers the routes in the running process");
eq(JSON.stringify(applied[0]), JSON.stringify(["added"]), "the applied route set matches what was saved");
eq(readConfig(bridgePath).removed[0], "seeded", "dropping a seeded provider records it as removed");
res = response();
await bridge.handleConfig(request("GET"), res);
eq(res.json.providers.length, 1, "the removed seed does not return on the next read");
eq(res.json.providers[0].models[0].size, "1024x1024", "declared generation options persist");

res = response();
await bridge.handleConfig(request("DELETE"), res);
eq(res.status, 405, "an unsupported method is refused");

res = response();
await bridge.handleConfig({ method: "POST", [Symbol.asyncIterator]: async function* () { yield Buffer.from("{ broken"); } }, res);
eq(res.status, 400, "an unparsable body is refused");

// ---------------------------------------------------------- credential route
res = response();
await bridge.handleCredential(request("POST", { ref: "ADDED_KEY", value: "pasted" }), res);
eq(res.status, 200, "storing a credential answers 200");
eq(credentials.values.get("ADDED_KEY"), "pasted", "the value goes to the host credential store");
ok(!res.body.includes("pasted"), "the stored value is not echoed back");
eq(res.json.credentials.ADDED_KEY.configured, true, "the panel learns the credential is now configured");

res = response();
await bridge.handleCredential(request("POST", { ref: "ADDED_KEY", value: "" }), res);
eq(credentials.values.has("ADDED_KEY"), false, "an empty value unsets the credential");

res = response();
await bridge.handleCredential(request("POST", { ref: "not a ref", value: "x" }), res);
eq(res.status, 400, "an invalid credential reference is refused");

res = response();
await bridge.handleCredential(request("GET"), res);
eq(res.status, 405, "the credential route only accepts writes");

const bridgeless = createSettingsBridge({ seed: [], path: configPath(mkdtempSync(join(tmpdir(), "dsh-image-nocred-"))), credentials: () => undefined });
res = response();
await bridgeless.handleCredential(request("POST", { ref: "K", value: "v" }), res);
eq(res.status, 503, "without a credential service the route says so instead of failing opaquely");
eq(Object.keys(await describeCredentials(() => undefined, [{ apiKeyRef: "K" }])).length, 0, "describing credentials without a service yields nothing");

// -------------------------------------------------- live registration through apply
class FakeHandle {
  constructor(ids) { this.ids = ids; this.disposed = false; }
  replace(ids) { this.ids = ids; }
}
const liveHome = mkdtempSync(join(tmpdir(), "dsh-image-live-"));
process.env.DSH_HOME = liveHome;
const registrations = [];
let liveHandle;
const llmCtx = {
  get: () => undefined,
  logger: { warn() {}, info() {} },
  effect: (factory) => { const dispose = factory(); return dispose; },
  inject: () => {},
  llm: {
    registerAdapter(ids, adapter) {
      registrations.push([...ids]);
      liveHandle = Object.assign(function dispose() { liveHandle.disposed = true; }, new FakeHandle(ids));
      liveHandle.replace = (next) => { liveHandle.ids = next; registrations.push([...next]); };
      liveHandle.adapter = adapter;
      return liveHandle;
    },
  },
};
apply({ inject: (_deps, callback) => callback(llmCtx), logger: llmCtx.logger }, { providers: [] });
eq(registrations.length, 0, "an empty configuration registers nothing, since an empty initial route set is rejected");

const liveRoutes = [{ id: "live", baseURL: "https://live/v1", models: [{ id: "m" }] }];
apply({ inject: (_deps, callback) => callback(llmCtx), logger: llmCtx.logger }, { providers: liveRoutes });
eq(JSON.stringify(registrations[0]), JSON.stringify(["live"]), "a configured provider registers at boot");
eq(liveHandle.adapter.routeIds()[0], "live", "the adapter serves the registered route");
liveHandle.adapter.setRoutes([{ id: "swapped", baseURL: "https://x/v1", models: [{ id: "m" }] }]);
eq(liveHandle.adapter.routeIds()[0], "swapped", "setRoutes swaps the served table in one assignment");
delete process.env.DSH_HOME;

// -------------------------------------------- credential resolution in the adapter
const credAdapter = new ImageModelAdapter({
  routes: [{ id: "p", name: "P", baseURL: "https://x/v1", apiKeyRef: "STORE_KEY", edits: false, contextWindow: 4096, models: [{ id: "m", name: "m" }] }],
  attachments: () => undefined,
  credentials: () => credentials,
});
credentials.values.set("STORE_KEY", "from-store");
let sent;
const credStream = new ImageModelAdapter({
  routes: [{ id: "p", name: "P", baseURL: "https://x/v1", apiKeyRef: "STORE_KEY", edits: false, contextWindow: 4096, models: [{ id: "m", name: "m" }] }],
  attachments: () => ({ async saveImage() { return { id: "sha256:x", mediaType: "image/png", width: 1, height: 1, bytes: 1 }; } }),
  credentials: () => credentials,
  fetchImpl: async (_url, options) => {
    sent = options;
    return okResponse({ data: [{ b64_json: Buffer.from(PNG).toString("base64") }] });
  },
});
for await (const _chunk of credStream.stream({ provider: "p", model: "m", messages: [userMessage("a cat")] })) { /* drain */ }
eq(sent.headers.authorization, "Bearer from-store", "the key resolved through the credential store reaches the request");

credentials.values.delete("STORE_KEY");
await throwsWithCode(
  () => collect(credAdapter.stream({ provider: "p", model: "m", messages: [userMessage("a cat")] })),
  "MISSING_CREDENTIAL",
  "an unset credential fails with a stable code",
);

// ------------------------------------------------------------------ client half
const clientSource = readFileSync(new URL("../plugins/dsh-plugin-image-model/lib/client.js", import.meta.url), "utf8");
let capturedClient;
globalThis.window = { __ModuleLoader__: { load: (entry) => { capturedClient = entry; } } };
const styleTags = [];
globalThis.document = {
  head: { appendChild: (tag) => styleTags.push(tag) },
  createElement: () => ({ dataset: {}, textContent: "", remove() {} }),
};
vm.runInThisContext(clientSource, { filename: "dsh-plugin-image-model/lib/client.js" });
eq(capturedClient?.id, "dsh-plugin-image-model", "client module id");
const clientModule = capturedClient.factory((spec) => {
  if (spec === "react") {
    return {
      useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
      useEffect: () => {},
      useCallback: (fn) => fn,
      useMemo: (factory) => factory(),
      useRef: (value) => ({ current: value }),
    };
  }
  if (spec === "react/jsx-runtime") return { jsx: (type, props, key) => ({ type, props, key }) };
  throw new Error(`unexpected require: ${spec}`);
});
eq(clientModule.name, "dsh-plugin-image-model", "client plugin name");
eq(JSON.stringify(clientModule.inject), JSON.stringify(["slots", "locale"]), "client inject contract");
eq(clientModule.blankProvider(2).models.length, 1, "a new provider starts with one model row");
eq(clientModule.blankProvider(2).edits, true, "refinement is on by default for a new provider");
eq(clientModule.providersOf({ providers: [{ id: "x" }] }).length, 1, "a provider list is read from the response");
eq(clientModule.providersOf({ ok: false }).length, 0, "a failure body yields no providers");

const slotRegistrations = [];
const clientCtx = {
  effect: (factory) => { factory(); },
  locale: { register: () => () => {}, bind: () => (key) => key },
  slots: {
    inject: (_name, register) => register(),
    register: (entry, component) => { slotRegistrations.push({ entry, component }); return () => {}; },
  },
};
clientModule.apply(clientCtx);
eq(slotRegistrations.length, 1, "the client registers exactly one settings section");
eq(slotRegistrations[0].entry.name, "settings.section", "it uses the public settings.section slot");
eq(slotRegistrations[0].entry.id, "image-models", "section id");
eq(slotRegistrations[0].entry.locale, "dsh-plugin-image-model", "the section declares its locale namespace");
ok(slotRegistrations[0].entry.order > 10, "the section sorts after the host's own Models section");
eq(styleTags.length, 1, "the client injects exactly one style tag");
eq(styleTags[0].dataset.plugin, "dsh-plugin-image-model", "the style tag is attributable to this plugin");
ok(!/--dsw-alias-bg-base/.test(clientSource), "the panel does not paint the token the wallpaper plugin forces transparent");
ok(/loading/.test(String(slotRegistrations[0].component({ t: (key) => key })?.props?.children)), "the section renders a loading state before the first fetch");


// ------------------------------------------------- installed-host cross-checks
const llmTypes = readFileSync(`${HOST}/dsh-llm/lib/types/types.d.ts`, "utf8");
ok(/'image':\s*ImageBlock/.test(llmTypes), "the host still declares an image content block");
ok(llmTypes.includes("type: 'block-end'"), "block-end still carries an assembled block");
const llmIndex = readFileSync(`${HOST}/dsh-llm/lib/types/index.d.ts`, "utf8");
ok(llmIndex.includes("registerAdapter"), "registerAdapter is still the registration seam");
ok(llmIndex.includes("export declare abstract class LlmAdapter"), "LlmAdapter is still exported");
ok(!/outputModalities/.test(llmTypes), "still no output-modality concept, so an adapter remains the only seam");

const runtime = readFileSync(`${HOST}/dsh-client-runtime/lib/client.js`, "utf8");
ok(/case "image": return \{\s*kind: "image",\s*attachment: block\.attachment/.test(runtime), "the client still maps an image block to an assistant image node");
const conversation = readFileSync(`${HOST}/dsh-client-ui-conversation/lib/client.js`, "utf8");
ok(conversation.includes('blocks[chunk.index] = (0, _deepseek_ai_dsh_client_runtime_client.toAssistantBlock)(chunk.block)'), "block-end still projects through toAssistantBlock");
ok(/case "image": \{\s*const start = i;/.test(conversation), "AssistantMarkdown still renders image blocks");

const attachmentTypes = readFileSync(`${HOST}/dsh-attachment/lib/types/index.d.ts`, "utf8");
ok(attachmentTypes.includes("abstract saveImage"), "saveImage is still the commit seam");
ok(attachmentTypes.includes("abstract readImage"), "readImage is still available for refinement");

// The panel exists because the host's provider editor cannot host a third-party
// namespace: it selects its form by namespace name and disables submit for an
// unknown one. If that ever changes, this design should be revisited.
const settingsModels = readFileSync(`${HOST}/dsh-client-ui-settings-models/lib/client.js`, "utf8");
ok(/function layoutOf\(ns\)/.test(settingsModels), "the host still picks a provider form by settings namespace");
ok(settingsModels.includes('if (ns === "llm-pi-ai") return "pi-ai";'), "only the host's own namespaces have an editor");
ok(/return "unknown"/.test(settingsModels), "any other namespace still falls through to unknown");
ok(/layout === "unknown"/.test(settingsModels), "an unknown namespace still renders the inert branch with submit disabled");
const settingsGeneral = readFileSync(`${HOST}/dsh-client-ui-settings-general/lib/client.js`, "utf8");
ok(/"settings\.section": \{\s*kind: "list"/.test(settingsGeneral), "settings.section is still a list slot a plugin may join");

const credentialTypes = readFileSync(`${HOST}/dsh-credentials/lib/types/index.d.ts`, "utf8");
for (const method of ["abstract resolve", "abstract describe", "abstract set", "abstract unset"]) {
  ok(credentialTypes.includes(method), `the credential service still exposes ${method.split(" ")[1]}`);
}
ok(credentialTypes.includes("export declare function credentialRef"), "credentialRef is still the branding helper");

const llmDirectory = readFileSync(`${HOST}/dsh-llm/lib/types/index.d.ts`, "utf8");
ok(llmDirectory.includes("replace(entries"), "a registration handle still replaces its route set atomically");

console.log(`image-model ok (${checks} checks)`);

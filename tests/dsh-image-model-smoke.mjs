// Smoke test for dsh-plugin-image-model.
//
// The plugin depends on three host contracts that live outside this repository:
// `image` must stay a declared content-block type, the client must keep mapping
// an image block into an assistant node, and `registerAdapter` must stay the
// registration seam. Those are cross-checked against the installed host, so a
// future upgrade fails here instead of silently producing invisible images.
import { readFileSync } from "node:fs";

// Imports target the mirrored runtime copy, per the repository test convention.

import {
  Config,
  apply,
  name as pluginName,
  normalizeRoute,
  normalizeRoutes,
} from "/home/mon3tr/.dsh/profiles/node_modules/dsh-plugin-image-model/lib/index.js";
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

// apply() must not register anything when nothing usable is configured.
let injected = false;
apply({ inject: () => { injected = true; }, logger: { info() {} } }, { providers: [] });
eq(injected, false, "no adapter is registered without a usable provider");

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
      apiKeyEnv: "IMG_TEST_KEY",
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

console.log(`image-model ok (${checks} checks)`);

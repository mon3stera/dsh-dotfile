/**
 * Smoke test for dsh-plugin-font (client factory + host handlers with stubs).
 * Run: node tests/dsh-font-smoke.mjs (from the repo root)
 */
import { readFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const PLUGIN_DIR = fileURLToPath(new URL("../plugins/dsh-plugin-font/", import.meta.url));
// Host-side deps (@deepseek-ai/*) resolve from the DSH installation, so the host
// half imports from there; the client half uses PLUGIN_DIR (this repo's copy).
const INSTALLED_PLUGIN_DIR = "/home/mon3tr/.dsh/profiles/node_modules/dsh-plugin-font";
const TEST_HOME = "/home/mon3tr/dsh-font-test-home";
process.env.DSH_HOME = TEST_HOME;
rmSync(TEST_HOME, { recursive: true, force: true });
mkdirSync(TEST_HOME, { recursive: true });

const host = await import(`${INSTALLED_PLUGIN_DIR}/lib/index.js`);

// ---------- client stubs ----------
const styleProps = {};
const docEl = {
  style: {
    setProperty(k, v) { styleProps[k] = v; },
    removeProperty(k) { delete styleProps[k]; }
  }
};
const fakeBody = {
  dataset: {},
  style: {
    setProperty(k, v) { styleProps[k] = v; },
    removeProperty(k) { delete styleProps[k]; }
  }
};
const styleTags = [];
globalThis.document = {
  documentElement: docEl,
  body: fakeBody,
  head: {
    appendChild(tag) { styleTags.push(tag); }
  },
  querySelectorAll() { return []; },
  createElement(tag) { return { dataset: {}, textContent: "" }; },
  getElementById() { return { value: "" }; }
};
const FONT_VARS = new Map();
FONT_VARS.set("--dsw-font-family", "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif");
FONT_VARS.set("--ds-font-family-code", "'SF Mono', 'JetBrains Mono', Consolas");
const BASELINES = {
  base: [16, 28, 400, "normal"], "base-italic": [16, 28, 400, "italic"], "base-strong": [16, 28, 600, "normal"], "base-strong-italic": [16, 28, 600, "italic"],
  h1: [24, 34, 700, "normal"], h2: [22, 32, 700, "normal"], h3: [20, 30, 700, "normal"], h4: [16, 28, 600, "normal"],
  table: [15, 25, 400, "normal"], "table-head": [15, 25, 500, "normal"],
  small: [14, 24, 400, "normal"], "small-strong": [14, 24, 600, "normal"], "small-italic": [14, 24, 400, "italic"], "small-strong-italic": [14, 24, 600, "italic"],
  code: [14, 22, 400, "normal"], "code-block": [13, 22, 400, "normal"], "code-block-small": [12, 18, 400, "normal"]
};
for (const [f, [size, lh, weight, style]] of Object.entries(BASELINES)) {
  FONT_VARS.set(`--dsw-font-markdown-${f}-font-size`, `${size}px`);
  FONT_VARS.set(`--dsw-font-markdown-${f}-line-height`, `${lh}px`);
  FONT_VARS.set(`--dsw-font-markdown-${f}-font-weight`, String(weight));
  FONT_VARS.set(`--dsw-font-markdown-${f}-font-style`, style);
  FONT_VARS.set(`--dsw-font-markdown-${f}-font-family`, f.startsWith("code") ? "'SF Mono', 'JetBrains Mono', Consolas" : "-apple-system, BlinkMacSystemfont, 'Segoe UI', sans-serif");
}
globalThis.getComputedStyle = () => ({ getPropertyValue: (v) => FONT_VARS.get(v) || "" });

const postedConfigs = [];
let configStore = null; // null => 404
globalThis.fetch = async (url, opts) => {
  if (url === "/font/list") {
    return { ok: true, status: 200, json: async () => ({ ok: true, families: ["DejaVu Sans", "LXGW WenKai", "Noto Sans SC"], mono: ["JetBrainsMono Nerd Font", "Noto Sans Mono"] }) };
  }
  if (url === "/font/config" && opts?.method === "POST") {
    postedConfigs.push(JSON.parse(opts.body));
    return { ok: true, status: 200 };
  }
  if (url === "/font/config") {
    if (!configStore) return { ok: false, status: 404 };
    return { ok: true, status: 200, json: async () => configStore };
  }
  throw new Error("unexpected fetch " + url);
};

/** defineStore stub: declaration object + instance with bound actions. */
const defineStoreStub = (decl) => ({
  spec: decl,
  create() {
    const snap = decl.init();
    const actions = {};
    for (const key of Object.keys(decl.actions)) {
      actions[key] = (...params) => decl.actions[key](snap, ...params);
    }
    return { actions, getSnapshot: () => snap };
  }
});

// ---------- load the client factory (require stubbed like the background smoke) ----------
const raw = readFileSync(`${PLUGIN_DIR}/lib/client.js`, "utf8");
let capturedEntry = null;
globalThis.window = { __ModuleLoader__: { load: (entry) => { capturedEntry = entry; } } };
vm.runInThisContext(raw, { filename: "dsh-plugin-font/lib/client.js" });
const clientExports = capturedEntry.factory((spec) => {
  if (spec === "react/jsx-runtime") return { jsx: (type, props, key) => ({ type, props, key }) };
  if (spec === "@deepseek-ai/dsh-client-runtime/client") return { defineStore: defineStoreStub };
  throw new Error("FAIL: unexpected require: " + spec);
});
if (clientExports.name !== "dsh-plugin-font") throw new Error("FAIL: name");
if (JSON.stringify(clientExports.inject) !== JSON.stringify(["slots", "locale"])) throw new Error("FAIL: inject: " + JSON.stringify(clientExports.inject));

// ---------- apply() ----------
const storeDecl = { spec: null };
const ctx = {
  _effects: [],
  effect(cb) { ctx._effects.push(cb); const out = cb(); return () => (typeof out === "function" ? out() : undefined); },
  locale: { register: (ns, dicts) => { ctx._locales = dicts; } },
  slots: {
    inject(key, cb) { ctx._slotCb = cb; cb(); },
    register(opts, Component) {
      ctx._entry = { ...opts, Component };
      ctx._entry.store = opts.store;
      return () => {};
    }
  }
};
clientExports.apply(ctx);
if (styleTags.length !== 1 || !styleTags[0].textContent.includes(".dft-input")) throw new Error("FAIL: style tag not injected");
if (!ctx._entry || ctx._entry.id !== "ui-font" || ctx._entry.order !== 21) throw new Error("FAIL: settings row registration");
if (!ctx._locales || !ctx._locales.zh["font.title"] || !ctx._locales.en["font.title"]) throw new Error("FAIL: locales");
if (Object.keys(ctx._locales.zh).sort().join(",") !== Object.keys(ctx._locales.en).sort().join(",")) throw new Error("FAIL: locale key sets differ");
console.log("apply OK: row registered, css + locales injected");

// no config yet -> default, no inline var
if (styleProps["--dsw-font-family"] !== undefined) throw new Error("FAIL: default should not set font var");

// simulate row mount: entry.inject(actions) pushes current state into the store
const storeInstance = ctx._entry.store.create();
const props = ctx._entry.inject(storeInstance.actions);
if (!props.setFamily) throw new Error("FAIL: injected setFamily missing");
const useStore = (fn) => fn(storeInstance.getSnapshot());
const renderTree = (node) => {
  if (!node || typeof node !== "object") return node;
  if (typeof node.type === "function") return renderTree(node.type(node.props || {}));
  if (node.props?.children !== undefined && node.props?.children !== null) {
    const kids = Array.isArray(node.props.children) ? node.props.children : [node.props.children];
    return { ...node, props: { ...node.props, children: kids.map(renderTree) } };
  }
  return node;
};
const renderRow = () => renderTree(ctx._entry.Component({ t: (k) => ctx._locales.zh[k] ?? k, useStore, setFamily: props.setFamily, setCodeFamily: props.setCodeFamily }));
const textInputs = (node) => countTags(node, "input").filter((i) => i.props.type !== "range");
const countTags = (node, tag, out = []) => {
  if (!node || typeof node !== "object") return out;
  if (node.type === tag) out.push(node);
  const kids = node.props?.children;
  if (Array.isArray(kids)) for (const k of kids) countTags(k, tag, out);
  else if (kids) countTags(kids, tag, out);
  return out;
};
let row = renderRow();
if (!row || row.props.className !== "dft-group") throw new Error("FAIL: row render");
if (countTags(row, "select").length !== 2) throw new Error("FAIL: expected 2 font pickers");
if (textInputs(row).length !== 0) throw new Error("FAIL: no custom input with defaults");
if (countTags(row, "input[range]").length !== 0) throw new Error("unreachable");
const stepButtons = countTags(row, "button").filter((b) => b.props.className === "dft-step");
if (stepButtons.length !== 4) throw new Error("FAIL: expected 4 stepper buttons, got " + stepButtons.length);
const previewEl = countTags(row, "div").find((d) => d.props.className === "dft-preview");
if (!previewEl || previewEl.props.style.fontSize !== "16px") throw new Error("FAIL: body preview missing: " + JSON.stringify(previewEl?.props?.style));
const previewCodeEl = countTags(row, "div").find((d) => d.props.className === "dft-preview dft-previewCode");
if (!previewCodeEl || previewCodeEl.props.style.fontSize !== "14px") throw new Error("FAIL: code preview missing: " + JSON.stringify(previewCodeEl?.props?.style));
console.log("row mount OK: 2 pickers, no custom inputs");

// catalog fetch resolved -> store fonts populated, pickers list installed fonts
await new Promise((r) => setTimeout(r, 50));
const snapshot = storeInstance.getSnapshot();
if (!snapshot.fonts || snapshot.fonts.families.length !== 3 || snapshot.fonts.mono.length !== 2) throw new Error("FAIL: fonts catalog not pushed: " + JSON.stringify(snapshot.fonts));
const optionValues = (node) => countTags(node, "select")[0].props.children.filter((c) => c && c.props && c.props.value !== undefined).map((c) => c.props.value);
const bodyOptions = optionValues(renderRow());
if (!bodyOptions.includes("LXGW WenKai") || !bodyOptions.includes("DejaVu Sans")) throw new Error("FAIL: body picker lacks installed fonts: " + JSON.stringify(bodyOptions));
const codeSelect = countTags(renderRow(), "select")[1];
const codeOptions = codeSelect.props.children.filter((c) => c && c.props && c.props.value !== undefined).map((c) => c.props.value);
if (!codeOptions.includes("JetBrainsMono Nerd Font") || codeOptions.includes("LXGW WenKai")) throw new Error("FAIL: code picker should list mono fonts only: " + JSON.stringify(codeOptions));
console.log("catalog pickers OK: body=" + bodyOptions.length + " code=" + codeOptions.length);

// set body + code fonts -> both vars restacked + persisted
props.setFamily("LXGW WenKai");
props.setCodeFamily("JetBrains Mono");
if (styleProps["--dsw-font-family"] !== "'LXGW WenKai', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif") throw new Error("FAIL: body stack: " + styleProps["--dsw-font-family"]);
if (styleProps["--ds-font-family-code"] !== "'JetBrains Mono', 'SF Mono', 'JetBrains Mono', Consolas") throw new Error("FAIL: code stack: " + styleProps["--ds-font-family-code"]);
if (storeInstance.getSnapshot().family !== "LXGW WenKai" || storeInstance.getSnapshot().codeFamily !== "JetBrains Mono") throw new Error("FAIL: store sync");
await new Promise((r) => setTimeout(r, 500));
const saved = postedConfigs.at(-1);
if (saved.family !== "LXGW WenKai" || saved.codeFamily !== "JetBrains Mono") throw new Error("FAIL: persist: " + JSON.stringify(postedConfigs));
console.log("set body/code OK:", styleProps["--dsw-font-family"], "|", styleProps["--ds-font-family-code"]);

// font sizes: body and code scale independently (markdown vars on BODY)
props.setFontSize(17);
if (styleProps["--dsw-font-markdown-base-font-size"] !== "17px") throw new Error("FAIL: base size: " + styleProps["--dsw-font-markdown-base-font-size"]);
if (styleProps["--dsw-font-markdown-base-line-height"] !== "29.8px") throw new Error("FAIL: base lh: " + styleProps["--dsw-font-markdown-base-line-height"]);
if (styleProps["--dsw-font-markdown-base"] !== "17px/29.8px -apple-system, BlinkMacSystemfont, 'Segoe UI', sans-serif") throw new Error("FAIL: base composite: " + styleProps["--dsw-font-markdown-base"]);
if (styleProps["--dsw-font-markdown-h1"] !== "700 25.5px/36.1px -apple-system, BlinkMacSystemfont, 'Segoe UI', sans-serif") throw new Error("FAIL: h1 composite: " + styleProps["--dsw-font-markdown-h1"]);
// code size independent: body at 17px does NOT touch code families
if (styleProps["--dsw-font-markdown-code-block-font-size"] !== undefined) throw new Error("FAIL: body size should not scale code");
props.setCodeFontSize(16);
if (styleProps["--dsw-font-markdown-code-block-font-size"] !== "14.9px") throw new Error("FAIL: code-block size: " + styleProps["--dsw-font-markdown-code-block-font-size"]);
if (styleProps["--dsw-font-markdown-code-font-size"] !== "16px") throw new Error("FAIL: inline code size: " + styleProps["--dsw-font-markdown-code-font-size"]);
if (styleProps["--dsw-font-markdown-code-block"] !== "14.9px/25.1px 'SF Mono', 'JetBrains Mono', Consolas") throw new Error("FAIL: code-block composite: " + styleProps["--dsw-font-markdown-code-block"]);
if (styleProps["--dsw-font-markdown-base-font-size"] !== "17px") throw new Error("FAIL: code size should not touch body");
props.setCodeFontSize(30);
if (styleProps["--dsw-font-markdown-code-block-font-size"] !== "22.3px") throw new Error("FAIL: code clamp high: " + styleProps["--dsw-font-markdown-code-block-font-size"]);
props.setCodeFontSize(10);
if (styleProps["--dsw-font-markdown-code-block-font-size"] !== "11.1px") throw new Error("FAIL: code clamp low: " + styleProps["--dsw-font-markdown-code-block-font-size"]);
props.setCodeFontSize(14);
if (styleProps["--dsw-font-markdown-code-block-font-size"] !== undefined) throw new Error("FAIL: default 14 should clear code vars");
props.setFontSize(16);
if (styleProps["--dsw-font-markdown-base-font-size"] !== undefined) throw new Error("FAIL: default 16 should clear body vars");
props.setFontSize(17);
props.setCodeFontSize(16);
if (styleProps["zoom"] !== undefined) throw new Error("FAIL: no zoom property should ever be set");
await new Promise((r) => setTimeout(r, 500));
const savedWithSize = postedConfigs.at(-1);
if (savedWithSize.fontSize !== 17 || savedWithSize.codeFontSize !== 16 || savedWithSize.scale !== undefined) throw new Error("FAIL: fontSize persist: " + JSON.stringify(savedWithSize));
row = renderRow();
const preview2 = countTags(row, "div").find((d) => d.props.className === "dft-preview");
if (!preview2 || preview2.props.style.fontSize !== "17px") throw new Error("FAIL: body preview should follow: " + JSON.stringify(preview2?.props?.style));
const previewCode2 = countTags(row, "div").find((d) => d.props.className === "dft-preview dft-previewCode");
if (!previewCode2 || previewCode2.props.style.fontSize !== "16px") throw new Error("FAIL: code preview should follow: " + JSON.stringify(previewCode2?.props?.style));
console.log("fontSizes OK: body/code independent px scaling, clamp/persist/previews");

// non-preset body font -> custom input revealed in the picker
props.setFamily("My Custom Font");
row = renderRow();
const customInputs = textInputs(row);
if (customInputs.length !== 2) throw new Error("FAIL: expected 2 custom inputs (body+code): " + customInputs.length);
if (!customInputs.some((i) => i.props.defaultValue === "My Custom Font")) throw new Error("FAIL: body custom input missing");
if (!customInputs.some((i) => i.props.defaultValue === "JetBrains Mono")) throw new Error("FAIL: code custom input missing");
console.log("custom picker inputs revealed OK (body+code)");

// clear -> both vars removed + persisted
props.setFamily("");
props.setCodeFamily("");
if (styleProps["--dsw-font-family"] !== undefined || styleProps["--ds-font-family-code"] !== undefined) throw new Error("FAIL: clear should remove vars");
await new Promise((r) => setTimeout(r, 500));
const last = postedConfigs.at(-1);
if (last.family !== "" || last.codeFamily !== "") throw new Error("FAIL: clear persist: " + JSON.stringify(last));
console.log("clear OK: vars removed");

// restore from config: fresh factory with configStore set
configStore = { family: "Noto Sans SC", codeFamily: "Fira Code", fontSize: 15, codeFontSize: 17 };
styleProps["--dsw-font-family"] = undefined;
styleProps["--ds-font-family-code"] = undefined;
postedConfigs.length = 0;
clientExports.apply(ctx);
await new Promise((r) => setTimeout(r, 50));
if (styleProps["--dsw-font-family"] !== "'Noto Sans SC', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif") throw new Error("FAIL: restore body: " + styleProps["--dsw-font-family"]);
if (styleProps["--ds-font-family-code"] !== "'Fira Code', 'SF Mono', 'JetBrains Mono', Consolas") throw new Error("FAIL: restore code: " + styleProps["--ds-font-family-code"]);
console.log("restore from config OK:", styleProps["--dsw-font-family"], "|", styleProps["--ds-font-family-code"]);
if (styleProps["--dsw-font-markdown-base-font-size"] !== "15px") throw new Error("FAIL: restore fontSize: " + styleProps["--dsw-font-markdown-base-font-size"]);
if (styleProps["--dsw-font-markdown-code-block-font-size"] !== "15.8px") throw new Error("FAIL: restore codeFontSize: " + styleProps["--dsw-font-markdown-code-block-font-size"]);
// legacy config: percentage scale migrates to a px base
configStore = { family: "", codeFamily: "", scale: 1.25 };
styleProps["--dsw-font-markdown-base-font-size"] = undefined;
clientExports.apply(ctx);
await new Promise((r) => setTimeout(r, 50));
if (styleProps["--dsw-font-markdown-base-font-size"] !== "20px") throw new Error("FAIL: legacy scale migration: " + styleProps["--dsw-font-markdown-base-font-size"]);
console.log("legacy scale migration OK (1.25 -> 20px)");

// sanitize quotes
props.setFamily(`Bad'Name"`);
if (!styleProps["--dsw-font-family"].startsWith("'BadName',")) throw new Error("FAIL: sanitize: " + styleProps["--dsw-font-family"]);
console.log("sanitize OK");

console.log("CLIENT SMOKE OK");

// ---------- host ----------
const { handleConfig, configPath } = host;
const fakeReq = (url, body, headers = {}, method = "POST") => {
  const chunks = body ? [Buffer.from(body)] : [];
  return {
    url, method, headers,
    [Symbol.asyncIterator]() {
      let i = 0;
      return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { done: true }) };
    }
  };
};
const fakeRes = () => {
  const out = { status: null, headers: null, body: null };
  return { out, writeHead(status, headers) { out.status = status; out.headers = headers; }, end(payload) { out.body = payload; } };
};

// GET before any write -> 404
let res = fakeRes();
await handleConfig(fakeReq("/font/config", null, {}, "GET"), res);
if (res.out.status !== 404) throw new Error("FAIL: config GET should 404 initially");

// POST valid -> 200 + atomic file
res = fakeRes();
await handleConfig(fakeReq("/font/config", JSON.stringify({ family: "LXGW WenKai", codeFamily: "JetBrains Mono", fontSize: 17, codeFontSize: 16 }), { "content-type": "application/json" }, "POST"), res);
if (res.out.status !== 200) throw new Error("FAIL: config POST: " + res.out.status);
if (!existsSync(configPath())) throw new Error("FAIL: config file not written");
if (readdirSync(TEST_HOME + "/font").some((n) => n.endsWith(".tmp"))) throw new Error("FAIL: tmp file left behind");

// GET roundtrip
res = fakeRes();
await handleConfig(fakeReq("/font/config", null, {}, "GET"), res);
const roundtrip = JSON.parse(res.out.body);
if (roundtrip.family !== "LXGW WenKai" || roundtrip.codeFamily !== "JetBrains Mono" || roundtrip.fontSize !== 17 || roundtrip.codeFontSize !== 16) throw new Error("FAIL: roundtrip: " + res.out.body);

// invalid -> 400
res = fakeRes();
await handleConfig(fakeReq("/font/config", JSON.stringify({ family: 42 }), { "content-type": "application/json" }, "POST"), res);
if (res.out.status !== 400) throw new Error("FAIL: non-string family should 400");
res = fakeRes();
await handleConfig(fakeReq("/font/config", JSON.stringify({ family: "x".repeat(201) }), { "content-type": "application/json" }, "POST"), res);
if (res.out.status !== 400) throw new Error("FAIL: >200 char family should 400");
res = fakeRes();
await handleConfig(fakeReq("/font/config", JSON.stringify({ codeFamily: 42 }), { "content-type": "application/json" }, "POST"), res);
if (res.out.status !== 400) throw new Error("FAIL: non-string codeFamily should 400");
res = fakeRes();
await handleConfig(fakeReq("/font/config", JSON.stringify({ fontSize: "big" }), { "content-type": "application/json" }, "POST"), res);
if (res.out.status !== 400) throw new Error("FAIL: non-number fontSize should 400");
res = fakeRes();
await handleConfig(fakeReq("/font/config", JSON.stringify({ codeFontSize: "big" }), { "content-type": "application/json" }, "POST"), res);
if (res.out.status !== 400) throw new Error("FAIL: non-number codeFontSize should 400");

// invalid JSON -> 400; wrong method -> 405
res = fakeRes();
await handleConfig(fakeReq("/font/config", "{oops", { "content-type": "application/json" }, "POST"), res);
if (res.out.status !== 400) throw new Error("FAIL: invalid JSON should 400");
res = fakeRes();
await handleConfig(fakeReq("/font/config", null, {}, "PUT"), res);
if (res.out.status !== 405) throw new Error("FAIL: PUT should 405");

// oversized config -> 413 + drained
const big = Buffer.alloc(20 * 1024, 9);
let consumed = 0;
const bigReq = {
  url: "/font/config", method: "POST", headers: { "content-type": "application/json" },
  [Symbol.asyncIterator]() {
    let i = 0; const chunks = [big];
    return { next: async () => { if (i < chunks.length) { consumed += chunks[i].length; return { value: chunks[i++], done: false }; } return { done: true }; } };
  }
};
res = fakeRes();
await handleConfig(bigReq, res);
if (res.out.status !== 413) throw new Error("FAIL: oversize config should 413");
if (consumed !== big.length) throw new Error("FAIL: oversize body not drained");

// font enumeration: parse + route with stubbed fc-list runner
const { parseFcFamilies, handleFontList, _setFontRunner, _resetFontCache } = host;
const fcRaw = "Noto Sans Khmer,Noto Sans Khmer SemiBold\n  LXGW WenKai  \nLXGW WenKai\nNoto Sans SC\n";
const parsed = parseFcFamilies(fcRaw);
if (parsed.join("|") !== "LXGW WenKai|Noto Sans Khmer|Noto Sans Khmer SemiBold|Noto Sans SC") throw new Error("FAIL: parse: " + parsed.join("|"));
let runnerCalls = 0;
_setFontRunner((query, cb) => {
  runnerCalls += 1;
  cb(null, query === ":spacing=100" ? "JetBrainsMono Nerd Font\nNoto Sans Mono\n" : fcRaw);
});
res = fakeRes();
await handleFontList(fakeReq("/font/list", null, {}, "GET"), res);
const catalog = JSON.parse(res.out.body);
if (!catalog.ok || catalog.families.length !== 4 || !catalog.mono.includes("JetBrainsMono Nerd Font")) throw new Error("FAIL: catalog: " + res.out.body);
// second call within TTL serves the cache (no extra fc-list runs)
res = fakeRes();
await handleFontList(fakeReq("/font/list", null, {}, "GET"), res);
if (runnerCalls !== 2) throw new Error("FAIL: cache: runner called " + runnerCalls + " times");
// runner failure -> ok:false (client falls back to presets)
_resetFontCache();
_setFontRunner((query, cb) => cb(new Error("no fc-list")));
res = fakeRes();
await handleFontList(fakeReq("/font/list", null, {}, "GET"), res);
const degraded = JSON.parse(res.out.body);
if (degraded.ok !== false) throw new Error("FAIL: degraded catalog: " + res.out.body);
console.log("font enumeration OK (parse, route, cache, degrade)");

console.log("HOST SMOKE OK");
rmSync(TEST_HOME, { recursive: true, force: true });
console.log("ALL CHECKS PASSED");

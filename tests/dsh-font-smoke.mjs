/**
 * Smoke test for dsh-plugin-font (client factory + host handlers with stubs).
 * Run: node tests/dsh-font-smoke.mjs (from the repo root)
 *
 * The stubbed theme mirrors DSH 0.1.2-rc.x: markdown font tokens are DERIVED
 * (base = var(--dsh-content-font-size,14px), h1-h3 = calc(21px + delta),
 * tables via a min/max secondary formula, code static 12/11/11), so the
 * client must probe resolved computed longhands instead of parsing the
 * custom-property token stream. The plugin manages ordered font stacks
 * (body/code) plus size and weight deltas.
 */
import { readFileSync, existsSync, mkdirSync, rmSync, readdirSync, writeFileSync } from "node:fs";
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
const styleGuards = [];
const fakeBody = {
  dataset: {},
  style: {
    setProperty(k, v) { styleProps[k] = v; },
    removeProperty(k) { delete styleProps[k]; },
    getPropertyValue(k) { return styleProps[k] ?? ""; }
  },
  appendChild() { }
};
globalThis.MutationObserver = class {
  constructor(cb) { styleGuards.push(cb); }
  observe() { }
  disconnect() { }
};
const styleTags = [];
const createdTags = [];
globalThis.document = {
  documentElement: docEl,
  body: fakeBody,
  head: {
    appendChild(tag) { styleTags.push(tag); }
  },
  querySelectorAll() { return []; },
  createElement(tag) {
    if (tag === "canvas") {
      /* width probe stub: Noto Sans SC / DejaVu Sans measure as locally installed */
      const ctx2d = { font: "" };
      ctx2d.measureText = (text) => ({ width: /Noto Sans SC|DejaVu Sans/.test(ctx2d.font) ? 200 : 77 });
      return { getContext: () => ctx2d };
    }
    const el = { tagName: tag, dataset: {}, textContent: "", style: {}, removed: false, remove() { el.removed = true; } };
    createdTags.push(el);
    return el;
  },
  getElementById() { return { value: "" }; }
};
const FONT_VARS = new Map();
FONT_VARS.set("--dsw-font-family", "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif");
FONT_VARS.set("--ds-font-family-code", "'SF Mono', 'JetBrains Mono', Consolas");
/** Natural theme baselines (0.1.2-rc.x): resolved px the probe must read back. */
const BASELINES = {
  base: [14, 24, 400, "normal"], "base-italic": [14, 24, 400, "italic"], "base-strong": [14, 24, 600, "normal"], "base-strong-italic": [14, 24, 600, "italic"],
  h1: [21, 30, 700, "normal"], h2: [19, 28, 700, "normal"], h3: [18, 26, 700, "normal"], h4: [14, 24, 600, "normal"],
  table: [13, 22, 400, "normal"], "table-head": [13, 22, 500, "normal"],
  small: [12, 20, 400, "normal"], "small-strong": [12, 20, 600, "normal"], "small-italic": [12, 20, 400, "italic"], "small-strong-italic": [12, 20, 600, "italic"],
  code: [12, 19, 400, "normal"], "code-block": [11, 19, 400, "normal"], "code-block-small": [11, 16, 400, "normal"]
};
for (const [f, [size, lh, weight, style]] of Object.entries(BASELINES)) {
  FONT_VARS.set(`--dsw-font-markdown-${f}-font-size`, `${size}px`);
  FONT_VARS.set(`--dsw-font-markdown-${f}-line-height`, `${lh}px`);
  FONT_VARS.set(`--dsw-font-markdown-${f}-font-weight`, String(weight));
  FONT_VARS.set(`--dsw-font-markdown-${f}-font-style`, style);
  FONT_VARS.set(`--dsw-font-markdown-${f}-font-family`, f.startsWith("code") ? "'SF Mono', 'JetBrains Mono', Consolas" : "-apple-system, BlinkMacSystemfont, 'Segoe UI', sans-serif");
}
/**
 * Probe-aware computed-style stub: when the element's inline font-size is the
 * plugin's probe variable, resolve the family's longhands like a real engine
 * would (this is the contract the client relies on); otherwise serve the
 * custom-property map for body/root reads.
 */
globalThis.getComputedStyle = (el) => {
  const match = /var\(--dsw-font-markdown-([a-z0-9-]+)-font-size\)/.exec(el?.style?.fontSize || "");
  if (match) {
    const family = match[1];
    const base = BASELINES[family];
    if (!base) {
      return { fontSize: "16px", lineHeight: "normal", fontWeight: "400", fontStyle: "normal", fontFamily: "serif", getPropertyValue: (v) => FONT_VARS.get(v) || "" };
    }
    return {
      fontSize: `${base[0]}px`,
      lineHeight: `${base[1]}px`,
      fontWeight: String(base[2]),
      fontStyle: base[3],
      fontFamily: family.startsWith("code") ? "'SF Mono', 'JetBrains Mono', Consolas" : "-apple-system, BlinkMacSystemfont, 'Segoe UI', sans-serif",
      getPropertyValue: (v) => FONT_VARS.get(v) || ""
    };
  }
  return { getPropertyValue: (v) => FONT_VARS.get(v) || "" };
};

const postedConfigs = [];
let configStore = null; // null => 404
globalThis.fetch = async (url, opts) => {
  if (url === "/font/list") {
    return { ok: true, status: 200, json: async () => ({
      ok: true,
      families: ["DejaVu Sans", "LXGW WenKai", "Noto Sans SC"],
      mono: ["JetBrainsMono Nerd Font", "Noto Sans Mono"],
      faces: {
        "LXGW WenKai": [{ ext: "ttf", weight: 80, slant: 0 }, { ext: "ttf", weight: 200, slant: 0 }],
        "DejaVu Sans": [{ ext: "otf", weight: 80, slant: 0 }],
        "Noto Sans SC": [{ ext: "otf", weight: 80, slant: 0 }]
      }
    }) };
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
  if (spec === "@deepseek-ai/dsh-client-store") return { defineStore: defineStoreStub };
  throw new Error("FAIL: unexpected require: " + spec);
});
if (clientExports.name !== "dsh-plugin-font") throw new Error("FAIL: name");
if (JSON.stringify(clientExports.inject) !== JSON.stringify(["slots", "locale"])) throw new Error("FAIL: inject: " + JSON.stringify(clientExports.inject));

// ---------- apply() ----------
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
if (!styleTags[0].textContent.includes(".dft-chip")) throw new Error("FAIL: chip styles missing");
if (!ctx._entry || ctx._entry.id !== "ui-font" || ctx._entry.order !== 21) throw new Error("FAIL: settings row registration");
if (!ctx._locales || !ctx._locales.zh["font.title"] || !ctx._locales.en["font.title"]) throw new Error("FAIL: locales");
if (Object.keys(ctx._locales.zh).sort().join(",") !== Object.keys(ctx._locales.en).sort().join(",")) throw new Error("FAIL: locale key sets differ");
console.log("apply OK: row registered, css + locales injected");

// no config yet -> follow the theme: no inline vars at all
if (styleProps["--dsw-font-family"] !== undefined) throw new Error("FAIL: default should not set font var");
if (styleProps["--dsw-font-markdown-base-font-size"] !== undefined) throw new Error("FAIL: default should not scale markdown");

// simulate row mount: entry.inject(actions) pushes current state into the store
const storeInstance = ctx._entry.store.create();
const props = ctx._entry.inject(storeInstance.actions);
if (!props.setFamilies || !props.setFontWeight || !props.setAdding) throw new Error("FAIL: injected write surface incomplete");
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
const renderRow = () => renderTree(ctx._entry.Component({ t: (k) => ctx._locales.zh[k] ?? k, useStore, ...props }));
const textInputs = (node) => countTags(node, "input").filter((i) => i.props.type === "text");
const webfontCheckbox = (node) => countTags(node, "input").find((i) => i.props.type === "checkbox");
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
if (countTags(row, "select").length !== 2) throw new Error("FAIL: expected 2 add-font selects");
if (textInputs(row).length !== 0) throw new Error("FAIL: no custom input outside custom mode");
const stepButtons = countTags(row, "button").filter((b) => b.props.className === "dft-step");
if (stepButtons.length !== 8) throw new Error("FAIL: expected 8 stepper buttons (2 sizes + 2 weights), got " + stepButtons.length);
const previewEl = countTags(row, "div").find((d) => d.props.className === "dft-preview");
if (!previewEl || previewEl.props.style.fontSize !== "14px" || previewEl.props.style.fontWeight !== "400") throw new Error("FAIL: body preview should follow theme: " + JSON.stringify(previewEl?.props?.style));
const previewCodeEl = countTags(row, "div").find((d) => d.props.className === "dft-preview dft-previewCode");
if (!previewCodeEl || previewCodeEl.props.style.fontSize !== "12px") throw new Error("FAIL: code preview should follow theme: " + JSON.stringify(previewCodeEl?.props?.style));
if (storeInstance.getSnapshot().natural.body !== 14 || storeInstance.getSnapshot().natural.code !== 12) throw new Error("FAIL: probed naturals not pushed: " + JSON.stringify(storeInstance.getSnapshot().natural));
console.log("row mount OK: 2 stack pickers, 8 steppers, naturals probed (body 14, code 12)");

// catalog fetch resolved -> pickers list installed fonts
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

// ordered stacks: both entries restacked in order
props.setFamilies(["LXGW WenKai", "Noto Sans SC"]);
props.setCodeFamilies(["JetBrains Mono"]);
if (styleProps["--dsw-font-family"] !== "'LXGW WenKai', 'Noto Sans SC', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif") throw new Error("FAIL: body stack: " + styleProps["--dsw-font-family"]);
if (styleProps["--ds-font-family-code"] !== "'JetBrains Mono', 'SF Mono', 'JetBrains Mono', Consolas") throw new Error("FAIL: code stack: " + styleProps["--ds-font-family-code"]);
if (storeInstance.getSnapshot().families.join("|") !== "LXGW WenKai|Noto Sans SC") throw new Error("FAIL: store stack sync");
console.log("set stacks OK:", styleProps["--dsw-font-family"], "|", styleProps["--ds-font-family-code"]);

// custom entry via the picker's custom mode
row = renderRow();
const bodySelect = countTags(row, "select")[0];
bodySelect.props.onChange({ target: { value: "__custom__" } });
row = renderRow();
const customs = textInputs(row);
if (customs.length !== 1) throw new Error("FAIL: expected 1 custom input in custom mode: " + customs.length);
customs[0].props.onBlur({ target: { value: "My Custom Font" } });
row = renderRow();
if (!storeInstance.getSnapshot().families.includes("My Custom Font")) throw new Error("FAIL: custom entry not added: " + JSON.stringify(storeInstance.getSnapshot().families));
if (!styleProps["--dsw-font-family"].includes("'My Custom Font',")) throw new Error("FAIL: custom entry not restacked: " + styleProps["--dsw-font-family"]);
console.log("custom picker entry OK");

// web fonts: catalog faces + the canvas width probe drive the @font-face rules.
// The probe stub reports LXGW WenKai as NOT installed, so both faces (regular
// 400 + bold 700) get rules; locally installed families get none.
await new Promise((r) => setTimeout(r, 50)); // let a late catalog fetch settle
props.setFontSize(14); // any commit re-runs applyTypography -> applyWebFonts
const webTag = styleTags.find((t) => t.dataset && t.dataset.pluginCss === "dsh-plugin-font/webfonts.css");
if (!webTag) throw new Error("FAIL: webfont style tag missing");
if (!webTag.textContent.includes("@font-face{font-family:'LXGW WenKai';src:url(\"/font/file?family=LXGW%20WenKai&index=0\") format(\"truetype\");font-display:swap;font-weight:400;font-style:normal;}")) throw new Error("FAIL: regular face rule: " + webTag.textContent);
if (!webTag.textContent.includes("index=1\") format(\"truetype\");font-display:swap;font-weight:700")) throw new Error("FAIL: bold face rule: " + webTag.textContent);
if (webTag.textContent.includes("Noto Sans SC") || webTag.textContent.includes("DejaVu Sans")) throw new Error("FAIL: locally available families must not get rules: " + webTag.textContent);
if (webTag.textContent.includes("My Custom Font")) throw new Error("FAIL: family without catalog faces must be skipped: " + webTag.textContent);
console.log("webfont rules OK: local-first skip + per-face weight mapping");

// toggle off: tag dropped; toggle on: rules rebuilt
const toggle = webfontCheckbox(renderRow());
if (!toggle) throw new Error("FAIL: webfont toggle missing from the row");
if (toggle.props.checked !== true) throw new Error("FAIL: toggle default should be on");
toggle.props.onChange({ target: { checked: false } });
if (webTag.removed !== true) throw new Error("FAIL: toggle off should remove the webfont tag");
props.setServeFontFiles(true);
const webTag2 = styleTags.filter((t) => t.dataset && t.dataset.pluginCss === "dsh-plugin-font/webfonts.css").pop();
if (!webTag2 || webTag2 === webTag || !webTag2.textContent.includes("LXGW WenKai")) throw new Error("FAIL: toggle on should recreate the rules");
console.log("webfont toggle OK");


// sizes (weight still 0): probe-resolved baselines; body and code scale independently
props.setFontSize(15);
if (styleProps["--dsh-content-font-size"] !== "15px") throw new Error("FAIL: content axis should follow the body size: " + styleProps["--dsh-content-font-size"]);
if (styleProps["--dsw-font-markdown-base-font-size"] !== "15px") throw new Error("FAIL: base size: " + styleProps["--dsw-font-markdown-base-font-size"]);
if (styleProps["--dsw-font-markdown-base-line-height"] !== "25.7px") throw new Error("FAIL: base lh: " + styleProps["--dsw-font-markdown-base-line-height"]);
if (styleProps["--dsw-font-markdown-base"] !== "15px/25.7px -apple-system, BlinkMacSystemfont, 'Segoe UI', sans-serif") throw new Error("FAIL: base composite: " + styleProps["--dsw-font-markdown-base"]);
if (styleProps["--dsw-font-markdown-h1"] !== "700 22.5px/32.1px -apple-system, BlinkMacSystemfont, 'Segoe UI', sans-serif") throw new Error("FAIL: h1 composite: " + styleProps["--dsw-font-markdown-h1"]);
if (styleProps["--dsw-font-markdown-table"] !== "13.9px/23.6px -apple-system, BlinkMacSystemfont, 'Segoe UI', sans-serif") throw new Error("FAIL: table composite: " + styleProps["--dsw-font-markdown-table"]);
if (styleProps["--dsw-font-markdown-code-block-font-size"] !== undefined) throw new Error("FAIL: body size should not scale code");

// weight delta shifts every token's own weight, code independently
props.setFontWeight(100);
if (styleProps["--dsw-font-markdown-base"] !== "500 15px/25.7px -apple-system, BlinkMacSystemfont, 'Segoe UI', sans-serif") throw new Error("FAIL: base weight: " + styleProps["--dsw-font-markdown-base"]);
if (styleProps["--dsw-font-markdown-h1"] !== "800 22.5px/32.1px -apple-system, BlinkMacSystemfont, 'Segoe UI', sans-serif") throw new Error("FAIL: h1 weight: " + styleProps["--dsw-font-markdown-h1"]);
props.setCodeFontWeight(100);
/* weight-only override on a family the size setting leaves alone: unscaled px + shifted weight */
if (styleProps["--dsw-font-markdown-code-block"] !== "500 11px/19px 'SF Mono', 'JetBrains Mono', Consolas") throw new Error("FAIL: code-block weight-only: " + styleProps["--dsw-font-markdown-code-block"]);
props.setCodeFontSize(16);
if (styleProps["--dsw-font-markdown-code-block"] !== "500 14.7px/25.3px 'SF Mono', 'JetBrains Mono', Consolas") throw new Error("FAIL: code-block size+weight: " + styleProps["--dsw-font-markdown-code-block"]);
props.setFontWeight(500);
if (styleProps["--dsw-font-markdown-base"] !== "600 15px/25.7px -apple-system, BlinkMacSystemfont, 'Segoe UI', sans-serif") throw new Error("FAIL: weight clamp high: " + styleProps["--dsw-font-markdown-base"]);
if (styleProps["--dsw-font-markdown-h1"] !== "900 22.5px/32.1px -apple-system, BlinkMacSystemfont, 'Segoe UI', sans-serif") throw new Error("FAIL: h1 clamp: " + styleProps["--dsw-font-markdown-h1"]);
props.setFontWeight(-300);
if (styleProps["--dsw-font-markdown-base"] !== "200 15px/25.7px -apple-system, BlinkMacSystemfont, 'Segoe UI', sans-serif") throw new Error("FAIL: weight clamp low: " + styleProps["--dsw-font-markdown-base"]);
/* weight without a size override uses the theme's own px */
props.setFontSize(null);
if (styleProps["--dsw-font-markdown-base-font-size"] !== "14px") throw new Error("FAIL: weight-only size: " + styleProps["--dsw-font-markdown-base-font-size"]);
if (styleProps["--dsw-font-markdown-base"] !== "200 14px/24px -apple-system, BlinkMacSystemfont, 'Segoe UI', sans-serif") throw new Error("FAIL: weight-only composite: " + styleProps["--dsw-font-markdown-base"]);
props.setFontWeight(0);
if (styleProps["--dsw-font-markdown-base-font-size"] !== undefined) throw new Error("FAIL: zero delta with natural size should clear overrides");
props.setFontSize(15);
props.setCodeFontWeight(0);
/* the explicit size keeps driving the axis even when the theme presenter rewrites it */
styleProps["--dsh-content-font-size"] = "14px";
styleGuards[0]();
if (styleProps["--dsh-content-font-size"] !== "15px") throw new Error("FAIL: guard should re-assert the explicit size: " + styleProps["--dsh-content-font-size"]);
if (styleProps["--dsw-font-markdown-code-block"] !== "14.7px/25.3px 'SF Mono', 'JetBrains Mono', Consolas") throw new Error("FAIL: zero code weight drops the prefix: " + styleProps["--dsw-font-markdown-code-block"]);
if (styleProps["zoom"] !== undefined) throw new Error("FAIL: no zoom property should ever be set");
await new Promise((r) => setTimeout(r, 500));
const savedWithSize = postedConfigs.at(-1);
if (savedWithSize.fontSize !== 15 || savedWithSize.codeFontSize !== 16 || savedWithSize.fontWeight !== undefined || savedWithSize.codeFontWeight !== undefined) throw new Error("FAIL: size persist: " + JSON.stringify(savedWithSize));
row = renderRow();
const preview2 = countTags(row, "div").find((d) => d.props.className === "dft-preview");
if (!preview2 || preview2.props.style.fontSize !== "15px" || preview2.props.style.fontWeight !== "400") throw new Error("FAIL: body preview should follow: " + JSON.stringify(preview2?.props?.style));
console.log("sizes+weights OK: probe scaling, weight deltas, clamp, weight-only overrides, persist");

// weight persist: non-zero deltas are stored
props.setFontWeight(-100);
await new Promise((r) => setTimeout(r, 500));
if (postedConfigs.at(-1).fontWeight !== -100) throw new Error("FAIL: weight persist: " + JSON.stringify(postedConfigs.at(-1)));
props.setFontWeight(0);

// clear stacks -> vars removed
props.setFamilies([]);
props.setCodeFamilies([]);
if (styleProps["--dsw-font-family"] !== undefined || styleProps["--ds-font-family-code"] !== undefined) throw new Error("FAIL: clear should remove vars");
console.log("clear stacks OK");

// restore from config: fresh factory with configStore set
configStore = { families: ["Noto Sans SC"], codeFamilies: ["Fira Code"], fontSize: 15, codeFontSize: 17, fontWeight: 100 };
styleProps["--dsw-font-family"] = undefined;
styleProps["--ds-font-family-code"] = undefined;
postedConfigs.length = 0;
clientExports.apply(ctx);
await new Promise((r) => setTimeout(r, 50));
if (styleProps["--dsw-font-family"] !== "'Noto Sans SC', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif") throw new Error("FAIL: restore body stack: " + styleProps["--dsw-font-family"]);
if (styleProps["--ds-font-family-code"] !== "'Fira Code', 'SF Mono', 'JetBrains Mono', Consolas") throw new Error("FAIL: restore code stack: " + styleProps["--ds-font-family-code"]);
console.log("restore from config OK:", styleProps["--dsw-font-family"], "|", styleProps["--ds-font-family-code"]);
if (styleProps["--dsw-font-markdown-base-font-size"] !== "15px") throw new Error("FAIL: restore fontSize: " + styleProps["--dsw-font-markdown-base-font-size"]);
if (styleProps["--dsw-font-markdown-base"] !== "500 15px/25.7px -apple-system, BlinkMacSystemfont, 'Segoe UI', sans-serif") throw new Error("FAIL: restore weight: " + styleProps["--dsw-font-markdown-base"]);
if (styleProps["--dsw-font-markdown-code-block-font-size"] !== "15.6px") throw new Error("FAIL: restore code-block size: " + styleProps["--dsw-font-markdown-code-block-font-size"]);
// legacy single-font config migrates into a one-entry stack
configStore = { family: "Noto Sans SC", codeFamily: "Fira Code", scale: 1.25 };
styleProps["--dsw-font-markdown-base-font-size"] = undefined;
clientExports.apply(ctx);
await new Promise((r) => setTimeout(r, 50));
if (styleProps["--dsw-font-family"] !== "'Noto Sans SC', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif") throw new Error("FAIL: legacy family migration: " + styleProps["--dsw-font-family"]);
if (styleProps["--dsw-font-markdown-base-font-size"] !== "20px") throw new Error("FAIL: legacy scale migration: " + styleProps["--dsw-font-markdown-base-font-size"]);
console.log("legacy migration OK (family -> stack, 1.25 -> 20px)");

// sanitize quotes on the root var; follow-state payloads omit size/weight keys
configStore = { family: "", codeFamily: "" };
clientExports.apply(ctx);
await new Promise((r) => setTimeout(r, 50));
const followStore = ctx._entry.store.create();
const followProps = ctx._entry.inject(followStore.actions);
followProps.setFamilies([`Bad'Name"`]);
if (!styleProps["--dsw-font-family"].startsWith("'BadName',")) throw new Error("FAIL: sanitize: " + styleProps["--dsw-font-family"]);
await new Promise((r) => setTimeout(r, 500));
const sanitizedSave = postedConfigs.at(-1);
if (sanitizedSave.families[0] !== `Bad'Name"` || "fontSize" in sanitizedSave || "codeFontSize" in sanitizedSave || "fontWeight" in sanitizedSave || "codeFontWeight" in sanitizedSave) {
  throw new Error("FAIL: follow-state payload should omit size/weight keys: " + JSON.stringify(sanitizedSave));
}
console.log("sanitize + null-key omission OK");

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
await handleConfig(fakeReq("/font/config", JSON.stringify({ families: ["LXGW WenKai", "Noto Sans SC"], codeFamilies: ["JetBrains Mono"], fontSize: 17, codeFontSize: 16, fontWeight: 100, codeFontWeight: -100 }), { "content-type": "application/json" }, "POST"), res);
if (res.out.status !== 200) throw new Error("FAIL: config POST: " + res.out.status);
if (!existsSync(configPath())) throw new Error("FAIL: config file not written");
if (readdirSync(TEST_HOME + "/font").some((n) => n.endsWith(".tmp"))) throw new Error("FAIL: tmp file left behind");

// GET roundtrip
res = fakeRes();
await handleConfig(fakeReq("/font/config", null, {}, "GET"), res);
const roundtrip = JSON.parse(res.out.body);
if (roundtrip.families.join("|") !== "LXGW WenKai|Noto Sans SC" || roundtrip.codeFamilies.join("|") !== "JetBrains Mono" || roundtrip.fontSize !== 17 || roundtrip.codeFontSize !== 16 || roundtrip.fontWeight !== 100 || roundtrip.codeFontWeight !== -100) throw new Error("FAIL: roundtrip: " + res.out.body);

// sizes/weights optional: absent keys store without them (follow-the-theme state)
res = fakeRes();
await handleConfig(fakeReq("/font/config", JSON.stringify({ families: ["X"] }), { "content-type": "application/json" }, "POST"), res);
if (res.out.status !== 200) throw new Error("FAIL: absent sizes should 200: " + res.out.status);
let stored = JSON.parse(readFileSync(configPath(), "utf8"));
if (stored.families.join("|") !== "X" || "fontSize" in stored || "fontWeight" in stored) throw new Error("FAIL: absent sizes should store bare: " + JSON.stringify(stored));

// explicit null accepted and stored
res = fakeRes();
await handleConfig(fakeReq("/font/config", JSON.stringify({ families: [], fontSize: null, fontWeight: null }), { "content-type": "application/json" }, "POST"), res);
if (res.out.status !== 200) throw new Error("FAIL: null sizes should 200: " + res.out.status);
stored = JSON.parse(readFileSync(configPath(), "utf8"));
if (stored.fontSize !== null || stored.fontWeight !== null) throw new Error("FAIL: null sizes should persist: " + JSON.stringify(stored));

// invalid -> 400
res = fakeRes();
await handleConfig(fakeReq("/font/config", JSON.stringify({ families: "x" }), { "content-type": "application/json" }, "POST"), res);
if (res.out.status !== 400) throw new Error("FAIL: non-array families should 400");
res = fakeRes();
await handleConfig(fakeReq("/font/config", JSON.stringify({ families: [42] }), { "content-type": "application/json" }, "POST"), res);
if (res.out.status !== 400) throw new Error("FAIL: non-string stack entry should 400");
res = fakeRes();
await handleConfig(fakeReq("/font/config", JSON.stringify({ fontWeight: "big" }), { "content-type": "application/json" }, "POST"), res);
if (res.out.status !== 400) throw new Error("FAIL: non-number weight should 400");
res = fakeRes();
await handleConfig(fakeReq("/font/config", JSON.stringify({ fontWeight: 300 }), { "content-type": "application/json" }, "POST"), res);
if (res.out.status !== 400) throw new Error("FAIL: out-of-range weight should 400");
res = fakeRes();
await handleConfig(fakeReq("/font/config", JSON.stringify({ fontSize: 33 }), { "content-type": "application/json" }, "POST"), res);
if (res.out.status !== 400) throw new Error("FAIL: out-of-range fontSize should 400");

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

// font enumeration: faces parsing + routes with a stubbed fc-list runner
const { parseFcFamilies, parseFcFaces, handleFontList, handleFontFile, _setFontRunner, _resetFontCache } = host;
const fcRaw = "Noto Sans Khmer,Noto Sans Khmer SemiBold\n  LXGW WenKai  \nLXGW WenKai\nNoto Sans SC\n";
const parsed = parseFcFamilies(fcRaw);
if (parsed.join("|") !== "LXGW WenKai|Noto Sans Khmer|Noto Sans Khmer SemiBold|Noto Sans SC") throw new Error("FAIL: parse: " + parsed.join("|"));

const US = "\u001F";
const faceLines = [
  `${TEST_HOME}/fonts/Fake-LXGW-Regular.ttf${US}LXGW WenKai${US}80${US}0${US}0`,
  `${TEST_HOME}/fonts/Fake-LXGW-Bold.ttf${US}LXGW WenKai${US}200${US}0${US}0`,
  `${TEST_HOME}/fonts/Fake-DejaVu.otf${US}DejaVu Sans${US}80${US}0${US}0`,
  `${TEST_HOME}/fonts/Fake-Italic.ttf${US}Fake Family${US}80${US}100${US}0`,
  `${TEST_HOME}/fonts/Fake-Bitmap.pcf${US}Bitmap Family${US}80${US}0${US}0`,
  `${TEST_HOME}/fonts/Fake-Multi.ttf${US}Khmer A,Khmer B${US}100${US}0${US}0`
];
const faces = parseFcFaces(faceLines.join("\n"));
if ((faces["LXGW WenKai"] || []).length !== 2) throw new Error("FAIL: two faces for LXGW: " + JSON.stringify(faces["LXGW WenKai"]));
if (faces["LXGW WenKai"][0].ext !== "ttf" || faces["LXGW WenKai"][0].weight !== 80 || faces["LXGW WenKai"][1].weight !== 200) throw new Error("FAIL: face fields: " + JSON.stringify(faces["LXGW WenKai"]));
if (faces["Khmer A"]?.length !== 1 || faces["Khmer B"]?.length !== 1) throw new Error("FAIL: multi-family face: " + JSON.stringify(faces));
if (faces["Bitmap Family"]) throw new Error("FAIL: bitmap faces must be skipped");
if (parseFcFaces("garbage\n\n")[0] !== undefined) throw new Error("FAIL: malformed lines should be skipped");

mkdirSync(TEST_HOME + "/fonts", { recursive: true });
const fakeFontBytes = Buffer.from("FAKE TTF BYTES");
for (const name of ["Fake-LXGW-Regular.ttf", "Fake-LXGW-Bold.ttf", "Fake-DejaVu.otf", "Fake-Italic.ttf"]) {
  writeFileSync(TEST_HOME + "/fonts/" + name, fakeFontBytes);
}

let runnerCalls = 0;
_setFontRunner((args, cb) => {
  runnerCalls += 1;
  const pattern = args.join(" ");
  if (pattern.includes("spacing=100")) { cb(null, "JetBrainsMono Nerd Font\nNoto Sans Mono\n"); return; }
  if (pattern.includes("--format=")) { cb(null, faceLines.join("\n")); return; }
  cb(new Error("unexpected fc-list args: " + pattern));
});
res = fakeRes();
await handleFontList(fakeReq("/font/list", null, {}, "GET"), res);
const catalog = JSON.parse(res.out.body);
if (!catalog.ok || catalog.families.length !== 5 || !catalog.mono.includes("JetBrainsMono Nerd Font")) throw new Error("FAIL: catalog: " + res.out.body);
if (!("LXGW WenKai" in catalog.faces) || catalog.faces["LXGW WenKai"].length !== 2) throw new Error("FAIL: faces in catalog: " + res.out.body);
if (JSON.stringify(catalog.faces["LXGW WenKai"]) !== JSON.stringify([{ ext: "ttf", weight: 80, slant: 0 }, { ext: "ttf", weight: 200, slant: 0 }])) throw new Error("FAIL: wire faces must project ext/weight/slant only: " + res.out.body);
// second call within TTL serves the cache (no extra fc-list runs)
res = fakeRes();
await handleFontList(fakeReq("/font/list", null, {}, "GET"), res);
if (runnerCalls !== 2) throw new Error("FAIL: cache: runner called " + runnerCalls + " times");

// /font/file serves an enumerated face; the family/index pair is the only addressing surface
const fileReq = (query, method = "GET") => fakeReq(`/font/file${query}`, null, {}, method);
res = fakeRes();
await handleFontFile(fileReq("?family=LXGW%20WenKai&index=0"), res);
if (res.out.status !== 200) throw new Error("FAIL: font file 200: " + res.out.status);
if (res.out.headers["content-type"] !== "font/ttf" || res.out.headers["content-length"] !== fakeFontBytes.length) throw new Error("FAIL: file headers: " + JSON.stringify(res.out.headers));
if (!res.out.headers["cache-control"].includes("immutable")) throw new Error("FAIL: immutable cache: " + JSON.stringify(res.out.headers));
if (!res.out.body.equals(fakeFontBytes)) throw new Error("FAIL: file body bytes");
res = fakeRes();
await handleFontFile(fileReq("?family=LXGW%20WenKai&index=1"), res);
if (res.out.headers["content-type"] !== "font/ttf") throw new Error("FAIL: index 1 should be the bold ttf");
res = fakeRes();
await handleFontFile(fileReq("?family=Fake%20Family&index=0"), res);
if (res.out.headers["content-type"] !== "font/ttf") throw new Error("FAIL: italic face still ttf");
res = fakeRes();
await handleFontFile(fileReq("?family=LXGW%20WenKai&index=99"), res);
if (res.out.status !== 404) throw new Error("FAIL: out-of-range index should 404");
res = fakeRes();
await handleFontFile(fileReq("?family=Nope&index=0"), res);
if (res.out.status !== 404) throw new Error("FAIL: unknown family should 404");
res = fakeRes();
await handleFontFile(fileReq("?family=Bitmap%20Family&index=0"), res);
if (res.out.status !== 404) throw new Error("FAIL: bitmap family should not be served");
res = fakeRes();
await handleFontFile(fileReq("?family=LXGW%20WenKai&index=0", "HEAD"), res);
if (res.out.status !== 200 || res.out.body !== undefined) throw new Error("FAIL: HEAD should send headers only");
res = fakeRes();
await handleFontFile(fileReq("?family=LXGW%20WenKai&index=0", "PUT"), res);
if (res.out.status !== 405) throw new Error("FAIL: PUT should 405");

// missing file on disk (enumerated then deleted) -> 404, not a crash
rmSync(TEST_HOME + "/fonts/Fake-DejaVu.otf");
res = fakeRes();
await handleFontFile(fileReq("?family=DejaVu%20Sans&index=0"), res);
if (res.out.status !== 404) throw new Error("FAIL: vanished file should 404");

// runner failure -> ok:false (client falls back to presets)
_resetFontCache();
_setFontRunner((args, cb) => cb(new Error("no fc-list")));
res = fakeRes();
await handleFontList(fakeReq("/font/list", null, {}, "GET"), res);
const degraded = JSON.parse(res.out.body);
if (degraded.ok !== false || degraded.faces === undefined) throw new Error("FAIL: degraded catalog: " + res.out.body);
console.log("font enumeration OK (faces, routes, cache, file serving, degrade)");

console.log("HOST SMOKE OK");
rmSync(TEST_HOME, { recursive: true, force: true });
console.log("ALL CHECKS PASSED");

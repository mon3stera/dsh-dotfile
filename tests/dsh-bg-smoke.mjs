// Smoke test for dsh-plugin-background (client factory + host module) with stubs.
import { readFileSync } from "node:fs";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import vm from "node:vm";

// ---------- client half ----------
const styleTags = [];
const fakeBody = {
  style: { _props: {}, setProperty(k, v) { this._props[k] = v; }, removeProperty(k) { delete this._props[k]; } },
  dataset: {}
};
const fakeDocument = {
  querySelectorAll: () => [],
  createElement: (tag) => tag === "canvas"
    ? { width: 0, height: 0, getContext: () => ({ drawImage: () => {}, getImageData: () => ({ data: new Uint8ClampedArray(32 * 32 * 4).map((_, i) => i % 4 === 3 ? 255 : i % 4 === 0 ? 65 : i % 4 === 1 ? 118 : 230) }) }) }
    : ({ dataset: {}, textContent: "", tagName: tag }),
  head: { appendChild: (el) => { styleTags.push(el); } },
  body: fakeBody,
  getElementById: () => null
};
globalThis.window = { __ModuleLoader__: { load: (entry) => { globalThis.__loadedEntry = entry; } } };
globalThis.document = fakeDocument;

// plugin-owned config persistence stub: GET returns configStore, POST persists it
let configStore = null;
const postedConfigs = [];
globalThis.fetch = async (url, opts = {}) => {
  const method = opts.method || "GET";
  if (url === "/background/config" && method === "GET") {
    return configStore ? { ok: true, status: 200, json: async () => configStore } : { ok: false, status: 404, json: async () => ({}) };
  }
  if (url === "/background/config" && method === "POST") {
    const body = JSON.parse(opts.body);
    postedConfigs.push(body);
    configStore = body;
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }
  if (url === "/background/upload" && method === "POST") {
    return { ok: true, status: 200, json: async () => ({ url: "/background/wallpaper-42.png" }) };
  }
  throw new Error("FAIL: unexpected fetch " + url);
};

const code = readFileSync(new URL("../plugins/dsh-plugin-background/lib/client.js", import.meta.url), "utf8");
vm.runInThisContext(code, { filename: "dsh-plugin-background/lib/client.js" });

const entry = globalThis.__loadedEntry;
if (!entry || entry.id !== "dsh-plugin-background") throw new Error("FAIL: __ModuleLoader__ registration missing or wrong id");

const clientExports = entry.factory((spec) => {
  if (spec === "react/jsx-runtime") return { jsx: (type, props, key) => ({ type, props, key }) };
  if (spec === "@deepseek-ai/dsh-client-runtime/client") return { defineStore: (config) => config };
  throw new Error("FAIL: unexpected require: " + spec);
});
console.log("client exports:", Object.keys(clientExports));
if (clientExports.name !== "dsh-plugin-background") throw new Error("FAIL: name");
const injectList = clientExports.inject;
if (!injectList.includes("slots") || !injectList.includes("locale") || !injectList.includes("theme")) throw new Error("FAIL: inject list: " + injectList);
if (injectList.includes("settingsScope")) throw new Error("FAIL: settingsScope should be gone");
console.log("inject list:", injectList);

// --- vendored MCU really works: real M3 pipeline on a synthetic image ---
{
  const { resolveSeed } = clientExports;
  const seed = clientExports.buildThemeTokens(0xff4176e6);
  const keys = Object.keys(seed);
  console.log("theme tokens:", keys.length);
  if (keys.length < 18) throw new Error("FAIL: too few tokens: " + keys.length);
  for (const [name, pair] of Object.entries(seed)) {
    if (typeof pair.light !== "string" || typeof pair.dark !== "string") throw new Error("FAIL: token pair " + name);
    if (!/^(#[0-9a-f]{6}|color-mix\(in srgb, #[0-9a-f]{6} [0-9]+%, transparent\))$/i.test(pair.light)) throw new Error("FAIL: token value " + pair.light);
  }
  if (!seed["--dsh-plugin-bg-strong-color"] || !seed["--dsw-alias-markdown-inline-code"]) throw new Error("FAIL: strong/markdown tokens");
  const mono = clientExports.buildThemeTokens(0xff4176e6, "monochrome");
  const rb = clientExports.buildThemeTokens(0xff4176e6, "rainbow");
  const hexVal = (v) => v.light;
  if (hexVal(mono["--dsw-alias-state-business-primary"]) === hexVal(seed["--dsw-alias-state-business-primary"])) throw new Error("FAIL: monochrome should differ");
  const gray = hexVal(mono["--dsw-alias-state-business-primary"]).slice(1);
  const gr = parseInt(gray.slice(0, 2), 16), gg = parseInt(gray.slice(2, 4), 16), gb = parseInt(gray.slice(4, 6), 16);
  if (Math.max(gr, gg, gb) - Math.min(gr, gg, gb) > 12) throw new Error("FAIL: monochrome not grayscale: " + gray);
  console.log("variants: mono", hexVal(mono["--dsw-alias-state-business-primary"]), "rainbow", hexVal(rb["--dsw-alias-state-business-primary"]));
  // syntax tokens: 9 roles, distinct hues, neutral parameter, readable dark tones
  const syn = clientExports.buildSyntaxTokens(0xff4176e6);
  const roles = Object.keys(syn.light);
  if (roles.length !== 9) throw new Error("FAIL: syntax roles: " + roles.length);
  if (!/^#[0-9a-f]{6}$/i.test(syn.dark.keyword) || !/^#[0-9a-f]{6}$/i.test(syn.light.string)) throw new Error("FAIL: syntax hex");
  const rgbOf = (h) => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];
  const lum = (h) => { const [r,g,b] = rgbOf(h).map(v => v/255); return 0.2126*r + 0.7152*g + 0.0722*b; };
  // dark tokens readable on the dark code-block bg (luminance > 0.3)
  for (const role of ["constant","string","keyword","function","string-expression","link"]) {
    if (lum(syn.dark[role]) < 0.28) throw new Error("FAIL: dark " + role + " too dark: " + syn.dark[role] + " lum " + lum(syn.dark[role]));
  }
  // roles stay hue-distinct (keyword magenta vs string green vs function blue)
  const hueOf = (h) => { const [r,g,b] = rgbOf(h).map(v => v/255); const max=Math.max(r,g,b), min=Math.min(r,g,b); if (max===min) return -1; const d=max-min; let hue; if (max===r) hue=((g-b)/d)%6; else if (max===g) hue=(b-r)/d+2; else hue=(r-g)/d+4; return (hue*60+360)%360; };
  const hKeyword = hueOf(syn.dark.keyword), hString = hueOf(syn.dark.string), hFunction = hueOf(syn.dark.function);
  if (Math.abs(hKeyword - hString) < 25 || Math.abs(hString - hFunction) < 25 || Math.abs(hKeyword - hFunction) < 25) throw new Error("FAIL: role hues not distinct: " + hKeyword + "," + hString + "," + hFunction);
  // parameter is neutral (variables never clash with the wallpaper)
  const [pr,pg,pb] = rgbOf(syn.dark.parameter);
  if (Math.max(pr,pg,pb) - Math.min(pr,pg,pb) > 12) throw new Error("FAIL: parameter not neutral: " + syn.dark.parameter);
  console.log("syntax: keyword", syn.dark.keyword, "string", syn.dark.string, "function", syn.dark.function, "parameter", syn.dark.parameter);
  // resolveSeed: no Image -> null, with Image -> seed
  delete globalThis.Image;
  const noImg = await resolveSeed({ wallpaper: "custom", customUrl: "/background/x.png" });
  if (noImg !== null) throw new Error("FAIL: custom without Image should resolve null");
  globalThis.Image = class {
    set crossOrigin(v) {}
    set src(v) { queueMicrotask(() => { this.onload && this.onload(); }); }
  };
  const seedArgb = await resolveSeed({ wallpaper: "custom", customUrl: "/background/x.png" });
  if (typeof seedArgb !== "number") throw new Error("FAIL: custom seed resolution");
  console.log("resolveSeed custom ->", seedArgb.toString(16));
}

// --- apply with a persisted config (restore path) + theme service stub ---
let registered = null;
let themeOverrides = [];
let themeDisposed = 0;
configStore = { wallpaper: "custom", customUrl: "/background/x.png", opacity: 0.5, themeFromWallpaper: true, variant: "tonalSpot" };
const fakeCtx = {
  theme: {
    overrideTokens: (source, tokens) => {
      themeOverrides.push({ source, tokens });
      return () => { themeDisposed += 1; };
    }
  },
  locale: { register: (ns, dicts) => {
    if (ns !== "settings.background") throw new Error("FAIL: locale ns");
    const zhKeys = Object.keys(dicts.zh).sort().join(",");
    const enKeys = Object.keys(dicts.en).sort().join(",");
    if (zhKeys !== enKeys) throw new Error("FAIL: locale key mismatch zh vs en");
    console.log("locale keys ok:", zhKeys);
  } },
  effect: () => {},
  slots: {
    inject: (slotName, reg) => {
      if (slotName !== "settings.general.item") throw new Error("FAIL: slot " + slotName);
      registered = reg();
    },
    register: (opts, Comp) => ({ ...opts, component: Comp })
  }
};
clientExports.apply(fakeCtx);
if (!registered) throw new Error("FAIL: settings row not registered");

const storeActions = registered.store?.spec?.actions ?? registered.store?.actions ?? {};
if (typeof storeActions.sync !== "function" || typeof storeActions.setUploadStatus !== "function") throw new Error("FAIL: store actions");
const storeInit = registered.store?.spec?.init?.() ?? registered.store?.init?.() ?? {};
if (storeInit.themeFromWallpaper !== true || storeInit.opacity !== 0.2 || storeInit.variant !== "tonalSpot") throw new Error("FAIL: store defaults");

const statuses = [];
const injectedProps = registered.inject({
  sync: () => {},
  setUploadStatus: (uploading, error) => { statuses.push({ uploading, error }); }
});
if (typeof injectedProps.setThemeFromWallpaper !== "function" || typeof injectedProps.setVariant !== "function" || typeof injectedProps.upload !== "function") throw new Error("FAIL: actions");

// restore from config (async loadConfig)
await new Promise((r) => setTimeout(r, 50));
console.log("wallpaper var:", fakeBody.style._props["--dsh-wallpaper-image"]);
if (fakeBody.style._props["--dsh-wallpaper-image"] !== 'url("/background/x.png")') throw new Error("FAIL: config not restored");
if (fakeBody.dataset.dshWallpaper !== "on") throw new Error("FAIL: wallpaper flag");
if (themeOverrides.length !== 1 || themeOverrides[0].source !== "dsh-plugin-background") throw new Error("FAIL: theme override after restore");
if (fakeBody.style._props["--dsh-plugin-strong-light"] !== themeOverrides[0].tokens["--dsh-plugin-bg-strong-color"].light) throw new Error("FAIL: strong var");
console.log("restore OK; primary:", themeOverrides[0].tokens["--dsh-alias-state-business-primary"]);

// persist: change opacity -> debounced POST with the full config
injectedProps.setOpacity(0.3);
await new Promise((r) => setTimeout(r, 600));
if (postedConfigs.length !== 1) throw new Error("FAIL: config not posted: " + postedConfigs.length);
const saved = postedConfigs[0];
if (saved.opacity !== 0.3 || saved.wallpaper !== "custom" || saved.customUrl !== "/background/x.png" || saved.themeFromWallpaper !== true || saved.variant !== "tonalSpot") throw new Error("FAIL: saved payload: " + JSON.stringify(saved));
console.log("persist OK:", JSON.stringify(saved));

// opacity change must NOT touch the theme (no re-derive, no dispose)
if (themeOverrides.length !== 1 || themeDisposed !== 0) throw new Error("FAIL: opacity should not re-derive theme");
console.log("opacity change leaves theme untouched OK");
// toggle off -> dispose; on -> re-apply; variant switch -> re-apply
injectedProps.setThemeFromWallpaper(false);
await new Promise((r) => setTimeout(r, 50));
if (themeDisposed !== 1) throw new Error("FAIL: toggle off should dispose");
injectedProps.setThemeFromWallpaper(true);
await new Promise((r) => setTimeout(r, 50));
if (themeOverrides.length !== 2) throw new Error("FAIL: toggle on re-applies");
injectedProps.setVariant("monochrome");
await new Promise((r) => setTimeout(r, 50));
if (themeOverrides.length !== 3) throw new Error("FAIL: variant switch re-applies");
console.log("toggle/variant lifecycle OK");
// wallpaper is derived from customUrl: clearing disables, setting re-enables
injectedProps.setCustomUrl("");
await new Promise((r) => setTimeout(r, 50));
if (fakeBody.dataset.dshWallpaper !== "off") throw new Error("FAIL: clearing URL should disable wallpaper");
injectedProps.setCustomUrl("/background/x.png");
await new Promise((r) => setTimeout(r, 50));
if (fakeBody.dataset.dshWallpaper !== "on") throw new Error("FAIL: setting URL should enable wallpaper");
console.log("wallpaper derivation OK");

// render row
const useStore = (sel) => sel({ wallpaper: "custom", customUrl: "/background/x.png", opacity: 0.3, themeFromWallpaper: true, variant: "tonalSpot", uploading: false, uploadError: "", revision: 0 });
const tree = registered.component({ t: (k) => k, useStore, ...injectedProps });
if (tree.type !== "div" || !Array.isArray(tree.props.children)) throw new Error("FAIL: row tree");
if (tree.props.children.length !== 7) throw new Error("FAIL: row children: " + tree.props.children.length);
console.log("row tree children:", tree.props.children.length);

// 413 path: server-provided limit surfaces in the error
const savedFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: false, status: 413, json: async () => ({ limit: 104857600 }) });
await injectedProps.upload({ target: { files: [new Blob(["x"], { type: "image/webp" })], value: "x" } });
if (statuses.at(-1).error !== "TOO_LARGE:104857600") throw new Error("FAIL: 413 mapping: " + JSON.stringify(statuses.at(-1)));
globalThis.fetch = savedFetch;
console.log("413 limit surfaced OK");

console.log("CLIENT SMOKE OK");

// ---------- host half ----------
const TEST_HOME = "/home/mon3tr/dsh-bg-test-home";
process.env.DSH_HOME = TEST_HOME;
rmSync(TEST_HOME, { recursive: true, force: true });
mkdirSync(TEST_HOME, { recursive: true });

// Host-side deps (@deepseek-ai/*) resolve from the DSH installation, so the host
// half is imported from there; the client half below is read from this repo.
const host = await import("/home/mon3tr/.dsh/profiles/node_modules/dsh-plugin-background/lib/index.js");

let routes = [];
host.apply({
  inject: (deps, cb) => {
    if (deps.includes("webServer")) cb({
      webServer: { register: (route) => { routes.push(route); return () => {}; } },
      effect: (fn) => fn()
    });
  }
});
console.log("routes:", routes.map((r) => `${r.kind} ${r.path}`));
if (routes.length !== 3) throw new Error("FAIL: routes: " + routes.length);
const uploadRoute = routes.find((r) => r.path === "/background/upload" && r.kind === "exact");
const configRoute = routes.find((r) => r.path === "/background/config" && r.kind === "exact");
const serveRoute = routes.find((r) => r.path === "/background" && r.kind === "prefix");
if (!uploadRoute || !configRoute || !serveRoute) throw new Error("FAIL: route kinds/paths");

function fakeReq(url, body, headers = {}, method = "POST") {
  const chunks = body ? [Buffer.from(body)] : [];
  return {
    url,
    method,
    headers,
    [Symbol.asyncIterator]() {
      let i = 0;
      return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { done: true }) };
    }
  };
}
function fakeRes() {
  const out = { status: null, headers: null, body: null };
  return { out, writeHead(status, headers) { out.status = status; out.headers = headers; }, end(payload) { out.body = payload; } };
}

// config GET before any write -> 404
let res = fakeRes();
configRoute.handler(fakeReq("/background/config", null, {}, "GET"), res);
if (res.out.status !== 404) throw new Error("FAIL: config GET should 404 initially");

// config POST valid -> 200 + file written
const goodConfig = { wallpaper: "custom", customUrl: "/background/wallpaper-1.png", opacity: 0.2, themeFromWallpaper: true, variant: "rainbow" };
res = fakeRes();
await configRoute.handler(fakeReq("/background/config", JSON.stringify(goodConfig), { "content-type": "application/json" }, "POST"), res);
if (res.out.status !== 200) throw new Error("FAIL: config POST: " + res.out.status + " " + res.out.body);
if (!existsSync(TEST_HOME + "/background/config.json")) throw new Error("FAIL: config file not written");

// config GET roundtrip
res = fakeRes();
configRoute.handler(fakeReq("/background/config", null, {}, "GET"), res);
if (res.out.status !== 200) throw new Error("FAIL: config GET");
if (JSON.parse(res.out.body).variant !== "rainbow") throw new Error("FAIL: config roundtrip");

// config POST invalid -> 400 (unknown wallpaper id)
res = fakeRes();
await configRoute.handler(fakeReq("/background/config", JSON.stringify({ wallpaper: "aurora" }), {}, "POST"), res);
if (res.out.status !== 400) throw new Error("FAIL: invalid config should 400: " + res.out.status);

// upload replace loop must NOT delete config.json
const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
res = fakeRes();
await uploadRoute.handler(fakeReq("/background/upload", pngBytes, { "content-type": "image/png" }), res);
if (res.out.status !== 200) throw new Error("FAIL: upload status");
if (!existsSync(TEST_HOME + "/background/config.json")) throw new Error("FAIL: upload deleted config.json");
console.log("config survives upload OK");

// serve wallpaper
res = fakeRes();
serveRoute.handler(fakeReq("/background/wallpaper-1.png", null, {}, "GET"), res);
if (res.out.status !== 404) throw new Error("FAIL: missing wallpaper should 404");
const travRes = { out: null, writeHead(s, h) { this.out = { s, h }; }, end(b) { this.out.body = b; } };
serveRoute.handler({ url: "/background/..%2F..%2Fetc/passwd", headers: {} }, travRes);
if (travRes.out.s !== 404) throw new Error("FAIL: traversal not rejected");

// oversize upload: 413 AND the body fully drained (no connection cut mid-body)
const big = Buffer.alloc(host.MAX_UPLOAD_BYTES + 1024, 7);
let consumed = 0;
const bigReq = {
  url: "/background/upload", method: "POST", headers: { "content-type": "image/png" },
  [Symbol.asyncIterator]() {
    let i = 0; const chunks = [big];
    return { next: async () => { if (i < chunks.length) { consumed += chunks[i].length; return { value: chunks[i++], done: false }; } return { done: true }; } };
  }
};
res = fakeRes();
await uploadRoute.handler(bigReq, res);
if (res.out.status !== 413) throw new Error("FAIL: oversize upload should 413: " + res.out.status);
const overBody = JSON.parse(res.out.body);
if (overBody.limit !== host.MAX_UPLOAD_BYTES) throw new Error("FAIL: 413 should carry the limit");
if (consumed !== big.length) throw new Error("FAIL: body not drained: " + consumed + "/" + big.length);
console.log("oversize upload -> 413, body drained OK");
// oversize config: 413 + drained
const bigConfig = Buffer.alloc(70 * 1024, 8);
let configConsumed = 0;
const bigConfigReq = {
  url: "/background/config", method: "POST", headers: { "content-type": "application/json" },
  [Symbol.asyncIterator]() {
    let i = 0; const chunks = [bigConfig];
    return { next: async () => { if (i < chunks.length) { configConsumed += chunks[i].length; return { value: chunks[i++], done: false }; } return { done: true }; } };
  }
};
res = fakeRes();
await configRoute.handler(bigConfigReq, res);
if (res.out.status !== 413) throw new Error("FAIL: oversize config should 413");
if (configConsumed !== bigConfig.length) throw new Error("FAIL: config body not drained");
console.log("oversize config -> 413, body drained OK");

rmSync(TEST_HOME, { recursive: true, force: true });
console.log("HOST SMOKE OK");
console.log("ALL CHECKS PASSED");

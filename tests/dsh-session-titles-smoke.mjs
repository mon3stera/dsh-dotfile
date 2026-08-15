/**
 * Smoke test for dsh-plugin-hide-session-titles (client factory + host
 * handlers with stubs). The client half reads this repo's copy; the host
 * half imports the installed plugin so @deepseek-ai deps resolve.
 * Run: node tests/dsh-session-titles-smoke.mjs (from the repo root)
 */
import { readFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import vm from "node:vm";

const PLUGIN_DIR = new URL("../plugins/dsh-plugin-hide-session-titles/", import.meta.url);
const TEST_HOME = "/home/mon3tr/dsh-session-titles-test-home";
process.env.DSH_HOME = TEST_HOME;
rmSync(TEST_HOME, { recursive: true, force: true });
mkdirSync(TEST_HOME, { recursive: true });

const host = await import("/home/mon3tr/.dsh/profiles/node_modules/dsh-plugin-hide-session-titles/lib/index.js");

// ---------- client stubs ----------
const attrs = {};
const docEl = {
  setAttribute(k, v) { attrs[k] = v; },
  removeAttribute(k) { delete attrs[k]; }
};
const styleTags = [];
let inserted = null; // { btn, ref }
const fakeSearchRoot = { isSearchRoot: true };
const fakeSlot = {
  querySelector(sel) { return sel.startsWith(":scope") ? fakeSearchRoot : null; },
  insertBefore(btn, ref) { inserted = { btn, ref }; }
};
globalThis.document = {
  documentElement: docEl,
  body: { dataset: {} },
  head: { appendChild: (tag) => { styleTags.push(tag); } },
  querySelector(sel) { return sel === '[class$="_searchSlot"]' ? fakeSlot : null; },
  querySelectorAll() { return []; },
  createElement() {
    const el = {
      dataset: {},
      attrs: {},
      listeners: {},
      innerHTML: "",
      removed: false,
      setAttribute(k, v) { el.attrs[k] = v; },
      addEventListener(type, fn) { el.listeners[type] = fn; },
      remove() { el.removed = true; }
    };
    return el;
  }
};
let observerCb = null;
globalThis.MutationObserver = class {
  constructor(cb) { observerCb = cb; }
  observe() {}
  disconnect() {}
};

const postedConfigs = [];
let configStore = null;
globalThis.fetch = async (url, opts) => {
  if (url === "/session-titles/config" && opts?.method === "POST") {
    postedConfigs.push(JSON.parse(opts.body));
    return { ok: true, status: 200 };
  }
  if (url === "/session-titles/config") {
    return configStore ? { ok: true, status: 200, json: async () => configStore } : { ok: false, status: 404 };
  }
  throw new Error("FAIL: unexpected fetch " + url);
};

// ---------- load the client factory ----------
const raw = readFileSync(new URL("lib/client.js", PLUGIN_DIR), "utf8");
let capturedEntry = null;
globalThis.window = { __ModuleLoader__: { load: (entry) => { capturedEntry = entry; } } };
vm.runInThisContext(raw, { filename: "dsh-plugin-hide-session-titles/lib/client.js" });
const clientExports = capturedEntry.factory((spec) => {
  throw new Error("FAIL: unexpected require: " + spec);
});
if (clientExports.name !== "dsh-plugin-hide-session-titles") throw new Error("FAIL: name");

const disposers = [];
const ctx = {
  effect(cb) {
    const out = cb();
    const dispose = () => (typeof out === "function" ? out() : undefined);
    disposers.push(dispose);
    return dispose;
  }
};

// apply: button inserted left of the search root, attribute off
clientExports.apply(ctx);
if (styleTags.length !== 1 || !styleTags[0].textContent.includes("_sessionRow")) throw new Error("FAIL: css not injected");
if (!inserted || inserted.ref !== fakeSearchRoot) throw new Error("FAIL: button not inserted before search root");
if (attrs["data-dsh-hide-titles"] !== "off") throw new Error("FAIL: initial attr: " + attrs["data-dsh-hide-titles"]);
const btn = inserted.btn;
if (btn.attrs["aria-pressed"] !== "false") throw new Error("FAIL: initial aria-pressed: " + JSON.stringify(btn.attrs));
console.log("apply OK: button inserted next to search, css injected");

// toggle on -> attr on, icon swapped, persisted
btn.listeners.click();
if (attrs["data-dsh-hide-titles"] !== "on") throw new Error("FAIL: toggle on: " + attrs["data-dsh-hide-titles"]);
if (btn.attrs["aria-pressed"] !== "true" || btn.attrs["data-active"] !== "true") throw new Error("FAIL: aria state: " + JSON.stringify(btn.attrs));
if (!btn.innerHTML.includes("M17.94 17.94")) throw new Error("FAIL: eye-off icon not set");
await new Promise((r) => setTimeout(r, 500));
if (postedConfigs.length !== 1 || postedConfigs[0].hidden !== true) throw new Error("FAIL: persist: " + JSON.stringify(postedConfigs));

// toggle off -> attr off
btn.listeners.click();
if (attrs["data-dsh-hide-titles"] !== "off") throw new Error("FAIL: toggle off");
if (!btn.innerHTML.includes("M1 12s4-8 11-8")) throw new Error("FAIL: eye icon not restored");
await new Promise((r) => setTimeout(r, 500));
if (postedConfigs.at(-1).hidden !== false) throw new Error("FAIL: persist off");
console.log("toggle OK: on/off + persist");

// restore from config (fresh apply)
configStore = { hidden: true };
attrs["data-dsh-hide-titles"] = undefined;
inserted = null;
clientExports.apply(ctx);
await new Promise((r) => setTimeout(r, 50));
if (attrs["data-dsh-hide-titles"] !== "on") throw new Error("FAIL: restore: " + attrs["data-dsh-hide-titles"]);
const btn2 = inserted.btn;
if (btn2.attrs["aria-pressed"] !== "true") throw new Error("FAIL: restore aria: " + JSON.stringify(btn2.attrs));
console.log("restore from config OK");

// teardown: attribute removed + button removed
for (const dispose of disposers) dispose();
if (attrs["data-dsh-hide-titles"] !== undefined) throw new Error("FAIL: teardown should clear attr");
if (!btn2.removed) throw new Error("FAIL: teardown should remove button");
console.log("teardown OK");
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

let res = fakeRes();
await handleConfig(fakeReq("/session-titles/config", null, {}, "GET"), res);
if (res.out.status !== 404) throw new Error("FAIL: GET should 404 initially");

res = fakeRes();
await handleConfig(fakeReq("/session-titles/config", JSON.stringify({ hidden: true }), { "content-type": "application/json" }, "POST"), res);
if (res.out.status !== 200) throw new Error("FAIL: POST: " + res.out.status);
if (!existsSync(configPath())) throw new Error("FAIL: config file not written");
if (readdirSync(TEST_HOME + "/session-titles").some((n) => n.endsWith(".tmp"))) throw new Error("FAIL: tmp file left behind");

res = fakeRes();
await handleConfig(fakeReq("/session-titles/config", null, {}, "GET"), res);
const roundtrip = JSON.parse(res.out.body);
if (roundtrip.hidden !== true) throw new Error("FAIL: roundtrip: " + res.out.body);

res = fakeRes();
await handleConfig(fakeReq("/session-titles/config", JSON.stringify({ hidden: "yes" }), { "content-type": "application/json" }, "POST"), res);
if (res.out.status !== 400) throw new Error("FAIL: non-boolean hidden should 400");

res = fakeRes();
await handleConfig(fakeReq("/session-titles/config", "{oops", { "content-type": "application/json" }, "POST"), res);
if (res.out.status !== 400) throw new Error("FAIL: invalid JSON should 400");

console.log("HOST SMOKE OK");
rmSync(TEST_HOME, { recursive: true, force: true });
console.log("ALL CHECKS PASSED");

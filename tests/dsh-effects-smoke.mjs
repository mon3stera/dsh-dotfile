/**
 * Smoke test for dsh-plugin-effects (client factory + host handlers with
 * stubs). The client half reads this repo's copy; the host half imports the
 * installed plugin so @deepseek-ai deps resolve.
 * Run: node tests/dsh-effects-smoke.mjs (from the repo root)
 */
import { readFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import vm from "node:vm";

const PLUGIN_DIR = new URL("../plugins/dsh-plugin-effects/", import.meta.url);
const TEST_HOME = "/home/mon3tr/dsh-effects-test-home";
process.env.DSH_HOME = TEST_HOME;
rmSync(TEST_HOME, { recursive: true, force: true });
mkdirSync(TEST_HOME, { recursive: true });

const host = await import("/home/mon3tr/.dsh/profiles/node_modules/dsh-plugin-effects/lib/index.js");

// ---------- client stubs ----------
const styleTags = [];
const docListeners = {};
let created = [];

const makeCtx2d = () => {
  const calls = { clearRect: 0, arcs: 0, lines: 0, gradients: 0, strokes: 0, fills: 0, brightFills: 0 };
  const coords = [];
  const grad = { addColorStop() {} };
  const ctx = {
    setTransform() {},
    clearRect() { calls.clearRect += 1; },
    beginPath() {},
    moveTo() {},
    lineTo() { calls.lines += 1; },
    stroke() { calls.strokes += 1; },
    arc(x, y) { calls.arcs += 1; coords.push([x, y]); },
    fill() {
      calls.fills += 1;
      // 0.75 alpha is the orbit effect's captured-particle color
      if (String(ctx._fill ?? "").includes("0.75")) calls.brightFills += 1;
    },
    createRadialGradient() { calls.gradients += 1; return grad; }
  };
  Object.defineProperty(ctx, "fillStyle", { set(v) { ctx._fill = v; }, get() { return ctx._fill; } });
  Object.defineProperty(ctx, "strokeStyle", { set(v) { ctx._stroke = v; }, get() { return ctx._stroke; } });
  ctx.calls = calls;
  ctx.coords = coords;
  return ctx;
};

const fakeBody = {
  appendChild(el) { created.push(el); },
  remove() {}
};

globalThis.document = {
  hidden: false,
  body: fakeBody,
  head: { appendChild: (tag) => { styleTags.push(tag); } },
  querySelectorAll() { return []; },
  addEventListener(type, fn) { (docListeners[type] ??= []).push(fn); },
  removeEventListener(type, fn) { docListeners[type] = (docListeners[type] ?? []).filter((f) => f !== fn); },
  createElement(tag) {
    const el = {
      tag,
      dataset: {},
      style: {},
      id: "",
      removed: false,
      setAttribute(k, v) { el.attrs ??= {}; el.attrs[k] = v; },
      remove() { el.removed = true; }
    };
    if (tag === "canvas") {
      el.width = 0;
      el.height = 0;
      el.getContext = () => {
        const ctx2d = makeCtx2d();
        el.ctx2d = ctx2d;
        return ctx2d;
      };
    }
    return el;
  }
};

const winListeners = {};
globalThis.window = {
  innerWidth: 1280,
  innerHeight: 800,
  devicePixelRatio: 1,
  addEventListener(type, fn) { (winListeners[type] ??= []).push(fn); },
  removeEventListener(type, fn) { winListeners[type] = (winListeners[type] ?? []).filter((f) => f !== fn); }
};

let rafQueue = [];
let rafId = 0;
globalThis.requestAnimationFrame = (cb) => {
  rafQueue.push(cb);
  return (rafId += 1);
};
globalThis.cancelAnimationFrame = () => {};
/** Run every scheduled frame once. */
const stepFrames = (t) => {
  const q = rafQueue;
  rafQueue = [];
  for (const cb of q) cb(t);
};

const postedConfigs = [];
let configStore = null;
globalThis.fetch = async (url, opts) => {
  if (url === "/effects/config" && opts?.method === "POST") {
    postedConfigs.push(JSON.parse(opts.body));
    return { ok: true, status: 200 };
  }
  if (url === "/effects/config") {
    return configStore ? { ok: true, status: 200, json: async () => configStore } : { ok: false, status: 404 };
  }
  throw new Error("FAIL: unexpected fetch " + url);
};

// ---------- load the client factory ----------
const raw = readFileSync(new URL("lib/client.js", PLUGIN_DIR), "utf8");
let capturedEntry = null;
globalThis.window.__ModuleLoader__ = { load: (entry) => { capturedEntry = entry; } };
vm.runInThisContext(raw, { filename: "dsh-plugin-effects/lib/client.js" });
const stubComponents = [];
const clientExports = capturedEntry.factory((spec) => {
  if (spec === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }) };
  if (spec === "@deepseek-ai/dsh-client-store") {
    return { defineStore: (def) => ({ ...def, state: def.init() }) };
  }
  throw new Error("FAIL: unexpected require: " + spec);
});
if (clientExports.name !== "dsh-plugin-effects") throw new Error("FAIL: name");
if (JSON.stringify(clientExports.inject) !== JSON.stringify(["slots", "locale"])) throw new Error("FAIL: inject");

const disposers = [];
const slotInjects = [];
const localeRegs = [];
const ctx = {
  effect(cb) {
    const out = cb();
    const dispose = () => (typeof out === "function" ? out() : undefined);
    disposers.push(dispose);
    return dispose;
  },
  locale: { register: (ns, dict) => localeRegs.push({ ns, dict }) },
  slots: {
    inject: (slot, factory) => slotInjects.push({ slot, factory }),
    register: (props, Component) => {
      const entry = { props, Component };
      stubComponents.push(entry);
      return entry;
    }
  }
};

clientExports.apply(ctx);
if (styleTags.length !== 1 || !styleTags[0].textContent.includes(".dfe-chip")) throw new Error("FAIL: css not injected");
const cssText = styleTags[0].textContent;
if (!cssText.includes("data-active")) throw new Error("FAIL: active chip rule missing");
if (localeRegs.length !== 1 || localeRegs[0].ns !== "dsh-plugin-effects") throw new Error("FAIL: locale not registered");
if (!localeRegs[0].dict.zh || !localeRegs[0].dict.en || !localeRegs[0].dict.zh["effects.title"]) throw new Error("FAIL: zh/en dictionaries missing");
if (slotInjects.length !== 1 || slotInjects[0].slot !== "settings.general.item") throw new Error("FAIL: settings slot not injected");
console.log("apply OK: css + locale + settings slot registered");

// resolve the slot registration like the host would
const registration = slotInjects[0].factory();
if (registration.props.id !== "ui-effects") throw new Error("FAIL: row id");
if (registration.props.order !== 22) throw new Error("FAIL: row order");
if (registration.props.locale !== "dsh-plugin-effects") throw new Error("FAIL: row locale ns");
if (typeof registration.Component !== "function") throw new Error("FAIL: row component");

const storeActions = [];
const actions = registration.props.inject({
  sync: (...args) => storeActions.push(args)
});
if (storeActions.length !== 1) throw new Error("FAIL: initial sync missing");
if (storeActions[0][0] !== "none") throw new Error("FAIL: initial effect should be none");

// pick snow -> canvas created, hidden initially? no: display block with default opacity
actions.setEffect("snow");
const canvas = created.find((el) => el.tag === "canvas");
if (!canvas) throw new Error("FAIL: canvas not created");
if (canvas.style.pointerEvents !== "none") throw new Error("FAIL: canvas must be pointer-transparent");
if (canvas.style.position !== "fixed") throw new Error("FAIL: canvas must be fixed");
if (canvas.style.display !== "block") throw new Error("FAIL: canvas not shown");
if (canvas.style.opacity !== "0.6") throw new Error("FAIL: default opacity: " + canvas.style.opacity);
if (!winListeners.resize?.length) throw new Error("FAIL: resize listener missing");
if (!docListeners.visibilitychange?.length) throw new Error("FAIL: visibilitychange listener missing");
console.log("canvas OK: fixed overlay, pointer-events none, default opacity");

// render one frame: snow draws arcs (flakes), schedules the next frame
stepFrames(100);
if (canvas.ctx2d.calls.clearRect !== 1) throw new Error("FAIL: frame did not clear");
if (canvas.ctx2d.calls.arcs === 0 || canvas.ctx2d.calls.fills === 0) throw new Error("FAIL: snow flakes not drawn");
const queuedAfterOne = rafQueue.length;
if (queuedAfterOne !== 1) throw new Error("FAIL: loop should keep scheduling");
stepFrames(200);
if (canvas.ctx2d.calls.clearRect !== 2) throw new Error("FAIL: second frame missing");
console.log("render OK: snow frames draw and loop");

// steppers: intensity + opacity bounds, persisted
actions.setIntensity(1.5);
actions.setOpacity(0.4);
if (canvas.style.opacity !== "0.4") throw new Error("FAIL: opacity not applied");
actions.setIntensity(99);
actions.setOpacity(99);
if (canvas.style.opacity !== "1") throw new Error("FAIL: opacity clamp to max");
actions.setOpacity(0.01);
if (canvas.style.opacity !== "0.1") throw new Error("FAIL: opacity clamp to min");
actions.setIntensity(1.5);
await new Promise((r) => setTimeout(r, 500));
const lastPost = postedConfigs.at(-1);
if (lastPost.effect !== "snow" || lastPost.intensity !== 1.5 || lastPost.opacity !== 0.1) throw new Error("FAIL: persist: " + JSON.stringify(lastPost));
console.log("steppers OK: clamped values applied and persisted");

// switching to none hides the canvas and stops the loop
rafQueue = [];
actions.setEffect("none");
if (canvas.style.display !== "none") throw new Error("FAIL: none should hide the canvas");
stepFrames(300);
if (canvas.ctx2d.calls.clearRect !== 2) throw new Error("FAIL: loop should be stopped on none");
console.log("none OK: canvas hidden, loop stopped");

// unknown effect ids fall back to none, not crash
actions.setEffect("meteor-shower");
if (storeActions.at(-1)[0] !== "none") throw new Error("FAIL: unknown effect should clamp to none");
console.log("fallback OK: unknown effect -> none");

// orbit effect: gray particles random-walk, then the pointer captures them.
// Each stepFrames call advances exactly one frame (the running frame reschedules
// itself), so a loop is needed to advance several.
const runFrames = (count, t0) => {
  for (let i = 0; i < count; i += 1) stepFrames((t0 ?? 0) + i * 16);
};
actions.setEffect("orbit");
if (canvas.style.display !== "block") throw new Error("FAIL: orbit should show the canvas");
runFrames(5, 1000);
const orbitArcs = canvas.ctx2d.coords.length;
if (orbitArcs === 0) throw new Error("FAIL: orbit particles not drawn");
const [px, py] = canvas.ctx2d.coords.at(-1);
if (py < -8 || py > 808) throw new Error("FAIL: picked a stale pre-orbit coordinate");
docListeners.mousemove[0]({ clientX: px, clientY: py });
runFrames(30, 2000);
if (canvas.ctx2d.calls.brightFills === 0) throw new Error("FAIL: pointer capture produced no orbiting particles");
console.log("orbit capture OK: particles captured by the pointer");

// leaving the window releases every captured particle
const brightBefore = canvas.ctx2d.calls.brightFills;
docListeners.mouseleave[0]();
runFrames(10, 3000);
if (canvas.ctx2d.calls.brightFills !== brightBefore) throw new Error("FAIL: captured particles should release when the pointer leaves");
console.log("orbit release OK: pointer leave frees the ring");

// teardown removes the canvas and listeners
for (const dispose of disposers) dispose();
if (!canvas.removed) throw new Error("FAIL: teardown should remove canvas");
if (winListeners.resize?.length) throw new Error("FAIL: teardown should drop resize listener");
if (docListeners.visibilitychange?.length) throw new Error("FAIL: teardown should drop visibilitychange listener");
if (docListeners.mousemove?.length) throw new Error("FAIL: teardown should drop mousemove listener");
if (docListeners.mouseleave?.length) throw new Error("FAIL: teardown should drop mouseleave listener");
console.log("teardown OK");

// restore from persisted config (fresh apply)
configStore = { effect: "rain", intensity: 1.5, opacity: 0.4 };
created = [];
clientExports.apply(ctx);
slotInjects[0].factory();
await new Promise((r) => setTimeout(r, 50));
const canvas2 = created.find((el) => el.tag === "canvas");
if (!canvas2) throw new Error("FAIL: restored canvas missing");
if (canvas2.style.opacity !== "0.4") throw new Error("FAIL: restored opacity: " + canvas2.style.opacity);
if (canvas2.style.display !== "block") throw new Error("FAIL: restored display");
stepFrames(400);
if (canvas2.ctx2d.calls.strokes === 0) throw new Error("FAIL: rain should stroke on first frame");
console.log("restore from config OK");
for (const dispose of disposers) dispose();
console.log("CLIENT SMOKE OK");

// ---------- host ----------
const { handleConfig, configPath } = host;
const fakeReq = (body, method = "POST") => {
  const chunks = body ? [Buffer.from(body)] : [];
  return {
    method,
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
await handleConfig(fakeReq(null, "GET"), res);
if (res.out.status !== 404) throw new Error("FAIL: GET should 404 initially");

res = fakeRes();
await handleConfig(fakeReq(JSON.stringify({ effect: "snow" })), res);
if (res.out.status !== 200) throw new Error("FAIL: POST: " + res.out.status);
if (!existsSync(configPath())) throw new Error("FAIL: config file not written");
if (readdirSync(TEST_HOME + "/effects").some((n) => n.endsWith(".tmp"))) throw new Error("FAIL: tmp file left behind");
const withDefaults = JSON.parse(res.out.body).config;
if (withDefaults.effect !== "snow" || withDefaults.intensity !== 1 || withDefaults.opacity !== 0.6) {
  throw new Error("FAIL: schema defaults: " + JSON.stringify(withDefaults));
}

res = fakeRes();
await handleConfig(fakeReq(null, "GET"), res);
if (JSON.parse(res.out.body).effect !== "snow") throw new Error("FAIL: roundtrip");

res = fakeRes();
await handleConfig(fakeReq(JSON.stringify({ effect: "meteor" })), res);
if (res.out.status !== 400) throw new Error("FAIL: unknown effect should 400");

res = fakeRes();
await handleConfig(fakeReq(JSON.stringify({ effect: "rain", intensity: 9 })), res);
if (res.out.status !== 400) throw new Error("FAIL: out-of-range intensity should 400");

res = fakeRes();
await handleConfig(fakeReq(JSON.stringify({ effect: "rain", opacity: 0 })), res);
if (res.out.status !== 400) throw new Error("FAIL: out-of-range opacity should 400");

res = fakeRes();
await handleConfig(fakeReq("{oops}"), res);
if (res.out.status !== 400) throw new Error("FAIL: invalid JSON should 400");

res = fakeRes();
await handleConfig(fakeReq(null, "DELETE"), res);
if (res.out.status !== 405) throw new Error("FAIL: DELETE should 405");

console.log("HOST SMOKE OK");
rmSync(TEST_HOME, { recursive: true, force: true });
console.log("ALL CHECKS PASSED");

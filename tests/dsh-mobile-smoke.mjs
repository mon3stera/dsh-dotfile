// Smoke test for dsh-plugin-mobile: the client contract, the phone stylesheet,
// the details overlay, the settings-dialog stacking, the keyboard viewport fix,
// the drawer scrim, and - most importantly - the host contracts every rule is
// keyed on. The stylesheet steers geometry the host writes inline, so a silent
// host rename would leave a plugin that still loads and quietly does nothing.
// Each anchor is therefore re-read from the installed bundles here.
import { readFileSync } from "node:fs";
import vm from "node:vm";

let pass = 0;
let fail = 0;
const eq = (actual, expected, label) => {
	if (actual === expected) {
		pass += 1;
		console.log(`PASS ${label}`);
		return;
	}
	fail += 1;
	console.log(`FAIL ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
};
const ok = (value, label) => eq(Boolean(value), true, label);

// ------------------------------------------------------------------ node half
const host = await import("../plugins/dsh-plugin-mobile/lib/index.js");
eq(host.name, "dsh-plugin-mobile", "node entry exports the plugin name");
eq(typeof host.apply, "function", "node entry exports a no-op apply");
eq(host.apply(), undefined, "node apply does nothing");

// ------------------------------------------------------------------- manifest
const manifest = JSON.parse(
	readFileSync(new URL("../plugins/dsh-plugin-mobile/package.json", import.meta.url), "utf8"),
);
eq(manifest.name, "dsh-plugin-mobile", "manifest name");
eq(manifest.exports["./client"], "./lib/client.js", "manifest exposes the client half");
eq(manifest.dsh.client.platform, "web", "client half targets web");
ok(
	manifest.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-layout"),
	"manifest injects the layout client package that declares shell.overlay",
);
ok(
	manifest.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-conversation"),
	"manifest injects the conversation client package that declares conversation.input.left",
);

// ---------------------------------------------------------------- client half
const raw = readFileSync(new URL("../plugins/dsh-plugin-mobile/lib/client.js", import.meta.url), "utf8");
let captured;
globalThis.window = {
	__ModuleLoader__: { load: (entry) => { captured = entry; } },
	listeners: {},
	addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
	removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); },
};
const styleTags = [];
const metaStub = { content: "width=device-width, initial-scale=1" };
const rootStub = {
	attrs: new Map(),
	setAttribute(k, v) { this.attrs.set(k, v); },
	removeAttribute(k) { this.attrs.delete(k); },
	style: {
		props: new Map(),
		setProperty(k, v) { this.props.set(k, v); },
		removeProperty(k) { this.props.delete(k); },
	},
};
// Stand-in geometry for the FAB anchor: frame bottom 844, composer seat top
// 713 - the measured real-session numbers on an 844px viewport.
let frameSel = null;
const frameStub = { getBoundingClientRect: () => ({ bottom: 844 }) };
let seatStub = { getBoundingClientRect: () => ({ top: 713 }) };
const docListeners = { map: new Map() };
const createdInputs = [];
const appendedToBody = [];
const dispatchedEvents = [];
globalThis.document = {
	head: { appendChild: (tag) => styleTags.push(tag) },
	createElement: (tag) => {
		const el = {
			tagName: tag, dataset: {}, textContent: "", style: {},
			type: undefined, accept: undefined, multiple: undefined,
			files: [], listeners: {}, clicked: false,
			addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
			remove() {}, click() { this.clicked = true; },
		};
		if (tag === "input") createdInputs.push(el);
		return el;
	},
	body: { appendChild: (el) => appendedToBody.push(el) },
	dispatchEvent: (event) => { dispatchedEvents.push(event); },
	querySelector: (sel) => {
		if (sel === 'meta[name="viewport"]') return metaStub;
		if (sel === "[data-composer-seat]") return seatStub;
		if (frameSel !== null && sel === frameSel) return frameStub;
		return null;
	},
	addEventListener(type, fn, opts) { docListeners.map.set(`${type}:${Boolean(opts?.capture)}`, fn); },
	removeEventListener(type, fn, opts) {
		if (docListeners.map.get(`${type}:${Boolean(opts?.capture)}`) === fn) docListeners.map.delete(`${type}:${Boolean(opts?.capture)}`);
	},
	documentElement: rootStub,
};
// The intake rides DOM drop construction; Node has neither constructor.
globalThis.DataTransfer = class {
	constructor() { this.files = []; this.items = { add: (file) => this.files.push(file) }; }
};
globalThis.DragEvent = class {
	constructor(type, opts = {}) { this.type = type; this.dataTransfer = opts.dataTransfer; this.bubbles = opts.bubbles; }
};
vm.runInThisContext(raw, { filename: "dsh-plugin-mobile/lib/client.js" });
eq(captured?.id, "dsh-plugin-mobile", "client module id");

const client = captured.factory((spec) => {
	if (spec === "react/jsx-runtime") {
		return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
	}
	throw new Error(`unexpected require: ${spec}`);
});
eq(client.name, "dsh-plugin-mobile", "client plugin name");
eq(
	JSON.stringify(client.inject),
	JSON.stringify(["slots", "locale", "layout"]),
	"client injects slots, locale, and the layout service it drives",
);

// ---------------------------------------------------------- FAB anchor rig
// Installed before any apply() so trackFabAnchor runs its full path.
frameSel = client.FRAME;
class ROStub {
	constructor(cb) { this.cb = cb; ROStub.all.push(this); this.observed = []; this.disconnected = false; }
	observe(el) { this.observed.push(el); }
	unobserve(el) { this.observed = this.observed.filter((e) => e !== el); }
	disconnect() { this.disconnected = true; }
}
ROStub.all = [];
globalThis.ResizeObserver = ROStub;
// Queueing rAF: trackFabAnchor retries per frame while the app mounts, so an
// immediately-executing stub would recurse without bound when a target is
// absent. Tests drive the queue by hand with flushRaf().
let rafQueue = [];
globalThis.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length; };
const flushRaf = () => {
	const batch = rafQueue;
	rafQueue = [];
	for (const fn of batch) fn();
};

// -------------------------------------------------------------- the breakpoint
const HOST_DIR = "/home/mon3tr/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai";
const layoutSrc = readFileSync(`${HOST_DIR}/dsh-client-ui-layout/lib/client.js`, "utf8");
const conversationSrc = readFileSync(`${HOST_DIR}/dsh-client-ui-conversation/lib/client.js`, "utf8");
const settingsSrc = readFileSync(`${HOST_DIR}/dsh-client-ui-settings-general/lib/client.js`, "utf8");

const autoCollapse = /SIDEBAR_AUTO_COLLAPSE = (\d+)/.exec(layoutSrc);
ok(autoCollapse !== null, "host still defines its narrow-mode breakpoint");
const hostNarrow = Number(autoCollapse[1]);
eq(hostNarrow, 1024, "host auto-collapses the sidebar below 1024px");
ok(
	client.PHONE_MAX < hostNarrow,
	"the phone breakpoint is a strict subset of host narrow mode, so the drawer rules "
		+ "only ever see `data-sidebar-collapsed` tracking the narrow override",
);

// The details bound derives from `computeColumns`: an open details track stays
// inline only while `56 (rail) + 300 (details min) + 640 (centre min)` fits,
// i.e. from 996px up. Below that the host always computes `details: 0`.
eq(client.DETAILS_MAX, 995, "the details overlay bound is one below the host's inline bound");
ok(layoutSrc.includes("clampWidth(details, 300, 520)"), "host still clamps the details preference to min 300");
ok(layoutSrc.includes("details: 0"), "host still falls through to a 0px details track");

// ------------------------------------------------------- stylesheet composition
const CSS = client.CSS;
ok(CSS.startsWith(`@media (max-width:${client.PHONE_MAX}px){`), "the phone block opens the stylesheet");
eq(CSS.split("@media").length - 1, 2, "exactly two media queries: the phone block and the details block");
eq((CSS.match(/\{/g) || []).length, (CSS.match(/\}/g) || []).length, "stylesheet braces balance");
ok(CSS.includes(`@media (max-width:${client.DETAILS_MAX}px){`), "the details block is scoped to the derived bound");

ok(CSS.includes("overscroll-behavior:contain"), "contains transcript overscroll");
ok(CSS.includes("grid-template-columns:0 minmax(0,1fr) 0!important"), "collapses the sidebar track for the drawer");
// Measured in Chrome at 390px: `position:absolute` on the sidebar column shifts
// the remaining grid items one track left, giving the conversation a 0px column.
ok(CSS.includes("position:relative;z-index:25;overflow:visible"), "the drawer overflows its track instead of leaving grid flow");
ok(!/>:first-child\{[^}]*position:absolute/.test(CSS), "the sidebar column never leaves grid flow");
ok(CSS.includes(`.${"dsh-plugin-mobile"}-scrim`), "defines the scrim class");

// Two rules are deliberately absent because measurement disproved the premise.
// If either is ever added back, it has to be re-measured first.
ok(
	!CSS.includes("--dsh-composer-side-clearance"),
	"no rule moves --dsh-composer-side-clearance: it is undefined in this build, so the override was a no-op",
);
ok(
	!CSS.includes("font-size:16px"),
	"no iOS focus-zoom rule: the composer input already computes 16px through inherit",
);

// The frame is identified structurally, never by a hashed CSS-module class.
eq(client.FRAME, "div:has(> [data-shell-overlay])", "the frame is identified by its declared overlay outlet");
ok(!/[.][A-Za-z0-9]{5,8}_[a-z]/.test(CSS), "no hashed host class name is selected");

// ------------------------------------------------------ new rules and contracts
// Tables: the transcript scrollport clips at overflow:hidden, so a wide table
// must become its own horizontal scroller inside the phone scope.
const phoneBlock = CSS.slice(CSS.indexOf("@media"), CSS.indexOf(`@media (max-width:${client.DETAILS_MAX}px)`));
ok(
	phoneBlock.includes("[data-conversation-scroll] table{display:block;width:fit-content;max-width:100%;overflow-x:auto}"),
	"transcript tables scroll within themselves inside the phone block",
);

// Settings dialog: keyed on the declared slot outlet and the dialog role.
const dialogSel = '[data-slot="sidebar.settings"] [role="dialog"]';
ok(phoneBlock.includes(`${dialogSel}{flex-direction:column;height:min(800px,100dvh - 48px)}`), "stacks the settings dialog single-column with a dynamic-viewport height");
ok(phoneBlock.includes(`${dialogSel}>nav{width:auto;flex:none;padding:10px 12px 0}`), "shrinks the settings nav to a top strip");
ok(phoneBlock.includes(`${dialogSel}>nav>div+div{flex-direction:row;overflow-x:auto}`), "turns the nav list into a scrollable chip row");
ok(phoneBlock.includes(`${dialogSel}>nav+div{min-height:0}`), "lets the content pane scroll instead of stretching the panel");
// Host anchors for the settings rules: the slot name, the dialog role, the
// 188px nav width the fix overrides, and the 100vh height it replaces. All
// four are hash-independent strings from the settings bundle.
ok(settingsSrc.includes('"sidebar.settings"'), "host still declares the sidebar.settings slot outlet");
ok(settingsSrc.includes('role: "dialog"'), "the settings panel still carries role=dialog");
ok(settingsSrc.includes("width:188px"), "the settings nav is still the 188px column the fix overrides");
ok(settingsSrc.includes("100vh - 48px"), "the settings panel height still derives from 100vh, which 100dvh replaces on Android");

// Collapsed rail: hidden on a phone with the same track collapse the drawer
// uses, keyed on the opposite attribute. `computeColumns` answers a closed
// preference with `sidebar: 56` on every width, and the sidebar column's own
// `min-width:0;overflow:hidden` clips the rail once the track is zero, so no
// hashed class or inline width is fought.
ok(layoutSrc.includes("sidebar === 0 ? 56 :"), "the host still keeps a 56px rail track for a closed sidebar");
ok(
	phoneBlock.includes(`${client.FRAME}[data-sidebar-collapsed]{grid-template-columns:0 minmax(0,1fr) 0!important}`),
	"the collapsed rail track collapses to zero inside the phone block",
);
ok(
	phoneBlock.includes(`${client.FRAME}[data-sidebar-collapsed]>:first-child{visibility:hidden}`),
	"the rail drops out of hit-testing and the tab order while collapsed",
);

// FAB: an inert base rule outside every media block, and inside the phone
// block a full style plus an un-hide keyed on the collapsed attribute - which
// is absent exactly while the drawer is open, when the scrim dismisses.
ok(CSS.includes(`.${"dsh-plugin-mobile"}-fab{display:none}`), "the FAB base rule sits outside every media block");
ok(CSS.endsWith(`.${"dsh-plugin-mobile"}-image{display:none}`), "the image button's inert base rule closes the stylesheet");
ok(phoneBlock.includes(`.${"dsh-plugin-mobile"}-fab{position:absolute`), "the FAB is styled inside the phone block only");
ok(
	phoneBlock.includes(`${client.FRAME}[data-sidebar-collapsed] .${"dsh-plugin-mobile"}-fab{display:flex}`),
	"the FAB appears only on a phone while the sidebar is collapsed",
);
ok(
	phoneBlock.includes("bottom:var(--dsh-plugin-mobile-fab-bottom,148px)"),
	"the FAB bottom is the live anchor property with the measured 148px fallback",
);

// Header utility band: session log download, outline, and the diff-viewer
// trigger all register into the declared utilities list slot, so hiding that
// one outlet hides all three. Anchored on the slot name in the conversation
// bundle and the renderer's data-slot emission contract - the same mechanism
// the settings-dialog rule already depends on.
ok(
	phoneBlock.includes('[data-slot="conversation.session.header.utilities"]{display:none!important}'),
	"the header utility band is hidden inside the phone block (outlets carry inline display:contents, so !important is required)",
);
ok(
	conversationSrc.includes("conversation.session.header.utilities"),
	"host still declares the header.utilities slot outlet",
);
const rendererSrc = readFileSync(`${HOST_DIR}/dsh-client-ui-renderer/lib/client.js`, "utf8");
ok(
	rendererSrc.includes('data-slot": slotKey') || rendererSrc.includes('data-slot": "root"'),
	"the renderer still emits data-slot on outlets, which the rule keys on",
);

// Model trigger: the full label spans are hidden and a short label takes
// their place, so the tool row keeps one line at phone widths. The host's
// own picker menu stays the selection surface - and renders INSIDE the
// outlet, so the rules are keyed on the trigger's aria-haspopup to leave the
// menu items' own labels alone. Anchored on the outlet name in the
// conversation bundle.
ok(
	phoneBlock.includes('[data-slot="conversation.input.model"] button[aria-haspopup="menu"] span{display:none}'),
	"the model trigger's full label is hidden inside the phone block, keyed on the trigger's aria-haspopup",
);
ok(
	phoneBlock.includes('[data-slot="conversation.input.model"] button[aria-haspopup="menu"]::before{content:"模型"}'),
	"the model trigger shows a short label instead",
);
ok(
	conversationSrc.includes("conversation.input.model"),
	"host still declares the conversation.input.model slot outlet",
);

// Image picker CSS: styled and shown only inside the phone block; the inert
// base rule sits outside every media block like the FAB's.
ok(
	phoneBlock.includes(`button.${"dsh-plugin-mobile"}-image{display:inline-flex`),
	"the image button is styled and shown inside the phone block only",
);
ok(
	phoneBlock.includes(`button.${"dsh-plugin-mobile"}-image{display:inline-flex`) && phoneBlock.includes("width:28px;height:28px"),
	"the image button is styled inside the phone block at the tool row's 28px icon size",
);

// The intake depends on the attachment occupant's document-level drop
// listener - the host contract the synthetic drop rides. Anchored on the
// exact registration string in the attachment bundle.
const attachmentSrc = readFileSync(`${HOST_DIR}/dsh-client-ui-attachment/lib/client.js`, "utf8");
ok(
	attachmentSrc.includes('document.addEventListener("drop", onDrop)'),
	"the attachment occupant still admits document drops, which the phone picker routes through",
);

// Details overlay: keyed on the wrapper's html attribute, positioned absolute.
// Absolute is safe here (and only here) because the details column is the LAST
// in-flow grid item - the overlay outlet after it is position:absolute and the
// sidebar column precedes it, so nothing reflows when it leaves grid flow.
const detailsBlock = CSS.slice(CSS.indexOf(`@media (max-width:${client.DETAILS_MAX}px)`));
const detailsRule = `${client.DETAILS_OPEN} ${client.DETAILS_COL}{position:absolute;top:0;bottom:0;right:0;width:min(360px,100vw);z-index:25;box-shadow:-12px 0 40px rgb(0 0 0/.45)}`;
ok(detailsBlock.includes(detailsRule), "promotes an open details panel to a right-hand overlay at the store's own 360px width");
ok(client.DETAILS_COL === `${client.FRAME}>:nth-child(3)`, "the details column is addressed structurally as the third frame child");
// Host anchors: the overlay outlet is absolutely positioned (so removing the
// details column from grid flow shifts nothing), the frame children render in
// sidebar/center/details/overlay order, and the collapsed attribute keys on the
// computed track - which is why the wrapper exists.
ok(/\.pI_x6G_[A-Za-z0-9]*overlay[A-Za-z0-9]*\{z-index:20;pointer-events:none;position:absolute;inset:0\}/.test(layoutSrc), "the overlay outlet is absolutely positioned and out of grid flow");
const order = ["sidebarCol", "centerCol", "detailsCol", "overlayLayer"].map((c) => layoutSrc.indexOf(`pI_x6G_${c}`));
ok(order.every((i) => i > 0) && [...order].sort((a, b) => a - b).every((v, i) => v === order[i]), "the frame still renders sidebar, centre, details, then the overlay outlet");
ok(layoutSrc.includes('"data-details-collapsed": cols.details === 0 || void 0'), "the host collapsed attribute keys on the computed track, which is always 0 below the bound");
ok(!detailsBlock.includes("data-sidebar-collapsed"), "the details block never keys on the sidebar attribute");

// ------------------------------------------------------- keyboard viewport fix
eq(client.applyKeyboardViewport(), true, "extends the served viewport meta");
eq(metaStub.content, "width=device-width, initial-scale=1, interactive-widget=resizes-content", "requests the keyboard-resizing behavior");
eq(client.applyKeyboardViewport(), false, "does not add the key twice");
ok(layoutSrc.includes("interactive-widget") === false || true, "host meta is served outside the bundles, so nothing to anchor here");
ok(raw.includes("interactive-widget=resizes-content"), "the client source requests resizes-content");
ok(raw.includes('meta.content.includes("interactive-widget=")'), "an explicit host choice would win");

// ---------------------------------------------------------- host anchor checks
const anchors = [
	['"data-shell-overlay"', layoutSrc, "the overlay outlet the frame selector depends on"],
	['"data-sidebar-collapsed"', layoutSrc, "the attribute the drawer state keys on"],
	['"data-side"', layoutSrc, "the drag-handle marker"],
	["gridTemplateColumns", layoutSrc, "the inline grid the !important overrides target"],
	['provide("layout"', layoutSrc, "the layout service the scrim dismisses through"],
	["toggleSidebar", layoutSrc, "the action the scrim calls"],
	["openDetails", layoutSrc, "the details action the wrapper observes"],
	["closeDetails", layoutSrc, "the details action the wrapper observes"],
	["LayoutController", layoutSrc, "the shared service face the wrapper patches"],
	['"data-conversation-scroll"', conversationSrc, "the transcript scrollport"],
];
for (const [needle, source, why] of anchors) {
	ok(source.includes(needle), `host still provides ${needle} - ${why}`);
}
// Every details open/close in the host goes through the shared service face,
// which is what makes the wrapper a complete observer. Since the 0.1.2 update
// the details trigger lives in the chat package (the conversation no longer
// opens details itself), so the anchor moved with it.
const chatSrc = readFileSync(`${HOST_DIR}/dsh-client-ui-chat/lib/client.js`, "utf8");
eq((chatSrc.match(/openDetails\(/g) || []).length, 1, "the chat package opens details only through the layout service");
ok(/ctx\.layout\.openDetails\(/.test(chatSrc), "the chat package calls the service face, not a private store binding");
ok(/ctx\.layout\.closeDetails\(/.test(chatSrc), "the chat package still closes details through the service face");

// shell.overlay must remain a list slot: a single slot would make registration
// an ownership fight with whatever else wants the overlay layer.
ok(
	/"shell\.overlay":\s*\{\s*kind:\s*"list"/.test(layoutSrc),
	"shell.overlay is still a list slot, so registering into it needs no priority",
);
// The drag handle is still pointer-only and still blocks touch scrolling.
ok(
	/cursor:col-resize[^}]*touch-action:none|touch-action:none[^}]*cursor:col-resize/.test(layoutSrc),
	"the drag handles are still pointer-only and still claim touch gestures",
);
// The open sidebar still squeezes rather than covers, which is what the drawer fixes.
ok(
	/clampWidth\(px, 264, 420\)/.test(layoutSrc) || /clampWidth\(sidebar, 264, 420\)/.test(layoutSrc),
	"an open sidebar still claims at least 264px of the frame",
);

// --------------------------------------------------------------- registration
let toggles = 0;
const ctx = {
	entries: [],
	injectedSlots: [],
	locales: null,
	effects: 0,
	effect(callback) { ctx.effects += 1; callback(); },
	locale: { register: (_ns, dictionaries) => { ctx.locales = dictionaries; } },
	layout: {
		toggleSidebar() { toggles += 1; },
		openDetails() { ctx.opened = (ctx.opened || 0) + 1; },
		closeDetails() { ctx.closed = (ctx.closed || 0) + 1; },
	},
	slots: {
		inject(name, callback) { ctx.injectedSlots.push(name); callback(); },
		register(options, component) { ctx.entries.push({ ...options, component }); return () => {}; },
	},
};
client.apply(ctx);
eq(
	JSON.stringify(ctx.injectedSlots),
	JSON.stringify(["shell.overlay", "conversation.input.left"]),
	"injects both declared slots before registering into them",
);
eq(ctx.entries.length, 3, "registers the scrim, the FAB, and the image picker");
for (const entry of ctx.entries) {
	eq(entry.locale, "dsh-plugin-mobile", `entry ${entry.id} carries the plugin locale namespace`);
	eq(entry.order, undefined, `entry ${entry.id} needs no order in a list slot`);
}
const [scrimEntry, fabEntry, imageEntry] = ctx.entries;
eq(scrimEntry.name, "shell.overlay", "the scrim and FAB register into the overlay slot");
eq(fabEntry.name, "shell.overlay", "the scrim and FAB register into the overlay slot");
eq(imageEntry.name, "conversation.input.left", "the image picker registers into the tool row's left list slot");
eq(scrimEntry.id, "mobile-scrim", "stable scrim entry id");
eq(fabEntry.id, "mobile-fab", "stable FAB entry id");
eq(imageEntry.id, "mobile-image", "stable image picker entry id");
eq(styleTags.length, 1, "injects exactly one style tag");
eq(styleTags[0].dataset.plugin, "dsh-plugin-mobile", "style tag is attributed to the plugin");
eq(styleTags[0].textContent, CSS, "the injected stylesheet is the exported one");
ok(ctx.locales.zh.dismiss.length > 0 && ctx.locales.en.dismiss.length > 0, "both locales name the dismiss action");
ok(ctx.locales.zh.open.length > 0 && ctx.locales.en.open.length > 0, "both locales name the open action");
ok(ctx.locales.zh.addImages.length > 0 && ctx.locales.en.addImages.length > 0, "both locales name the image picker");

// The FAB anchor publishes the frame-to-composer-seat distance on <html>:
// 844 - 713 + 12(gap) = 143px. A fixed offset cannot work - the composer is a
// sticky element INSIDE the scroll container (its bottom equals the frame
// bottom, measured), and it grows with content and the system font scale,
// which is exactly how the 96px and 148px constants ended up in the input box.
flushRaf();
eq(
	rootStub.style.props.get("--dsh-plugin-mobile-fab-bottom"),
	"143px",
	"apply publishes the live FAB anchor from the frame and seat geometry",
);
const anchorRo = ROStub.all.at(-1);
ok(anchorRo.observed.includes(seatStub), "the anchor observes the composer seat for card growth");
ok(window.listeners.resize?.includes(anchorRo.cb) === true, "the anchor re-syncs on viewport resize");
ok(docListeners.map.get("scroll:true") !== undefined, "the anchor re-syncs on capture-phase scroll");

// The disposer uninstalls everything, leaving no property behind. The direct
// call creates its own observer instance, which is the one it must tear down.
const disposeFab = client.trackFabAnchor();
const freshRo = ROStub.all.at(-1);
flushRaf();
eq(rootStub.style.props.get("--dsh-plugin-mobile-fab-bottom"), "143px", "a fresh anchor republishes the property");
disposeFab();
eq(rootStub.style.props.has("--dsh-plugin-mobile-fab-bottom"), false, "the disposer removes the property");
eq(freshRo.disconnected, true, "the disposer disconnects its own observer");
eq(window.listeners.resize.includes(freshRo.cb), false, "the disposer removes its own resize listener");

// Mount retry: before the app mounts neither target exists, and the per-frame
// retry must stay bounded instead of spinning forever on a hero-only screen.
const seatHeld = seatStub;
seatStub = null;
const retry = client.trackFabAnchor();
flushRaf();
eq(rootStub.style.props.has("--dsh-plugin-mobile-fab-bottom"), false, "no property while the targets are absent");
for (let i = 0; i < 700 && rafQueue.length > 0; i += 1) flushRaf();
eq(rafQueue.length, 0, "the mount retry stops at its tick cap");
// Once mounted, the already-installed scroll listener re-syncs and wires.
seatStub = seatHeld;
docListeners.map.get("scroll:true")();
eq(
	rootStub.style.props.get("--dsh-plugin-mobile-fab-bottom"),
	"143px",
	"a capture scroll re-syncs the anchor after a late mount",
);
retry();

// The details wrapper flips the html attribute around the original actions.
ctx.layout.openDetails();
eq(rootStub.attrs.get("data-dsh-plugin-mobile-details"), "open", "opening details marks the document element");
eq(ctx.opened, 1, "the original open action still runs");
ctx.layout.closeDetails();
eq(rootStub.attrs.has("data-dsh-plugin-mobile-details"), false, "closing details clears the mark");
eq(ctx.closed, 1, "the original close action still runs");

// -------------------------------------------------------------- rendered scrim
const t = (key) => `t:${key}`;
const node = scrimEntry.component({ ...scrimEntry.inject(), t });
eq(node.type, "button", "the scrim is a real button, not a bare div");
eq(node.props.className, "dsh-plugin-mobile-scrim", "the scrim carries the class the stylesheet drives");
eq(node.props.tabIndex, -1, "the scrim stays out of the tab order; the sidebar toggle is the keyboard path");
eq(node.props["aria-label"], "t:dismiss", "the scrim is labelled from the locale");
node.props.onClick();
eq(toggles, 1, "tapping the scrim closes the drawer through the layout service");

// ------------------------------------------------------------- rendered FAB
const fab = fabEntry.component({ ...fabEntry.inject(), t });
eq(fab.type, "button", "the FAB is a real button");
eq(fab.props.className, "dsh-plugin-mobile-fab", "the FAB carries the class the stylesheet drives");
eq(fab.props["aria-label"], "t:open", "the FAB is labelled from the locale");
eq(fab.props.tabIndex, undefined, "the FAB is a real control and stays in the tab order");
eq(fab.props.children.type, "svg", "the FAB draws its own inline menu icon");
eq(fab.props.children.props["aria-hidden"], true, "the icon is decorative");
fab.props.onClick();
eq(toggles, 2, "tapping the FAB opens the drawer through the same guarded toggle");
eq(scrimEntry.inject().dismiss, fabEntry.inject().open, "both overlay entries drive one shared toggle");

// ------------------------------------------------------- rendered image picker
const imageNode = imageEntry.component({ t });
eq(imageNode.type, "button", "the image picker is a real button");
eq(imageNode.props.className, "dsh-plugin-mobile-image", "the image picker carries the class the stylesheet drives");
eq(imageNode.props["aria-label"], "t:addImages", "the image picker is labelled from the locale");
eq(imageNode.props.children.type, "svg", "the image picker draws its own inline icon");

// Tapping opens a hidden multi-image file input through the platform picker.
imageNode.props.onClick();
eq(createdInputs.length, 1, "one file input is created");
const picker = createdInputs[0];
eq(picker.type, "file", "the input picks files");
eq(picker.accept, "image/*", "the input accepts images only");
eq(picker.multiple, true, "the input accepts a batch");
eq(appendedToBody.includes(picker), true, "the input is attached for the picker gesture");
eq(picker.clicked, true, "the picker gesture fires");

// A chosen batch is handed to the stock intake as one synthetic document
// drop - the attachment occupant's own document listener is the only
// file-admission path, so limits, the draft rail, and removal stay the host's.
const fileA = { name: "a.png" };
const fileB = { name: "b.jpg" };
picker.files = [fileA, fileB];
picker.listeners.change[0]();
eq(dispatchedEvents.length, 1, "one drop event reaches the document");
const drop = dispatchedEvents[0];
eq(drop.type, "drop", "the event is a drop");
eq(drop.dataTransfer.files.length, 2, "the drop carries every picked file");
eq(drop.dataTransfer.files[0].name, "a.png", "the drop preserves file order");
eq(createdInputs.length, 1, "no second input was created");

// An empty chooser must not dispatch, and the intake refuses no-file calls.
picker.files = [];
picker.listeners.change[0]();
eq(dispatchedEvents.length, 1, "no drop without picked files");
client.intakeImageFiles([]);
eq(dispatchedEvents.length, 1, "the intake refuses an empty batch");

// A tap before the frame wired its store actions must not throw at the user.
const throwing = { ...ctx, layout: { toggleSidebar() { throw new Error("layout: panel actions not wired"); } } };
throwing.entries = [];
throwing.slots = {
	inject(name, callback) { callback(); },
	register(options, component) { throwing.entries.push({ ...options, component }); return () => {}; },
};
client.apply(throwing);
const earlyNode = throwing.entries[0].component({ ...throwing.entries[0].inject(), t });
let threw = false;
try {
	earlyNode.props.onClick();
} catch (_error) {
	threw = true;
}
eq(threw, false, "a scrim tap before the frame is wired is swallowed, not surfaced");

// A layout face without details actions (older host) must not break apply().
const legacy = {
	effect(callback) { callback(); },
	locale: { register() {} },
	layout: { toggleSidebar() {} },
	slots: { inject() {}, register() { return () => {}; } },
};
let legacyThrew = false;
try {
	client.apply(legacy);
} catch (_error) {
	legacyThrew = true;
}
eq(legacyThrew, false, "apply tolerates a layout face without details actions");

console.log(fail === 0 ? `mobile ok (${pass} checks)` : `${fail} check(s) failed`);
process.exit(fail === 0 ? 0 : 1);

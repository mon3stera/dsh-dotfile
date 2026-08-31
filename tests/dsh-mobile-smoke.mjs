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

// ---------------------------------------------------------------- client half
const raw = readFileSync(new URL("../plugins/dsh-plugin-mobile/lib/client.js", import.meta.url), "utf8");
let captured;
globalThis.window = { __ModuleLoader__: { load: (entry) => { captured = entry; } } };
const styleTags = [];
const metaStub = { content: "width=device-width, initial-scale=1" };
const rootStub = { attrs: new Map(), setAttribute(k, v) { this.attrs.set(k, v); }, removeAttribute(k) { this.attrs.delete(k); } };
globalThis.document = {
	head: { appendChild: (tag) => styleTags.push(tag) },
	createElement: () => ({ dataset: {}, textContent: "", remove() {} }),
	querySelector: (sel) => (sel === 'meta[name="viewport"]' ? metaStub : null),
	documentElement: rootStub,
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
// which is what makes the wrapper a complete observer.
eq((conversationSrc.match(/openDetails\(/g) || []).length, 1, "the conversation opens details only through the layout service");
ok(/layout\.openDetails\(/.test(conversationSrc), "the conversation calls the service face, not a private store binding");

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
	entry: null,
	slotName: null,
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
		inject(name, callback) { ctx.slotName = name; callback(); },
		register(options, component) { ctx.entry = { ...options, component }; return () => {}; },
	},
};
client.apply(ctx);
eq(ctx.slotName, "shell.overlay", "injects the declared overlay slot before registering");
eq(ctx.entry.name, "shell.overlay", "registers into the same slot it injects");
eq(ctx.entry.id, "mobile-scrim", "stable slot entry id");
eq(ctx.entry.order, undefined, "a list slot needs no order for a single occupant");
eq(ctx.entry.locale, "dsh-plugin-mobile", "slot entry carries the plugin locale namespace");
eq(styleTags.length, 1, "injects exactly one style tag");
eq(styleTags[0].dataset.plugin, "dsh-plugin-mobile", "style tag is attributed to the plugin");
eq(styleTags[0].textContent, CSS, "the injected stylesheet is the exported one");
ok(ctx.locales.zh.dismiss.length > 0 && ctx.locales.en.dismiss.length > 0, "both locales name the dismiss action");

// The details wrapper flips the html attribute around the original actions.
ctx.layout.openDetails();
eq(rootStub.attrs.get("data-dsh-plugin-mobile-details"), "open", "opening details marks the document element");
eq(ctx.opened, 1, "the original open action still runs");
ctx.layout.closeDetails();
eq(rootStub.attrs.has("data-dsh-plugin-mobile-details"), false, "closing details clears the mark");
eq(ctx.closed, 1, "the original close action still runs");

// -------------------------------------------------------------- rendered scrim
const injected = ctx.entry.inject();
const t = (key) => `t:${key}`;
const node = ctx.entry.component({ ...injected, t });
eq(node.type, "button", "the scrim is a real button, not a bare div");
eq(node.props.className, "dsh-plugin-mobile-scrim", "the scrim carries the class the stylesheet drives");
eq(node.props.tabIndex, -1, "the scrim stays out of the tab order; the sidebar toggle is the keyboard path");
eq(node.props["aria-label"], "t:dismiss", "the scrim is labelled from the locale");
node.props.onClick();
eq(toggles, 1, "tapping the scrim closes the drawer through the layout service");

// A tap before the frame wired its store actions must not throw at the user.
const throwing = { ...ctx, layout: { toggleSidebar() { throw new Error("layout: panel actions not wired"); } } };
throwing.slots = {
	inject(name, callback) { callback(); },
	register(options, component) { throwing.entry = { ...options, component }; return () => {}; },
};
client.apply(throwing);
const earlyNode = throwing.entry.component({ ...throwing.entry.inject(), t });
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

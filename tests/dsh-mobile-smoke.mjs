// Smoke test for dsh-plugin-mobile: the client contract, the phone stylesheet,
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
globalThis.document = {
	head: { appendChild: (tag) => styleTags.push(tag) },
	createElement: () => ({ dataset: {}, textContent: "", remove() {} }),
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

const autoCollapse = /SIDEBAR_AUTO_COLLAPSE = (\d+)/.exec(layoutSrc);
ok(autoCollapse !== null, "host still defines its narrow-mode breakpoint");
const hostNarrow = Number(autoCollapse[1]);
eq(hostNarrow, 1024, "host auto-collapses the sidebar below 1024px");
ok(
	client.PHONE_MAX < hostNarrow,
	"the phone breakpoint is a strict subset of host narrow mode, so the drawer rules "
		+ "only ever see `data-sidebar-collapsed` tracking the narrow override",
);

// ------------------------------------------------------- stylesheet composition
const CSS = client.CSS;
ok(CSS.startsWith(`@media (max-width:${client.PHONE_MAX}px){`), "every rule is inside the phone media query");
eq(CSS.split("@media").length - 1, 1, "exactly one media query, so no rule can escape the phone scope");
eq((CSS.match(/\{/g) || []).length, (CSS.match(/\}/g) || []).length, "stylesheet braces balance");

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

// ---------------------------------------------------------- host anchor checks
const anchors = [
	['"data-shell-overlay"', layoutSrc, "the overlay outlet the frame selector depends on"],
	['"data-sidebar-collapsed"', layoutSrc, "the attribute the drawer state keys on"],
	['"data-side"', layoutSrc, "the drag-handle marker"],
	["gridTemplateColumns", layoutSrc, "the inline grid the !important overrides target"],
	['provide("layout"', layoutSrc, "the layout service the scrim dismisses through"],
	["toggleSidebar", layoutSrc, "the action the scrim calls"],
	['"data-conversation-scroll"', conversationSrc, "the transcript scrollport"],
];
for (const [needle, source, why] of anchors) {
	ok(source.includes(needle), `host still provides ${needle} - ${why}`);
}

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
	layout: { toggleSidebar() { toggles += 1; } },
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

console.log(fail === 0 ? `mobile ok (${pass} checks)` : `${fail} check(s) failed`);
process.exit(fail === 0 ? 0 : 1);

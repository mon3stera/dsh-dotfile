// Smoke test for dsh-plugin-session-id: the client contract, the header slot
// placement relative to the agent-preset label, the short-id derivation, and
// the copy path (which must carry the FULL id, not the displayed short form).
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
const host = await import("../plugins/dsh-plugin-session-id/lib/index.js");
eq(host.name, "dsh-plugin-session-id", "node entry exports the plugin name");
eq(typeof host.apply, "function", "node entry exports a no-op apply");
eq(host.apply(), undefined, "node apply does nothing");

// ------------------------------------------------------------------- manifest
const manifest = JSON.parse(
	readFileSync(new URL("../plugins/dsh-plugin-session-id/package.json", import.meta.url), "utf8"),
);
eq(manifest.name, "dsh-plugin-session-id", "manifest name");
eq(manifest.exports["./client"], "./lib/client.js", "manifest exposes the client half");
ok(
	manifest.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-conversation"),
	"manifest injects the conversation client package that owns the header slots",
);
eq(manifest.dsh.client.platform, "web", "client half targets web");

// ----------------------------------------------------------------- client half
const raw = readFileSync(new URL("../plugins/dsh-plugin-session-id/lib/client.js", import.meta.url), "utf8");
let captured;
globalThis.window = { __ModuleLoader__: { load: (entry) => { captured = entry; } } };
const styleTags = [];
const createdElements = [];
globalThis.document = {
	head: { appendChild: (tag) => styleTags.push(tag) },
	body: { appendChild: () => {} },
	createElement: () => {
		const element = {
			dataset: {},
			style: {},
			textContent: "",
			value: "",
			setAttribute() {},
			select() {},
			remove() {},
		};
		createdElements.push(element);
		return element;
	},
	execCommand: () => true,
};
vm.runInThisContext(raw, { filename: "dsh-plugin-session-id/lib/client.js" });
eq(captured?.id, "dsh-plugin-session-id", "client module id");

const timers = [];
globalThis.setTimeout = (callback) => {
	timers.push(callback);
	return timers.length;
};
globalThis.clearTimeout = () => {};

let stateValue = false;
const setState = (next) => { stateValue = next; };
const react = {
	useState: () => [stateValue, setState],
	useMemo: (factory) => factory(),
	useRef: (value) => ({ current: value }),
	useEffect: () => {},
};
const client = captured.factory((spec) => {
	if (spec === "react") return react;
	if (spec === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
	throw new Error(`unexpected require: ${spec}`);
});
eq(client.name, "dsh-plugin-session-id", "client plugin name");
eq(JSON.stringify(client.inject), JSON.stringify(["slots", "locale"]), "client inject contract");

// ------------------------------------------------------------ short-id shaping
eq(client.shortId("session-1e1d642b-162d-4c1f-9a3e-0d2b6f5a7c88"), "1e1d642b", "short id is the uuid head");
eq(client.shortId("session-short"), "short", "a short body is shown whole");
eq(client.shortId("plain-id"), "plain-id", "an id without the prefix is kept");
eq(client.shortId("session-"), "session-", "an empty body falls back to the raw id");
eq(client.shortId(""), "", "an empty id yields nothing to render");
eq(client.shortId(undefined), "", "a missing id yields nothing to render");

// --------------------------------------------------------------- registration
const ctx = {
	entry: null,
	slotName: null,
	locales: null,
	effects: 0,
	effect(callback) { ctx.effects += 1; callback(); },
	locale: { register: (_ns, dictionaries) => { ctx.locales = dictionaries; } },
	slots: {
		inject(name, callback) { ctx.slotName = name; callback(); },
		register(options, component) { ctx.entry = { ...options, component }; return () => {}; },
	},
};
client.apply(ctx);
eq(ctx.slotName, "conversation.session.header.actions", "registers on the session header actions slot");
eq(ctx.entry.name, "conversation.session.header.actions", "registers the same slot it injects");
eq(ctx.entry.id, "session-id", "stable slot entry id");
eq(ctx.entry.order, -9, "orders immediately after the agent-preset label at -10");
ok(ctx.entry.order > -10, "never displaces the preset label");
eq(ctx.entry.locale, "dsh-plugin-session-id", "slot entry carries the plugin locale namespace");
eq(styleTags.length, 1, "injects exactly one style tag");
eq(styleTags[0].dataset.plugin, "dsh-plugin-session-id", "style tag is attributed to the plugin");
ok(styleTags[0].textContent.includes("dsh-plugin-session-id-chip"), "style tag carries the chip class");
ok(ctx.locales.zh.hint.length > 0 && ctx.locales.en.hint.length > 0, "both locales define the hint");
ok(ctx.locales.zh.copied.length > 0 && ctx.locales.en.copied.length > 0, "both locales define the copied state");

// -------------------------------------------------------------- rendered chip
const SESSION = "session-1e1d642b-162d-4c1f-9a3e-0d2b6f5a7c88";
const injected = ctx.entry.inject(SESSION);
const t = (key) => `t:${key}`;
const node = ctx.entry.component({ sessionId: SESSION, ...injected, t });
eq(node.type, "button", "the chip is a button, so it is keyboard reachable");
eq(node.props.children, "1e1d642b", "the chip shows the short id");
ok(node.props.title.startsWith(SESSION), "the tooltip leads with the full id");
ok(node.props.title.includes("t:hint"), "the tooltip explains the click action");
eq(node.props["data-dsh-session-id"], SESSION, "the full id is available to inspection");
eq(node.props["aria-label"], SESSION, "the accessible name is the full id");
eq(node.props["data-copied"], "false", "the chip starts in the uncopied state");
eq(ctx.entry.component({ sessionId: "", ...injected, t }), null, "no session id renders nothing");

// --------------------------------------------------------------- copy behavior
let clipboardText = null;
// Node exposes `navigator` as a getter-only global, so it must be redefined.
const setNavigator = (value) => {
	Object.defineProperty(globalThis, "navigator", { value, configurable: true, writable: true });
};
setNavigator({ clipboard: { writeText: async (text) => { clipboardText = text; } } });
await injected.copy();
eq(clipboardText, SESSION, "copy places the FULL id on the clipboard, not the short form");

setNavigator({ clipboard: { writeText: async () => { throw new Error("denied"); } } });
const fallback = await injected.copy();
eq(fallback, true, "a refused clipboard falls back to the textarea path");
eq(createdElements[createdElements.length - 1].value, SESSION, "the fallback textarea carries the full id");

setNavigator({});
eq(await injected.copy(), true, "a missing clipboard API still copies");

// The click awaits the copy promise before announcing, so let microtasks drain.
node.props.onClick();
await new Promise((resolve) => setImmediate(resolve));
eq(timers.length >= 1, true, "clicking arms the copied-state reset timer");
eq(stateValue, true, "clicking flips the chip into its copied state");

console.log(fail === 0 ? "all session-id checks passed" : `${fail} check(s) failed`);
process.exit(fail === 0 ? 0 : 1);

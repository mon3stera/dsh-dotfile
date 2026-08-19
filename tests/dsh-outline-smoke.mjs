// Smoke test for the browser-only dsh-plugin-outline client.
import { readFileSync } from "node:fs";
import vm from "node:vm";

const pluginDir = new URL("../plugins/dsh-plugin-outline/", import.meta.url);
const raw = readFileSync(new URL("lib/client.js", pluginDir), "utf8");
let capturedEntry;
globalThis.window = { __ModuleLoader__: { load: (entry) => { capturedEntry = entry; } } };
const styleTags = [];
let scrollCalls = 0;
let nativeLoads = 0;
const nativeButton = { textContent: "加载更早", disabled: false, click() { nativeLoads += 1; } };
const anchor = {
	getAttribute(name) { return name === "data-chat-anchor-key" ? "user-1" : null; },
	scrollIntoView(options) { if (options?.behavior === "smooth" && options?.block === "start") scrollCalls += 1; },
};
globalThis.document = {
	head: { appendChild(tag) { styleTags.push(tag); } },
	createElement() { return { dataset: {}, textContent: "" }; },
	querySelectorAll(selector) {
		if (selector === "[data-chat-anchor-key]") return [anchor];
		if (selector === "button") return [nativeButton];
		return [];
	},
};
vm.runInThisContext(raw, { filename: "dsh-plugin-outline/lib/client.js" });

// The component calls useState twice per render: `open` first, then `activeKey`.
// Overriding a call's initial value by position lets one render exercise the
// collapsed default and another the expanded panel, with no real renderer.
let stateOverrides = [];
let stateCalls = 0;
const react = {
	useState(value) {
		const index = stateCalls;
		stateCalls += 1;
		return [stateOverrides[index] === undefined ? value : stateOverrides[index], () => {}];
	},
	useMemo(factory) { return factory(); },
	useRef(value) { return { current: value }; },
	useEffect() {},
};
const icon = (props) => ({ type: "icon", props });
const client = capturedEntry?.factory((spec) => {
	if (spec === "react") return react;
	if (spec === "react/jsx-runtime") return {
		jsx: (type, props, key) => ({ type, props, key }),
		jsxs: (type, props, key) => ({ type, props, key }),
	};
	if (spec === "@deepseek-ai/dsh-client-ui-primitives") return {
		IconListPenOutline16: icon,
		IconCloseOutline16: icon,
	};
	throw new Error(`unexpected require: ${spec}`);
});
if (!client || client.name !== "dsh-plugin-outline") throw new Error(`outline client failed to load: captured=${Boolean(capturedEntry)} id=${capturedEntry?.id} keys=${client ? Object.keys(client).join(",") : "none"}`);
if (JSON.stringify(client.inject) !== JSON.stringify(["slots", "locale"])) throw new Error("outline inject contract changed");
if (!raw.includes("binding(sessionId)") || !raw.includes("loadOlder()") || !raw.includes("snapshot.hasMore")) throw new Error("outline history loading contract missing");

const ctx = {
	effects: [],
	locales: null,
	entry: null,
	effect(callback) { this.effects.push(callback); return callback(); },
	locale: { register: (_namespace, dictionaries) => { ctx.locales = dictionaries; } },
	slots: {
		inject(name, callback) { ctx.slotName = name; callback(); },
		register(options, component) { ctx.entry = { ...options, component }; return () => {}; },
	},
};
client.apply(ctx);
if (ctx.slotName !== "conversation.session.header.utilities") throw new Error(`wrong slot: ${ctx.slotName}`);
if (!ctx.entry || ctx.entry.id !== "session-outline" || ctx.entry.order !== 80) throw new Error("outline header entry missing");
if (!ctx.locales?.zh?.title || !ctx.locales?.en?.title) throw new Error("outline locales missing");
if (styleTags.length !== 1 || !styleTags[0].textContent.includes(".dsh-outline-panel")) throw new Error("outline CSS missing");

const nodes = new Map([
	["user-1", { key: "user-1", kind: "user", anchorSeq: 11, data: { content: [{ type: "text", text: "First user question" }] } }],
	["assistant-1", { key: "assistant-1", kind: "assistant", anchorSeq: 12, data: {} }],
]);
const snapshot = { chat: { order: ["user-1", "assistant-1"], nodes: { get: (key) => nodes.get(key) } }, hasMore: true, loadingOlder: false };
let olderLoads = 0;
const render = (overrides) => {
	stateOverrides = overrides;
	stateCalls = 0;
	return ctx.entry.component({
		sessionId: "session-test",
		useSession: (selector) => selector(snapshot),
		loadOlder: async () => { olderLoads += 1; },
		t: (key) => ctx.locales.zh[key] ?? key,
	});
};
// Force `open` true so the panel contents below can be asserted.
const tree = render([true]);
const serialized = JSON.stringify(tree);
if (!serialized.includes("First user question") || !serialized.includes("会话目录")) throw new Error("outline did not render user message");
const find = (node, predicate) => {
	if (!node || typeof node !== "object") return null;
	if (predicate(node)) return node;
	const children = node.props?.children;
	if (Array.isArray(children)) for (const child of children) { const found = find(child, predicate); if (found) return found; }
	return find(children, predicate);
};
const loadButton = find(tree, (node) => node.type === "button" && node.props?.className === "dsh-outline-load");
if (!loadButton) throw new Error("outline load-older button missing");
if (olderLoads !== 0) throw new Error("outline loaded history while opening");
loadButton.props.onClick();
if (nativeLoads !== 1 || olderLoads !== 0) throw new Error(`outline native load-older click failed: native=${nativeLoads} fallback=${olderLoads}`);
const messageButton = find(tree, (node) => node.type === "button" && node.props?.className === "dsh-outline-item");
if (!messageButton) throw new Error("outline message button missing");
messageButton.props.onClick();
if (scrollCalls !== 1) throw new Error(`outline click did not scroll: ${scrollCalls}`);

// The panel must stay collapsed until the user asks for it: the component is
// session-scoped, so a default-open panel reopened on every session switch.
const closed = render([]);
const trigger = find(closed, (node) => node.type === "button" && node.props?.className === "dsh-outline-trigger");
if (!trigger) throw new Error("outline trigger missing while collapsed");
if (trigger.props["aria-expanded"] !== false) throw new Error("outline trigger should report collapsed by default");
if (find(closed, (node) => node.props?.className === "dsh-outline-panel")) throw new Error("outline panel must not open automatically");
if (JSON.stringify(closed).includes("会话目录") === false) throw new Error("collapsed trigger should still label the outline");
console.log("dsh-context outline smoke: OK");

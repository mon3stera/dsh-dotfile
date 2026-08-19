// Smoke test for the ContextMeter row injection in the dsh-magic-context client.
//
// The rows are placed by DOM injection because the host renders its context
// panel inline with no slot inside it. That makes the CSS-module class SUFFIX
// selectors and the clone-a-native-row contract the fragile part, so this test
// drives a fake panel through the real component effect instead of only
// asserting on source text.
import { readFileSync } from "node:fs";
import vm from "node:vm";

const pluginDir = new URL("../plugins/dsh-magic-context/", import.meta.url);
const raw = readFileSync(new URL("lib/client.js", pluginDir), "utf8");

let failures = 0;
function check(label, ok) {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
	if (!ok) failures += 1;
}

// --- minimal DOM ------------------------------------------------------------
// Supports only the selector shapes the plugin actually uses: tag names,
// [attr], [attr="value"], [class$="suffix"], and [class*="part"].
function parseSelector(selector) {
	const parts = selector.trim().match(/^([a-z]*)((?:\[[^\]]+\])*)$/i);
	if (parts === null) throw new Error(`unsupported selector: ${selector}`);
	const tag = parts[1] === "" ? undefined : parts[1].toLowerCase();
	const attrs = [];
	for (const raw of parts[2].matchAll(/\[([^\]=*$]+)(?:([*$]?=)"([^"]*)")?\]/g)) {
		attrs.push({ name: raw[1], op: raw[2], value: raw[3] });
	}
	return { tag, attrs };
}

class El {
	constructor(tag) {
		this.tagName = tag.toUpperCase();
		this.children = [];
		this.attributes = new Map();
		this.parentNode = null;
		this.textNode = "";
		this.title = "";
		this.dataset = {};
		this.style = {
			props: new Map(),
			setProperty(name, value) { this.props.set(name, value); },
			getPropertyValue(name) { return this.props.get(name) ?? ""; },
		};
	}
	get className() { return this.attributes.get("class") ?? ""; }
	set className(value) { this.attributes.set("class", value); }
	setAttribute(name, value) { this.attributes.set(name, String(value)); }
	getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
	hasAttribute(name) { return this.attributes.has(name); }
	appendChild(node) {
		node.parentNode = this;
		this.children.push(node);
		return node;
	}
	remove() {
		const siblings = this.parentNode?.children;
		if (siblings === undefined) return;
		const at = siblings.indexOf(this);
		if (at >= 0) siblings.splice(at, 1);
		this.parentNode = null;
	}
	get textContent() {
		if (this.children.length === 0) return this.textNode;
		return this.children.map((child) => child.textContent).join("");
	}
	set textContent(value) {
		for (const child of this.children) child.parentNode = null;
		this.children = [];
		this.textNode = String(value);
	}
	matches(selector) {
		const { tag, attrs } = parseSelector(selector);
		if (tag !== undefined && this.tagName.toLowerCase() !== tag) return false;
		return attrs.every(({ name, op, value }) => {
			const actual = this.getAttribute(name);
			if (actual === null) return false;
			if (op === undefined) return true;
			if (op === "=") return actual === value;
			if (op === "$=") return actual.endsWith(value);
			return actual.includes(value);
		});
	}
	descendants() {
		const out = [];
		const walk = (node) => {
			for (const child of node.children) {
				out.push(child);
				walk(child);
			}
		};
		walk(this);
		return out;
	}
	querySelector(selector) { return this.descendants().find((node) => node.matches(selector)) ?? null; }
	querySelectorAll(selector) { return this.descendants().filter((node) => node.matches(selector)); }
	cloneNode() {
		const copy = new El(this.tagName);
		copy.attributes = new Map(this.attributes);
		copy.textNode = this.textNode;
		copy.title = this.title;
		for (const [k, v] of this.style.props) copy.style.props.set(k, v);
		for (const child of this.children) copy.appendChild(child.cloneNode(true));
		return copy;
	}
}

class TextNode {
	constructor(text) { this.textNode = String(text); this.children = []; this.parentNode = null; }
	get textContent() { return this.textNode; }
	matches() { return false; }
	cloneNode() { return new TextNode(this.textNode); }
}

const body = new El("body");
globalThis.document = {
	body,
	head: { appendChild() {} },
	createElement: (tag) => new El(tag),
	createTextNode: (text) => new TextNode(text),
	querySelector: (selector) => body.querySelector(selector),
	querySelectorAll: (selector) => body.querySelectorAll(selector),
	addEventListener() {},
	removeEventListener() {},
};

/** Build a panel matching the host ContextMeter markup, with a fresh hash. */
function mountPanel(hash = "JObwrW") {
	const panel = new El("div");
	panel.className = `${hash}_panel`;
	panel.setAttribute("role", "dialog");
	const rows = new El("dl");
	rows.className = `${hash}_rows`;
	const natives = [
		["colorSystem", "系统提示词", "~2K"],
		["colorTools", "工具", "~7K"],
		["colorMessages", "对话消息", "~28.2K"],
	];
	for (const [color, label, value] of natives) {
		const row = new El("div");
		row.className = `${hash}_row`;
		const dt = new El("dt");
		const swatch = new El("span");
		swatch.className = `${hash}_swatch ${hash}_${color}`;
		swatch.setAttribute("aria-hidden", "true");
		dt.appendChild(swatch);
		dt.appendChild(new TextNode(label));
		const dd = new El("dd");
		dd.textContent = value;
		row.appendChild(dt);
		row.appendChild(dd);
		rows.appendChild(row);
	}
	panel.appendChild(rows);
	body.appendChild(panel);
	return { panel, rows };
}

// --- load the client module -------------------------------------------------
let captured;
globalThis.window = { __ModuleLoader__: { load: (entry) => { captured = entry; } } };

const observers = [];
globalThis.MutationObserver = class {
	constructor(callback) { this.callback = callback; observers.push(this); }
	observe() {}
	disconnect() { this.disconnected = true; }
};

const effects = [];
const react = {
	useState(value) { return [value, () => {}]; },
	useMemo(factory) { return factory(); },
	useRef(value) { return { current: value }; },
	useEffect(callback) { effects.push(callback); },
};

vm.runInThisContext(raw, { filename: "dsh-magic-context/lib/client.js" });
const client = captured?.factory((spec) => {
	if (spec === "react") return react;
	if (spec === "react/jsx-runtime") return { jsx: (type, props, key) => ({ type, props, key }) };
	if (spec === "@deepseek-ai/dsh-client-runtime/client") return { defineStore: (spec2) => spec2 };
	throw new Error(`unexpected require: ${spec}`);
});

check("client module loaded", client?.name === "dsh-magic-context");

// --- source contracts -------------------------------------------------------
check("uses the current magic-context usage route", raw.includes("/magic-context/usage?sessionId="));
check("no legacy /context/usage route", !raw.includes("`/context/usage") && !raw.includes('"/context/usage'));
check("selectors key on class suffixes, not fixed hashes", raw.includes('[class$="_panel"]') && raw.includes('dl[class$="_rows"]'));
check("does not hardcode an upstream css hash", !/JObwrW/.test(raw));

// --- slot registration ------------------------------------------------------
const registrations = [];
const ctx = {
	effect(callback) { const dispose = callback(); return dispose; },
	locale: {
		register: (namespace, dictionaries) => { ctx.dictionaries = dictionaries; },
		bind: () => (key) => key,
	},
	slots: {
		inject(name, callback) { callback(); },
		register(options, component) { registrations.push({ ...options, component }); return () => {}; },
	},
	get: () => undefined,
};
client.apply(ctx);

const meterSeat = registrations.find((entry) => entry.id === "context-meter-rows");
check("registers on the session-scoped composer slot", meterSeat?.name === "conversation.input.right");
check("meter seat receives sessionId from the slot", JSON.stringify(meterSeat?.inject("s-1")) === JSON.stringify({ sessionId: "s-1" }));
check("settings seat still registered", registrations.some((entry) => entry.id === "context-compact"));

for (const key of ["meterMemories", "meterMemoriesHint", "meterCompartments", "meterCompartmentsHint"]) {
	check(`locale key ${key} in zh and en`, typeof ctx.dictionaries?.zh?.[key] === "string" && typeof ctx.dictionaries?.en?.[key] === "string");
}
check("compartments label marks a sub-total", ctx.dictionaries.zh.meterCompartments.startsWith("\u21B3"));

// --- drive the injection ----------------------------------------------------
const usage = { ok: true, compartments: { count: 2, tokens: 12345 }, memories: { count: 40, tokens: 4096 } };
const fetched = [];
globalThis.fetch = async (url) => {
	fetched.push(url);
	return { ok: true, json: async () => usage };
};

const { rows } = mountPanel();
const labels = { meterMemories: "项目记忆", meterCompartments: "↳ Compartment", meterMemoriesHint: "hint-m", meterCompartmentsHint: "hint-c" };
effects.length = 0;
meterSeat.component({ t: (key) => labels[key] ?? key, sessionId: "s-1" });
check("effect registered for the meter seat", effects.length === 1);
const cleanup = effects[0]();
// The first tick has no usage yet, so it kicks off a load; await the microtask.
await new Promise((resolve) => setTimeout(resolve, 0));

check("polls the magic-context usage route", fetched.length === 1 && fetched[0] === "/magic-context/usage?sessionId=s-1");
const injected = rows.querySelectorAll('[data-dctx-meter-row]');
check("injects exactly two rows", injected.length === 2);
check("native rows untouched", rows.children.filter((row) => !row.hasAttribute("data-dctx-meter-row")).length === 3);

const compartments = rows.querySelector('[data-dctx-meter-row="compartments"]');
const memories = rows.querySelector('[data-dctx-meter-row="memories"]');
check("compartments row ordered directly after conversation messages", rows.children.indexOf(compartments) === 3);
check("memories row last", rows.children.indexOf(memories) === 4);
check("compartments label applied", compartments?.querySelector("dt")?.textContent === "↳ Compartment");
check("memories label applied", memories?.querySelector("dt")?.textContent === "项目记忆");
check("compartments value formatted like the host", compartments?.querySelector("dd")?.textContent === "~12.3K");
check("memories value formatted like the host", memories?.querySelector("dd")?.textContent === "~4.1K");
check("hints exposed as tooltips", compartments?.title === "hint-c" && memories?.title === "hint-m");
check("compartments row is indented as a sub-total", compartments?.style.paddingLeft === "28px");
check("memories row is not indented", !memories?.style.paddingLeft);
check(
	"compartments row drops its swatch (its tokens sit under the parent colour)",
	compartments?.querySelector('span[class*="_swatch"]') === null,
);
check("cloned swatch preserved", memories?.querySelector('span[class*="_swatch"]') !== null);
check("memories swatch gets its own tint", memories?.querySelector('span[class*="_swatch"]')?.style.getPropertyValue("--meter-tint") === "#34d399");

// Re-running the observer must not duplicate or drift.
observers[0].callback();
await new Promise((resolve) => setTimeout(resolve, 0));
check("re-tick is idempotent", rows.querySelectorAll('[data-dctx-meter-row]').length === 2);

// A rebuilt host bundle changes the hash prefix; suffix selectors must still work.
body.children.length = 0;
const rebuilt = mountPanel("Zx9Qa1");
observers[0].callback();
await new Promise((resolve) => setTimeout(resolve, 0));
check("survives an upstream css hash change", rebuilt.rows.querySelectorAll('[data-dctx-meter-row]').length === 2);

// Disposal must leave the host panel exactly as it was found.
cleanup();
check("cleanup removes injected rows", rebuilt.rows.querySelectorAll('[data-dctx-meter-row]').length === 0);
check("cleanup leaves native rows", rebuilt.rows.children.length === 3);
check("cleanup disconnects the observer", observers[0].disconnected === true);

if (failures > 0) {
	console.error(`dsh-context meter rows smoke: ${failures} FAILED`);
	process.exit(1);
}
console.log("dsh-context meter rows smoke: OK");

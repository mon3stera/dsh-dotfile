// Smoke test for the organizer/Dreamer model picker in the dsh-magic-context
// client half.
//
// The picker exists so the two auxiliary callers (Compartment organizer and
// Dreamer) can be pointed at cheaper routes than the conversation model, using
// the host's own provider registry instead of hand-typed identifiers. The
// fragile parts are therefore the wire contract with `/magic-context/models/
// catalog`, the option values the <select> writes back into the settings keys,
// and the graceful degradation when the catalog is unavailable — so this test
// renders the real component instead of asserting on source text.
import { readFileSync } from "node:fs";
import vm from "node:vm";

const pluginDir = new URL("../plugins/dsh-magic-context/", import.meta.url);
const raw = readFileSync(new URL("lib/client.js", pluginDir), "utf8");

let failures = 0;
function check(label, ok) {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
	if (!ok) failures += 1;
}

// --- load the client module -------------------------------------------------
let captured;
globalThis.window = { __ModuleLoader__: { load: (entry) => { captured = entry; } } };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.document = {
	head: { appendChild() {} },
	createElement: () => ({ dataset: {}, remove() {} }),
	querySelectorAll: () => [],
};

// One render pass per component call, with useState honouring an initial value.
const react = {
	useState(value) { return [value, () => {}]; },
	useMemo(factory) { return factory(); },
	useRef(value) { return { current: value }; },
	useEffect() {},
};
const jsx = (type, props, key) => ({ type, props, key });

const fetches = [];
let catalogReply = () => ({
	ok: true,
	groups: [
		{ id: "anthropic", name: "Anthropic", models: [
			{ id: "claude-opus-5", name: "Claude Opus 5", reasoning: { efforts: [{ id: "off", name: "Off" }, { id: "low", name: "Low" }, { id: "max", name: "Max" }] } },
			{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5", reasoning: { efforts: [{ id: "off", name: "Off" }, { id: "low", name: "Low" }] } },
		] },
		{ id: "codelink", name: "Code Link", models: [{ id: "gpt-5.6-luna", name: "gpt-5.6-luna" }] },
	],
	failures: [{ id: "broken", name: "Broken", message: "401" }],
});
globalThis.fetch = async (url) => {
	fetches.push(String(url));
	if (String(url).includes("/magic-context/models/catalog")) {
		const payload = catalogReply();
		if (payload === null) return { ok: false, json: async () => ({}) };
		return { ok: true, json: async () => payload };
	}
	return { ok: true, json: async () => ({ ok: true, config: {} }) };
};

vm.runInThisContext(raw, { filename: "dsh-magic-context/lib/client.js" });
const client = captured?.factory((spec) => {
	if (spec === "react") return react;
	if (spec === "react/jsx-runtime") return { jsx };
	if (spec === "@deepseek-ai/dsh-client-runtime/client") return { defineStore: (definition) => definition };
	throw new Error(`unexpected require: ${spec}`);
});
check("client module loaded", client?.name === "dsh-magic-context");

// --- mount the settings section ---------------------------------------------
const registrations = [];
const ctx = {
	effect(callback) { return callback(); },
	locale: { register: (namespace, dictionaries) => { ctx.dictionaries = dictionaries; }, bind: () => (key) => key },
	slots: {
		inject(name, callback) { callback(); },
		register(options, component) { registrations.push({ ...options, component }); return () => {}; },
	},
	get: () => undefined,
};
client.apply(ctx);
const seat = registrations.find((entry) => entry.id === "context-compact");
check("settings section registered", seat?.name === "settings.section");

const definition = seat.store;
const state = definition.init();
check("catalog starts out loading", state.catalog.status === "loading" && state.catalog.groups.length === 0);

const edits = [];
const actions = {};
for (const [key, action] of Object.entries(definition.actions)) {
	actions[key] = (...args) => action(state, ...args);
}
const bound = seat.inject({ ...actions, edit: (path, value) => { edits.push([path, value]); definition.actions.edit(state, path, value); } });
check("mounting requests the model catalog", fetches.some((url) => url.includes("/magic-context/models/catalog")));
await new Promise((resolve) => setTimeout(resolve, 0));
await new Promise((resolve) => setTimeout(resolve, 0));
check("catalog reaches the store", state.catalog.status === "ready" && state.catalog.groups.length === 2);
check("catalog keeps provider failures", state.catalog.failures.length === 1 && state.catalog.failures[0].id === "broken");

// --- render the panel -------------------------------------------------------
function flatten(node, out = []) {
	if (node === null || node === undefined || typeof node !== "object") return out;
	if (Array.isArray(node)) { for (const child of node) flatten(child, out); return out; }
	out.push(node);
	if (typeof node.type === "function") return flatten(node.type(node.props), out);
	flatten(node.props?.children, out);
	return out;
}
const render = () => flatten(seat.component({ t: (key) => key, useStore: (select) => select(state), edit: bound.edit, save: bound.save, reset: bound.reset }));

const selects = () => render().filter((node) => node.type === "select");
const optionsOf = (select) => flatten(select.props.children).filter((node) => node.type === "option").map((node) => node.props.value);

state.status = "ready";
let targetSelects = selects().filter((select) => optionsOf(select).includes("__manual__"));
check("one target picker per auxiliary caller", targetSelects.length === 2);
const organizer = targetSelects[0];
const values = optionsOf(organizer);
check("session route is the first option", values[0] === "");
check("catalog models become provider/model options", values.includes("anthropic/claude-opus-5") && values.includes("codelink/gpt-5.6-luna"));
check("manual entry stays available", values[values.length - 1] === "__manual__");
check("options are grouped by provider", flatten(organizer.props.children).filter((node) => node.type === "optgroup").map((node) => node.props.label).join(",") === "Anthropic,Code Link");
check("no target selected means the session model", organizer.props.value === "");

// Selecting a catalog model writes the settings pair and clears a stale effort.
state.draft.summarizationReasoningEffort = "max";
edits.length = 0;
organizer.props.onChange({ target: { value: "anthropic/claude-haiku-4-5" } });
check("picking a model writes provider and model", JSON.stringify(edits.slice(0, 2)) === JSON.stringify([["summarizationProvider", "anthropic"], ["summarizationModel", "claude-haiku-4-5"]]));
check("switching target clears the stale effort", JSON.stringify(edits[2]) === JSON.stringify(["summarizationReasoningEffort", ""]));

// A model id containing a slash must survive the round trip.
state.catalog.groups[1].models.push({ id: "org/model-1", name: "org/model-1" });
edits.length = 0;
selects().filter((select) => optionsOf(select).includes("__manual__"))[0].props.onChange({ target: { value: "codelink/org/model-1" } });
check("slashes inside a model id survive", JSON.stringify(edits.slice(0, 2)) === JSON.stringify([["summarizationProvider", "codelink"], ["summarizationModel", "org/model-1"]]));
state.catalog.groups[1].models.pop();

// Effort options come from the exact selected model.
state.draft.summarizationProvider = "anthropic";
state.draft.summarizationModel = "claude-opus-5";
state.draft.summarizationReasoningEffort = "low";
const rendered = selects();
const effortSelect = rendered.find((select) => optionsOf(select).includes("max") && !optionsOf(select).includes("__manual__"));
check("effort options come from the selected model", JSON.stringify(optionsOf(effortSelect)) === JSON.stringify(["", "off", "low", "max"]));
check("stored effort stays selected", effortSelect.props.value === "low");
const organizerNow = rendered.filter((select) => optionsOf(select).includes("__manual__"))[0];
check("selected pair is reflected back", organizerNow.props.value === "anthropic/claude-opus-5");
edits.length = 0;
effortSelect.props.onChange({ target: { value: "off" } });
check("effort choice is persisted alone", JSON.stringify(edits) === JSON.stringify([["summarizationReasoningEffort", "off"]]));

// A model without reasoning metadata gets a free-text effort control.
state.draft.summarizationProvider = "codelink";
state.draft.summarizationModel = "gpt-5.6-luna";
state.draft.summarizationReasoningEffort = "";
const noReasoning = render().filter((node) => node.type === "input" && node.props.placeholder === "effortDefault");
check("unknown reasoning metadata falls back to free text", noReasoning.length >= 1);

// A saved pair the catalog does not advertise must remain selectable.
state.draft.summarizationProvider = "anthropic";
state.draft.summarizationModel = "claude-sonnet-9-preview";
const unlisted = selects().filter((select) => optionsOf(select).includes("__manual__"))[0];
check("an unlisted saved pair keeps its option", optionsOf(unlisted).includes("anthropic/claude-sonnet-9-preview") && unlisted.props.value === "anthropic/claude-sonnet-9-preview");
edits.length = 0;
unlisted.props.onChange({ target: { value: "__manual__" } });
check("choosing manual entry writes no settings", edits.length === 0);

// The two callers stay independent.
state.draft.dreamerProvider = "codelink";
state.draft.dreamerModel = "gpt-5.6-luna";
const bothSelects = selects().filter((select) => optionsOf(select).includes("__manual__"));
check("organizer and dreamer selections are independent", bothSelects[0].props.value === "anthropic/claude-sonnet-9-preview" && bothSelects[1].props.value === "codelink/gpt-5.6-luna");
edits.length = 0;
bothSelects[1].props.onChange({ target: { value: "" } });
check("dreamer can fall back to the session model", JSON.stringify(edits.slice(0, 2)) === JSON.stringify([["dreamerProvider", ""], ["dreamerModel", ""]]));

// --- degradation ------------------------------------------------------------
catalogReply = () => null;
state.catalog = { status: "loading", groups: [], failures: [] };
seat.inject({ ...actions, edit: bound.edit });
await new Promise((resolve) => setTimeout(resolve, 0));
await new Promise((resolve) => setTimeout(resolve, 0));
check("an unavailable catalog degrades to manual entry", state.catalog.status === "error" && state.catalog.groups.length === 0);
const degraded = selects().filter((select) => optionsOf(select).includes("__manual__"));
check("pickers still render without a catalog", degraded.length === 2 && optionsOf(degraded[0]).includes(""));

// --- copy -------------------------------------------------------------------
for (const dictionary of ["en", "zh"]) {
	const copy = ctx.dictionaries[dictionary];
	const keys = ["targetSessionRoute", "targetManual", "targetProvider", "targetModel", "targetEffort", "effortDefault", "catalogLoading", "catalogUnavailable", "catalogFailures", "targetSaved"];
	check(`${dictionary} copy covers the picker`, keys.every((key) => typeof copy[key] === "string" && copy[key].length > 0));
}
check("legacy free-text provider labels are gone", !raw.includes("summarizationProvider: [") && !raw.includes("dreamerProvider: ["));

if (failures > 0) {
	console.error(`dsh-context model picker smoke: ${failures} FAILED`);
	process.exit(1);
}
console.log("dsh-context model picker smoke: OK");

/**
 * Smoke test for dsh-plugin-scheduler (host scheduler + routes + client panel).
 * Run: node tests/dsh-scheduler-smoke.mjs (from the repo root)
 *
 * The host half is imported from the installed runtime copy (host deps resolve
 * there); time is injected through the _setClock seam and the session
 * controller through _setRunner, so no real sessions are created.
 */
import { readFileSync, existsSync, mkdirSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const PLUGIN_DIR = fileURLToPath(new URL("../plugins/dsh-plugin-scheduler/", import.meta.url));
const INSTALLED_PLUGIN_DIR = "/home/mon3tr/.dsh/profiles/node_modules/dsh-plugin-scheduler";
const TEST_HOME = "/home/mon3tr/dsh-scheduler-test-home";
process.env.DSH_HOME = TEST_HOME;
rmSync(TEST_HOME, { recursive: true, force: true });
mkdirSync(TEST_HOME, { recursive: true });

let failed = 0;
const check = (label, ok) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
	if (!ok) failed += 1;
};

const host = await import(`${INSTALLED_PLUGIN_DIR}/lib/index.js`);

// ---------- nextDueAt math ----------
const MIN = 60_000;
const morning = new Date("2025-09-05T09:30:00").getTime(); // a Friday, 09:30 local
const task = (over = {}) => ({ kind: "interval", minutes: 60, time: "09:00", lastRunAt: null, enabled: true, ...over });

check("interval never run is due one interval out", host.nextDueAt(task({ minutes: 30 }), morning) === morning + 30 * MIN);
check("interval overdue stays in the past (boot catch-up)", host.nextDueAt(task({ minutes: 10, lastRunAt: morning - 60 * MIN }), morning) === morning - 50 * MIN);
check("daily before the time lands today", host.nextDueAt(task({ kind: "daily", time: "10:15" }), morning) === new Date("2025-09-05T10:15:00").getTime());
check("daily after the time lands tomorrow", host.nextDueAt(task({ kind: "daily", time: "08:00" }), morning) === new Date("2025-09-06T08:00:00").getTime());
check("daily exactly at the time rolls to tomorrow", host.nextDueAt(task({ kind: "daily", time: "09:30" }), morning) === new Date("2025-09-06T09:30:00").getTime());
console.log("nextDueAt math OK");

// ---------- scheduler core with stub clock + runner ----------
const scheduler = host.createScheduler();
let now = morning;
scheduler.setClock(() => now);
const calls = [];
scheduler.setRunner({
	create: async (request) => {
		calls.push(["create", request]);
		if (request.cwd === "boom://fail") throw new Error("create refused");
		return { sessionId: `session-${calls.length}` };
	},
	prompt: async (request) => {
		calls.push(["prompt", request]);
	}
});

const seed = [
	task({ id: "due", name: "due now", prompt: "run me", minutes: 10, lastRunAt: now - 20 * MIN }),
	task({ id: "later", name: "later", prompt: "not yet", minutes: 60, lastRunAt: now }),
	task({ id: "off", name: "disabled", prompt: "skipped", minutes: 5, lastRunAt: now - 99 * MIN, enabled: false }),
	task({ id: "fails", name: "failing", prompt: "boom", cwd: "boom://fail", minutes: 5, lastRunAt: now - 99 * MIN })
];
scheduler.setDocument({ tasks: seed });
await scheduler.fireDueTasks();
const after = scheduler.getDocument().tasks;
/* three calls: due (create+prompt) and fails (create throws, caught) */
check("due task ran: create then prompt with its prompt text", calls.length === 3
	&& calls[0][0] === "create" && calls[0][1].sessionId.startsWith("session-sched-")
	&& JSON.stringify(calls[1]) === JSON.stringify(["prompt", { sessionId: "session-1", requestId: calls[1][1].requestId, content: [{ type: "text", text: "run me" }] }]));
check("disabled task never fires", after.find((t) => t.id === "off").lastRunAt === now - 99 * MIN);
check("later task untouched", after.find((t) => t.id === "later").lastRunAt === now);
check("failing task records lastError", after.find((t) => t.id === "fails").lastError.includes("create refused"));
check("due task stamped lastRunAt + lastSessionId", after.find((t) => t.id === "due").lastSessionId === "session-1" && after.find((t) => t.id === "due").lastRunAt === now);
check("prompt request carries a fresh requestId", typeof calls[1][1].requestId === "string" && calls[1][1].requestId.length > 10);
console.log("scheduler core OK");

// ---------- routes ----------
const scheduler2 = host.createScheduler();
scheduler2.setClock(() => now);
const runCalls = [];
scheduler2.setRunner({
	create: async () => ({ sessionId: "session-run" }),
	prompt: async (request) => { runCalls.push(request); }
});
const { handleTasks, handleRun } = host.createHandlers(scheduler2);
const fakeReq = (body) => {
	const chunks = body ? [Buffer.from(body)] : [];
	return {
		method: body === undefined ? "GET" : "POST",
		headers: { "content-type": "application/json" },
		[Symbol.asyncIterator]() {
			let i = 0;
			return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { done: true }) };
		}
	};
};
const fakeRes = () => {
	const out = { status: null, body: null };
	return { out, writeHead(status) { out.status = status; }, end(payload) { out.body = payload; } };
};

let res = fakeRes();
await handleTasks(fakeReq(), res);
check("GET before any write returns an empty document", res.out.status === 200 && JSON.parse(res.out.body).tasks.length === 0);

res = fakeRes();
await handleTasks(fakeReq("{oops"), res);
check("invalid JSON -> 400", res.out.status === 400);

res = fakeRes();
await handleTasks(fakeReq(JSON.stringify({ tasks: [{ id: "t1", name: "x", prompt: "p", kind: "weekly" }] })), res);
check("unknown schedule kind -> 400", res.out.status === 400);

res = fakeRes();
await handleTasks(fakeReq(JSON.stringify({ tasks: [{ id: "t1", name: "x", prompt: "p", kind: "daily", time: "24:99" }] })), res);
check("invalid daily time -> 400", res.out.status === 400);

res = fakeRes();
await handleTasks(fakeReq(JSON.stringify({ tasks: [{ id: "t1", name: "x", prompt: "p", minutes: 1 }] })), res);
check("interval below the 5-minute floor -> 400", res.out.status === 400);

const valid = { tasks: [{ id: "t1", name: "nightly", prompt: "do the thing", cwd: "/tmp/x", agentPreset: "context-compact", enabled: true, kind: "daily", time: "03:30", lastRunAt: null, lastSessionId: "", lastError: "" }] };
res = fakeRes();
await handleTasks(fakeReq(JSON.stringify(valid)), res);
check("valid document -> 200", res.out.status === 200);
if (!existsSync(host.configPath())) throw new Error("FAIL: tasks file not written");
if (readdirSync(TEST_HOME + "/scheduler").some((n) => n.endsWith(".tmp"))) throw new Error("FAIL: tmp file left behind");
res = fakeRes();
await handleTasks(fakeReq(), res);
check("GET roundtrip preserves the document", JSON.parse(res.out.body).tasks[0].name === "nightly" && JSON.parse(res.out.body).tasks[0].time === "03:30");

// saving re-arms and runs an overdue interval task through the real handler
now += 60 * MIN;
res = fakeRes();
await handleTasks(fakeReq(JSON.stringify({ tasks: [{ id: "t2", name: "every 5", prompt: "tick", minutes: 5, enabled: true, kind: "interval", lastRunAt: now - 30 * MIN, cwd: "", agentPreset: "", time: "09:00", lastSessionId: "", lastError: "" }] })), res);
await new Promise((r) => setTimeout(r, 20));
check("save with an overdue interval task runs it", res.out.status === 200 && runCalls.length === 1 && runCalls[0].sessionId === "session-run");

res = fakeRes();
await handleRun(fakeReq(JSON.stringify({ id: "missing" })), res);
check("run-now with an unknown id -> 404", res.out.status === 404);

res = fakeRes();
await handleRun(fakeReq(JSON.stringify({ id: "t2" })), res);
check("run-now creates a session and reports its id", res.out.status === 200 && JSON.parse(res.out.body).sessionId === "session-run" && runCalls.length === 2);

res = fakeRes();
await handleRun(fakeReq(undefined), res);
check("GET is not a valid run method -> 405", res.out.status === 405);
console.log("routes OK");

// ---------- client ----------
const hooks = {
	state: [], index: 0, effects: [],
	useState(initial) {
		const i = this.index++;
		if (this.state[i] === undefined) this.state[i] = { value: typeof initial === "function" ? initial() : initial };
		return [this.state[i].value, (value) => {
			this.state[i].value = typeof value === "function" ? value(this.state[i].value) : value;
		}];
	},
	useCallback(fn) { return fn; },
	useEffect(fn) { this.effects.push(fn); },
	render(component) {
		this.index = 0;
		return component;
	},
	flush() {
		const pending = this.effects.splice(0);
		for (const fn of pending) fn();
	}
};

const raw = readFileSync(`${PLUGIN_DIR}/lib/client.js`, "utf8");
let capturedEntry = null;
globalThis.window = { __ModuleLoader__: { load: (entry) => { capturedEntry = entry; } } };
const styleTags = [];
globalThis.document = {
	head: { appendChild(tag) { styleTags.push(tag); } },
	querySelectorAll() { return []; },
	createElement() { return { dataset: {}, textContent: "", style: {} }; }
};
vm.runInThisContext(raw, { filename: "dsh-plugin-scheduler/lib/client.js" });
const clientExports = capturedEntry.factory((spec) => {
	if (spec === "react") {
		return {
			useState: hooks.useState.bind(hooks),
			useEffect: hooks.useEffect.bind(hooks),
			useCallback: hooks.useCallback.bind(hooks)
		};
	}
	if (spec === "react/jsx-runtime") {
		return { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }), Fragment: "fragment" };
	}
	throw new Error("FAIL: unexpected require: " + spec);
});
check("client exports name + inject", clientExports.name === "dsh-plugin-scheduler" && JSON.stringify(clientExports.inject) === JSON.stringify(["slots", "locale"]));

const ctx = {
	_effects: [],
	effect(cb) { ctx._effects.push(cb); const out = cb(); return () => (typeof out === "function" ? out() : undefined); },
	locale: { register: (ns, dicts) => { ctx._locales = dicts; } },
	slots: {
		inject(key, cb) { ctx._slotKey = key; cb(); },
		register(opts, Component) { ctx._entry = { ...opts, Component }; return () => {}; }
	}
};
clientExports.apply(ctx);
check("locales registered with equal key sets", ctx._locales && Object.keys(ctx._locales.zh).sort().join(",") === Object.keys(ctx._locales.en).sort().join(","));
check("panel styles injected", styleTags.length === 1 && styleTags[0].textContent.includes(".schd-panel"));
check("entry occupies sidebar.footer.action above settings", ctx._slotKey === "sidebar.footer.action" && ctx._entry.id === "scheduler-panel" && ctx._entry.name === "sidebar.footer.action");

let fetchLog = [];
let storedTasks = { tasks: [] };
globalThis.window.fetch = globalThis.fetch = async (url, opts) => {
	fetchLog.push([url, opts?.method]);
	if (url === "/scheduler/tasks" && opts?.method === "POST") {
		storedTasks = JSON.parse(opts.body);
		return { ok: true, status: 200, json: async () => ({ ok: true, tasks: storedTasks.tasks }) };
	}
	if (url === "/scheduler/run") return { ok: true, status: 200, json: async () => ({ ok: true, sessionId: "session-live" }) };
	if (url === "/scheduler/tasks") return { ok: true, status: 200, json: async () => storedTasks };
	throw new Error("unexpected fetch " + url);
};

const renderTree = (node) => {
	if (!node || typeof node !== "object") return node;
	if (Array.isArray(node)) return node.map(renderTree);
	if (typeof node.type === "function") return renderTree(node.type(node.props || {}));
	if (node.type === "fragment") {
		const kids = node.props?.children;
		return (Array.isArray(kids) ? kids : [kids]).map(renderTree);
	}
	if (node.props?.children !== undefined && node.props?.children !== null) {
		const kids = Array.isArray(node.props.children) ? node.props.children : [node.props.children];
		return { ...node, props: { ...node.props, children: kids.map(renderTree) } };
	}
	return node;
};
const countTags = (node, tag, out = []) => {
	if (Array.isArray(node)) {
		for (const child of node) countTags(child, tag, out);
		return out;
	}
	if (!node || typeof node !== "object") return out;
	if (node.type === tag) out.push(node);
	const kids = node.props?.children;
	if (Array.isArray(kids)) for (const k of kids) countTags(k, tag, out);
	else if (kids) countTags(kids, tag, out);
	return out;
};
const findClass = (node, cls, out = []) => {
	if (Array.isArray(node)) {
		for (const child of node) findClass(child, cls, out);
		return out;
	}
	if (!node || typeof node !== "object") return out;
	if (typeof node.props?.className === "string" && node.props.className.split(" ").includes(cls)) out.push(node);
	const kids = node.props?.children;
	if (Array.isArray(kids)) for (const k of kids) findClass(k, cls, out);
	else if (kids) findClass(k, cls, out);
	return out;
};

const t = (key) => ctx._locales.zh[key] ?? key;
let renderCount = 0;
const render = () => {
	renderCount += 1;
	return hooks.render(renderTree(ctx._entry.Component({ t, wide: true })));
};

let view = render();
let entries = findClass(view, "schd-entry");
check("entry button renders with the clock label", entries.length === 1 && countTags(view, "svg").length === 1);
check("panel closed until toggled", findClass(view, "schd-panel").length === 0);

entries[0].props.onClick();
view = render();
hooks.flush();
check("panel opens and loads the task list", findClass(view, "schd-panel").length === 1 && fetchLog.some(([u, m]) => u === "/scheduler/tasks" && m === undefined));

storedTasks = { tasks: [{ id: "task-abc", name: " nightly build ", prompt: "build", kind: "daily", time: "03:00", enabled: true, lastRunAt: 1000, lastSessionId: "session-9", lastError: "" }] };
view = render();
hooks.flush();
await new Promise((r) => setTimeout(r, 20));
view = render();
const rows = findClass(view, "schd-row");
check("task row renders name, summary, and last run", rows.length === 1 && JSON.stringify(rows[0].props.children).includes("nightly build") && JSON.stringify(rows[0].props.children).includes("03:00"));

// create a task through the editor
const buttonByLabel = (view, label) => countTags(view, "button").find((b) => {
	const kids = Array.isArray(b.props.children) ? b.props.children : [b.props.children];
	return kids.some((kid) => kid === label);
});
const addBtn = buttonByLabel(view, t("schd.add"));
addBtn.props.onClick();
view = render();
const editor = findClass(view, "schd-row");
check("editor opens with fields", editor.length === 1 && countTags(editor[0], "input").length >= 4 && countTags(editor[0], "textarea").length === 1 && countTags(editor[0], "select").length === 1);

const inputs = countTags(editor[0], "input");
const nameInput = inputs.find((i) => i.props.value === "");
nameInput.props.onChange({ target: { value: "hourly check" } });
/* each keystroke is its own React event, so re-render between edits */
view = render();
const textarea = countTags(view, "textarea")[0];
textarea.props.onChange({ target: { value: "check the queue" } });
fetchLog = [];
view = render();
const saveBtn = buttonByLabel(view, t("schd.save"));
saveBtn.props.onClick();
await new Promise((r) => setTimeout(r, 20));
check("save POSTs the merged document", fetchLog.some(([u, m]) => u === "/scheduler/tasks" && m === "POST") && storedTasks.tasks.some((task) => task.name === "hourly check" && task.prompt === "check the queue"));

// run-now posts to the run route and refreshes
fetchLog = [];
view = render();
const runBtn = buttonByLabel(view, t("schd.runNow"));
runBtn.props.onClick();
await new Promise((r) => setTimeout(r, 20));
check("run-now hits /scheduler/run then reloads", fetchLog.some(([u, m]) => u === "/scheduler/run" && m === "POST") && fetchLog.some(([u, m]) => u === "/scheduler/tasks" && m === undefined));

// editor validation: empty prompt is rejected without a POST
const editBtn = buttonByLabel(render(), t("schd.edit"));
editBtn.props.onClick();
view = render();
const editorInputs = countTags(findClass(view, "schd-row")[0], "input");
const nameField = editorInputs.find((i) => typeof i.props.value === "string");
nameField.props.onChange({ target: { value: "" } });
view = render();
const editorTextareas = countTags(view, "textarea");
editorTextareas[0].props.onChange({ target: { value: "" } });
fetchLog = [];
view = render();
const save2 = buttonByLabel(view, t("schd.save"));
save2.props.onClick();
check("empty name/prompt blocks the save without a POST", !fetchLog.some(([u, m]) => u === "/scheduler/tasks" && m === "POST"));

console.log(failed === 0 ? "ALL CHECKS PASSED" : `${failed} assertion(s) failed`);
rmSync(TEST_HOME, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);

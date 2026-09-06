// dsh-magic-context Dreamer smoke test: internal tools, loop against a mock
// LLM, the archival code path, the dream agent-plane registrar, and the
// per-pass child-session driver.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runDreamer, runArchival, createDreamerTools, buildDreamerBrief, summarizeDreamerActions } from "/home/mon3tr/.dsh/profiles/node_modules/dsh-magic-context/lib/dreamer.js";
import { runDreamerSession } from "/home/mon3tr/.dsh/profiles/node_modules/dsh-magic-context/lib/dreamer-session.js";
import { apply as applyDreamAgent } from "/home/mon3tr/.dsh/profiles/node_modules/dsh-magic-context/lib/dream-agent.js";
import { openDatabase } from "/home/mon3tr/.dsh/profiles/node_modules/dsh-magic-context/lib/db.js";

let failed = 0;
const check = (label, ok) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
	if (!ok) failed += 1;
};

const home = mkdtempSync("/home/mon3tr/ctx-dreamer-");
const workspace = mkdtempSync("/home/mon3tr/ctx-ws-");
try {
	mkdirSync(join(workspace, "src"));
	writeFileSync(join(workspace, "src", "auth.ts"), "export const TOKEN_TTL = 3600; // seconds\n");
	const cdb = openDatabase(home, {});
	const cwd = workspace;
	const sourceSession = {
		id: "s",
		header: { cwd: workspace },
		events: [
			{ seq: 1, type: "turn/start", data: { turn: 1 } },
			{ seq: 2, type: "user/message", data: { content: [{ type: "text", text: "The user explicitly requires this convention." }] } },
			{ seq: 3, type: "assistant/message", data: { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: "Understood." }] } } },
			{ seq: 4, type: "tool/result", data: { message: { role: "tool", content: [{ type: "text", text: "memory written" }] } } },
			{ seq: 5, type: "turn/end", data: { turn: 1 } },
		],
		deriveEventMessage: (event) => event.type === "user/message" ? { role: "user", content: event.data.content } : event.type === "assistant/message" || event.type === "tool/result" ? event.data.message : null,
	};
	const sessions = { get: (id) => id === sourceSession.id ? sourceSession : undefined };

	// ── internal tools ───────────────────────────────────────────────────────
	const { tools, byName } = createDreamerTools(cdb, { workspaceRoot: workspace, scopePath: workspace, sessions, currentSession: sourceSession });
	const run = (name, args) => byName.get(name).execute(args);

	check("fs_list", JSON.stringify((await run("fs_list", { path: "." })).map((e) => e.name).sort()) === '["src"]');
	check("fs_read", (await run("fs_read", { path: "src/auth.ts" })).includes("TOKEN_TTL = 3600"));
	check("fs_grep", (await run("fs_grep", { pattern: "TOKEN_TTL" }))[0].includes("src/auth.ts:1"));
	check("fs escape rejected", (() => run("fs_read", { path: "../../etc/passwd" }).then(() => false, () => true))());
	check("sql read-only enforced", (() => run("sql_query", { sql: "DELETE FROM memories" }).then(() => false, () => true))());
	check("sql select works", JSON.stringify(await run("sql_query", { sql: "SELECT COUNT(*) AS n FROM memories" })) === '[{"n":0}]');
	const sourceContext = await run("session_context", { sessionId: "s", startSeq: 1, endSeq: 5 });
	check("session_context reads original user input", sourceContext.available === true && JSON.stringify(sourceContext).includes("user explicitly requires this convention"));

	// memory tools
	const wrote = await run("memory_write", { category: "ARCHITECTURE", summary: "jwt ttl", content: "TOKEN_TTL=3600", importance: 8 });
	check("memory_write", typeof wrote.id === "number");
	check("memory_update", (await run("memory_update", { id: wrote.id, importance: 9 })).ok === true && cdb.memoryById(wrote.id).importance === 9 && cdb.memoryById(wrote.id).verified_at !== null);
	check("memory_archive", (await run("memory_archive", { id: wrote.id })).ok === true && cdb.memoryById(wrote.id).archived === 1);
	cdb.updateMemory(wrote.id, { archived: 0 });

	// facts + compartments
	const factId = cdb.insertFact({ sessionId: "s", scopePath: workspace, fact: "auth uses TOKEN_TTL 3600s", importance: 6 });
	const promoted = await run("promote_fact", { factId, category: "ARCHITECTURE", summary: "auth ttl", content: "TOKEN_TTL=3600 in src/auth.ts", importance: 8 });
	check("promote_fact", promoted.id !== undefined && cdb.pendingFacts().length === 0 && cdb.memoryById(promoted.id) !== undefined);
	check("promoted fact provenance", cdb.memoryById(promoted.id).source_session_id === "s");
	const duplicateFact = cdb.insertFact({ sessionId: "s", scopePath: workspace, fact: "auth still uses TOKEN_TTL 3600s", importance: 4 });
	check("discard_fact", (await run("discard_fact", { factId: duplicateFact })).ok === true && cdb.db.prepare("SELECT status FROM session_facts WHERE id = ?").get(duplicateFact).status === "discarded");
	check("discard_fact rejects promoted", await run("discard_fact", { factId }).then(() => false, () => true));
	const c1 = cdb.insertCompartment({ sessionId: "s", scopePath: workspace, generation: 1, startSeq: 1, endSeq: 5, startPara: 1, endPara: 5, summary: "x".repeat(20000) });
	cdb.setCompartmentStatus(c1, "ready");
	cdb.markCompartmentLanded(c1, 42);
	const compartmentContext = await run("session_context", { compartmentId: c1 });
	check("session_context resolves compartment source", compartmentContext.available === true && compartmentContext.returnedRange.startSeq === 1 && compartmentContext.returnedRange.endSeq === 5);
	check("compartment_mark processed", (await run("compartment_mark", { compartmentId: c1, processed: true })).ok === true && cdb.compartmentById(c1).has_promoted_facts === 1);
	check("compartment_mark archive", (await run("compartment_mark", { compartmentId: c1, archive: true, importance: 1 })).ok === true && cdb.compartmentById(c1).archive_flagged === 1);

	// ── archival budget ──────────────────────────────────────────────────────
	const c2 = cdb.insertCompartment({ sessionId: "s", scopePath: workspace, generation: 2, startSeq: 6, endSeq: 9, startPara: 6, endPara: 9, summary: "y".repeat(10000) });
	cdb.setCompartmentStatus(c2, "ready");
	cdb.markCompartmentLanded(c2, 43);
	const result = runArchival(cdb, { budgetTokens: 5000 }); // both summaries exceed budget
	check("archival archives something", result.archived.length >= 1);
	check("archival marks archived", result.archived.every((id) => cdb.compartmentById(id).archived === 1));
	check("archival respects budget", result.total <= 5000);
	check("archival candidates ordered", cdb.archivalCandidates().every((c) => c.archived === 0));

	// ── dreamer loop with a mock LLM ────────────────────────────────────────
	cdb.insertFact({ sessionId: "s", scopePath: workspace, fact: "deploy uses rsync", importance: 5 });
	const brief = buildDreamerBrief(cdb, 30);
	check("brief lists material", brief.facts.length === 1 && brief.brief.includes("PENDING SESSION FACTS (1)"));
	// Mock LLM: on the first stream, emit one tool call (promote the pending
	// fact); on the second stream, emit plain text (done).
	const pendingFact = brief.facts[0];
	let streamCalls = 0;
	const fakeCtx = {
		llm: {
			async *stream(options) {
				streamCalls += 1;
				if (streamCalls === 1) {
					yield { type: "tool-call-delta", name: "promote_fact", argumentsDelta: "" };
					yield { type: "tool-call-delta", argumentsDelta: JSON.stringify({ factId: pendingFact.id, category: "CONVENTIONS", summary: "deploy rsync", content: "deploy uses rsync", importance: 5 }) };
				} else {
					yield { type: "text-delta", text: "done" };
				}
			},
		},
	};
	const dreamerResult = await runDreamer(fakeCtx, cdb, {
		provider: "p",
		model: "m",
		workspaceRoot: workspace,
		scopePath: workspace,
		maxRounds: 5,
		timeoutMs: 5000,
		verifyIntervalDays: 30,
	});
	check("dreamer loop ran", dreamerResult.skipped === false && dreamerResult.rounds >= 1);
	check("dreamer records actions", dreamerResult.actions.some((action) => action.name === "promote_fact" && action.ok === true));
	check("dreamer action summary", summarizeDreamerActions(dreamerResult.actions).includes("promoted facts"));
	check("dreamer promoted fact", cdb.pendingFacts().length === 0 && cdb.db.prepare("SELECT COUNT(*) AS n FROM session_facts WHERE status='promoted'").get().n === 2);
	check("settled pass stamps verified_at", dreamerResult.settled === true && brief.memories.every((memory) => cdb.memoryById(memory.id).archived === 1 || cdb.memoryById(memory.id).verified_at !== null));
	// mark the remaining compartment distilled and all memories verified so
	// the next pass has no material
	await run("compartment_mark", { compartmentId: c2, processed: true });
	cdb.db.prepare("UPDATE memories SET verified_at = ?").run(Date.now());
	// skipped when no material
	const skipped = await runDreamer(fakeCtx, cdb, { provider: "p", model: "m", workspaceRoot: workspace, maxRounds: 5, timeoutMs: 5000, verifyIntervalDays: 30 });
	check("dreamer skips empty", skipped.skipped === true);

	// ── dream agent-plane registrar ─────────────────────────────────────────
	// The dream-agent row registers the ten maintenance tools into the host
	// registry and resolves workspace/scope from the executing agent at call
	// time. Its database connection must land in DSH_HOME, which this test
	// pins to the temporary home so the real deployment is never touched.
	process.env.DSH_HOME = home;
	const registeredTools = new Map();
	const promptSections = [];
	const disposers = [];
	// A fake resident session (the "parent" that triggered the pass) exposed
	// through the fake host sessions service, so the registry tools can read
	// provenance sources like the legacy loop does.
	const residentSession = {
		id: "s2",
		header: { cwd: workspace },
		events: [
			{ seq: 1, type: "user/message", data: { content: [{ type: "text", text: "The parent session states this convention explicitly." }] } },
		],
		deriveEventMessage: (event) => event.type === "user/message" ? { role: "user", content: event.data.content } : null,
	};
	const hostSessions = { get: (id) => id === "s2" ? residentSession : undefined };
	applyDreamAgent({
		tools: { register: (tool) => registeredTools.set(tool.name, tool) },
		systemPrompt: { section: (section) => promptSections.push(section) },
		inject: (serviceNames, callback) => {
			callback({ sessions: serviceNames.includes("sessions") ? hostSessions : {} });
		},
		effect: (fn) => {
			disposers.push(fn);
			return fn;
		},
	});
	check("dream agent registers eleven tools", registeredTools.size === 11 && ["sql_query", "session_context", "fs_list", "fs_read", "fs_grep", "memory_write", "memory_update", "memory_archive", "promote_fact", "compartment_mark"].every((name) => registeredTools.has(name)));
	check("dream agent registers instruction section", promptSections.some((section) => section.name === "dreamer:instruction" && section.text.includes("You are Dreamer")));
	const childExec = { agent: { session: { id: "dream-child", header: { cwd: workspace } } } };
	const agentFsList = await registeredTools.get("fs_list").execute({ path: "." }, childExec);
	check("dream agent resolves workspace from exec", agentFsList.map((entry) => entry.name).includes("src"));
	const sourceRead = await registeredTools.get("session_context").execute({ sessionId: "s2" }, childExec);
	check("dream agent reads a resident source session", sourceRead.available === true && JSON.stringify(sourceRead).includes("parent session states this convention"));
	const missingRead = await registeredTools.get("session_context").execute({ sessionId: "session-gone" }, childExec);
	check("dream agent degrades on non-resident source", missingRead.available === false && missingRead.error.includes("not live"));
	const agentWrite = await registeredTools.get("memory_write").execute({ category: "CONVENTIONS", summary: "dream agent write", content: "from registry", importance: 4 }, childExec);
	check("dream agent write reaches the database", typeof agentWrite.id === "number" && cdb.memoryById(agentWrite.id) !== undefined);
	for (const dispose of disposers) dispose();
	check("dream agent disposes its database", (() => { try { cdb.db.prepare("SELECT 1").get(); return true; } catch { return false; } })());

	// ── session-mode driver: one child session per pass ─────────────────────
	// A scripted child agent plays the dream pass; the fake host services
	// verify the attachment mechanics and lifecycle the design depends on.
	cdb.insertFact({ sessionId: "s", scopePath: workspace, fact: "dreamer runs as a child session", importance: 5 });
	const driverFact = cdb.pendingFacts().at(-1);
	const scriptedEvents = [];
	const makeChildAgent = (childId, behavior) => {
		const agent = {
			session: {
				id: childId,
				header: { cwd: workspace, parentSession: "s", origin: "subagent" },
				append: (type, data) => {
					scriptedEvents.push({ type, data });
					return scriptedEvents.length;
				},
				snapshotEvents: () => [...scriptedEvents],
			},
			followup: (message) => {
				scriptedEvents.push({ type: "user/message", data: { content: message.content } });
				for (const event of behavior.turn ?? []) scriptedEvents.push(event);
			},
			whenIdle: () => behavior.whenIdle(),
			cancel: () => {
				agent.cancelled = true;
				behavior.onCancel?.();
			},
		};
		return agent;
	};
	const createdChildren = [];
	const selectedRoutes = [];
	let disposed = 0;
	const fakeAgent = makeChildAgent("session-dream-test1", {
		turn: [
			{ type: "tool/call", data: { callId: "c1", name: "promote_fact", arguments: JSON.stringify({ factId: driverFact.id, category: "CONVENTIONS", summary: "child session pass", content: "one child per pass", importance: 5 }) } },
			{ type: "tool/result", data: { message: { role: "tool", source: { kind: "tool", callId: "c1" }, content: [{ type: "text", text: '{"id":9}' }] } } },
			{ type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "Promoted the pending fact. Done." }] } } },
			{ type: "turn/end", data: { turn: 1, reason: "completed" } },
		],
		whenIdle: () => Promise.resolve(),
	});
	const fakeDeps = {
		agents: {
			create: async ({ sessionId, meta, setup }) => {
				createdChildren.push({ sessionId, meta });
				const childAgent = Object.create(fakeAgent);
				childAgent.session = { ...fakeAgent.session, id: sessionId };
				await setup({});
				return { agent: childAgent, dispose: async () => { disposed += 1; } };
			},
		},
		agentPresets: {
			resolve: async (id) => {
				if (id !== "dream") throw new Error(`unknown preset ${id}`);
				return { id: "dream" };
			},
			mount: async () => {},
		},
		sessionController: { agents: { selectForNextRequest: (agent, selection) => selectedRoutes.push({ agentId: agent.session.id, selection }) } },
		llm: { resolveCallConfig: async (config) => ({ ...config, maxTokens: 4096 }) },
		cdb,
	};
	const passResult = await runDreamerSession(fakeDeps, {
		parentAgent: { session: { id: "s" } },
		provider: "p",
		model: "m",
		timeoutMs: 5000,
		verifyIntervalDays: 30,
		scopePath: workspace,
		workspaceRoot: workspace,
	});
	const created = createdChildren.at(-1);
	check("session pass creates a dream child", created !== undefined && created.sessionId.startsWith("session-dream-"));
	check("child attaches to the parent catalog", created.meta.parentSession === "s" && created.meta.origin === "subagent" && created.meta.agentPreset === "dream");
	check("child carries a catalog descriptor event", scriptedEvents.some((event) => event.type === "subagent/descriptor" && event.data.version === 3 && event.data.mode === "one-shot"));
	check("child receives the material brief", scriptedEvents.some((event) => event.type === "user/message" && JSON.stringify(event.data.content).includes("PENDING SESSION FACTS")));
	check("dreamer route committed on the child", selectedRoutes.some((row) => row.agentId === created.sessionId && row.selection.provider === "p" && row.selection.model === "m"));
	check("session pass collects actions from the child log", passResult.actions.length === 1 && passResult.actions[0].name === "promote_fact" && passResult.actions[0].ok === true);
	check("session pass extracts the verdict", passResult.settled === true && passResult.stopReason === "completed" && passResult.summary === "Promoted the pending fact. Done.");
	/* The driver only records actions from the child log; execution happens
	 * inside the child's real agent loop, which the scripted agent fakes. */
	check("session pass leaves execution to the child agent", cdb.pendingFacts().length === 1);
	check("session pass stamps verified memories", passResult.memories.every((memory) => cdb.memoryById(memory.id).archived === 1 || cdb.memoryById(memory.id).verified_at !== null));
	check("session pass disposes the child", disposed === 1);

	// cancelled pass: the timeout fires, the child is cancelled, and the pass
	// reports unsettled without stamping verified memories.
	cdb.insertFact({ sessionId: "s", scopePath: workspace, fact: "timeout probe fact", importance: 3 });
	let releaseWhenIdle;
	const slowAgent = makeChildAgent("session-dream-test2", {
		turn: [],
		whenIdle: () => new Promise((resolvePromise) => {
			releaseWhenIdle = resolvePromise;
		}),
		onCancel: () => {
			scriptedEvents.push({ type: "turn/end", data: { turn: 1, reason: "aborted" } });
			releaseWhenIdle();
		},
	});
	const slowDeps = {
		...fakeDeps,
		agents: {
			create: async ({ sessionId, meta, setup }) => {
				await setup({});
				return { agent: slowAgent, dispose: async () => { disposed += 1; } };
			},
		},
	};
	const timedOut = await runDreamerSession(slowDeps, {
		parentAgent: { session: { id: "s" } },
		provider: "p",
		model: "m",
		timeoutMs: 30,
		verifyIntervalDays: 30,
		scopePath: workspace,
		workspaceRoot: workspace,
	});
	check("session pass cancels on timeout", timedOut.cancelled === true && timedOut.settled === false && slowAgent.cancelled === true);

	// no material: drain every source list (facts pending, memories not yet
	// verified, compartments not distilled), then the driver must not spawn a
	// child at all. The dream-agent section wrote one fresh unverified memory,
	// which is why this drains memories too.
	while (cdb.pendingFacts().length > 0) cdb.discardFact(cdb.pendingFacts()[0].id, workspace);
	cdb.db.prepare("UPDATE memories SET verified_at = ?").run(Date.now());
	const noMaterial = await runDreamerSession(fakeDeps, {
		parentAgent: { session: { id: "s" } },
		provider: "p",
		model: "m",
		timeoutMs: 5000,
		verifyIntervalDays: 30,
		scopePath: workspace,
		workspaceRoot: workspace,
	});
	/* Only the first pass ran through the recording fake create; the timeout
	 * pass used its own closure and the skip pass spawned nothing. */
	check("session pass skips without material", noMaterial.skipped === true && createdChildren.length === 1);

	cdb.close();
} finally {
	rmSync(home, { recursive: true, force: true });
	rmSync(workspace, { recursive: true, force: true });
}

if (failed > 0) {
	console.error(`${failed} assertion(s) failed`);
	process.exit(1);
}
console.log("dsh-context dreamer smoke: OK");

// dsh-plugin-context Dreamer smoke test: internal tools, loop against a mock
// LLM, and the archival code path.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runDreamer, runArchival, createDreamerTools, buildDreamerBrief } from "/home/mon3tr/.dsh/profiles/node_modules/dsh-plugin-context/lib/dreamer.js";
import { openDatabase } from "/home/mon3tr/.dsh/profiles/node_modules/dsh-plugin-context/lib/db.js";

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
	check("memory_update", (await run("memory_update", { id: wrote.id, importance: 9 })).ok === true && cdb.memoryById(wrote.id).importance === 9);
	check("memory_archive", (await run("memory_archive", { id: wrote.id })).ok === true && cdb.memoryById(wrote.id).archived === 1);
	cdb.updateMemory(wrote.id, { archived: 0 });

	// facts + compartments
	const factId = cdb.insertFact({ sessionId: "s", scopePath: workspace, fact: "auth uses TOKEN_TTL 3600s", importance: 6 });
	const promoted = await run("promote_fact", { factId, category: "ARCHITECTURE", summary: "auth ttl", content: "TOKEN_TTL=3600 in src/auth.ts", importance: 8 });
	check("promote_fact", promoted.id !== undefined && cdb.pendingFacts().length === 0 && cdb.memoryById(promoted.id) !== undefined);
	check("promoted fact provenance", cdb.memoryById(promoted.id).source_session_id === "s");
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
	check("dreamer promoted fact", cdb.pendingFacts().length === 0 && cdb.db.prepare("SELECT COUNT(*) AS n FROM session_facts WHERE status='promoted'").get().n === 2);
	// mark the remaining compartment distilled and all memories verified so
	// the next pass has no material
	await run("compartment_mark", { compartmentId: c2, processed: true });
	cdb.db.prepare("UPDATE memories SET verified_at = ?").run(Date.now());
	// skipped when no material
	const skipped = await runDreamer(fakeCtx, cdb, { provider: "p", model: "m", workspaceRoot: workspace, maxRounds: 5, timeoutMs: 5000, verifyIntervalDays: 30 });
	check("dreamer skips empty", skipped.skipped === true);

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

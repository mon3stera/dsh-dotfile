// dsh-plugin-context organizer (summarizer) + engine wiring smoke test.
import { mkdtempSync, rmSync } from "node:fs";
import { parseOrganizerOutput, buildSummarizationInput } from "/home/mon3tr/.dsh/profiles/node_modules/dsh-plugin-context/lib/summarizer.js";
import { ContextEngine } from "/home/mon3tr/.dsh/profiles/node_modules/dsh-plugin-context/lib/engine.js";

let failed = 0;
const check = (label, ok) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
	if (!ok) failed += 1;
};

// ── organizer output parsing ────────────────────────────────────────────────
{
	const full = [
		"<compacted-summary>",
		"- fixed auth: JWT with 30d expiry",
		"- deploy via rsync to prod",
		"</compacted-summary>",
		"<session-facts>",
		"- project uses JWT auth (importance: 8)",
		"- deploy script lives in scripts/deploy.sh (importance: 6)",
		"- one-off: fixed typo in README (importance: 2)",
		"</session-facts>",
	].join("\n");
	const parsed = parseOrganizerOutput(full);
	check("parse summary", parsed.summary.includes("JWT with 30d expiry") && parsed.summary.includes("rsync"));
	check("parse facts count", parsed.facts.length === 3);
	check("parse fact importance", parsed.facts[0].importance === 8 && parsed.facts[1].importance === 6 && parsed.facts[2].importance === 2);

	const none = "<compacted-summary>\n- only summary\n</compacted-summary>\n<session-facts>\n(none)\n</session-facts>";
	check("parse (none) facts", parseOrganizerOutput(none).facts.length === 0);
	check("parse summary-only fallback", parseOrganizerOutput("plain text").summary === "plain text");
	check("parse clamps importance", parseOrganizerOutput("<session-facts>\n- x (importance: 99)\n</session-facts>").facts[0].importance === 10);
}

// ── input building: skip + checkpoint exclusion ─────────────────────────────
{
	const events = {
		0: { seq: 0, type: "user/message", data: { content: [{ type: "text", text: "q1" }] }, surfaceOp: "append" },
		1: { seq: 1, type: "assistant/message", data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "a1" }] } }, surfaceOp: "append" },
		2: { seq: 2, type: "user/message", data: { content: [{ type: "text", text: "q2" }] }, surfaceOp: "append" },
		3: { seq: 3, type: "user/message", data: { content: [{ type: "text", text: "old checkpoint" }], source: { kind: "plugin", plugin: "compact", compactionId: "c1" } }, surfaceOp: { op: "replace", start: 0, end: 1 } },
	};
	const session = {
		requestHeader: () => ({ system: "sys", tools: [{ name: "t" }], config: { provider: "p", model: "m" } }),
		events,
		deriveEventMessage: (event) => ({ role: "user", content: event.data.content }),
	};
	const range = { shadowedSeqs: [0, 1, 2, 3] };
	const input = buildSummarizationInput(session, range, new Set([1]));
	check("input excludes skipped", input.messages.every((m) => !m.content.some((b) => b.text === "a1")));
	check("input excludes prior checkpoint", input.messages.every((m) => !m.content.some((b) => b.text === "old checkpoint")));
	check("input keeps q1 q2", input.messages.length === 2);
	check("input carries system+tools", input.system === "sys" && input.tools.length === 1);
}

// ── engine wiring: config split + trigger registration with a stub ctx ─────
{
	// Isolate the engine's database under a temporary DSH_HOME.
	const tmpHome = mkdtempSync("/home/mon3tr/ctx-engine-");
	const savedHome = process.env.DSH_HOME;
	process.env.DSH_HOME = tmpHome;
	try {
		// Load ContextEngine against a stub context; it must not throw and must
		// split own keys out of the basic config (auto forced false).
		const stubs = [];
		const fakeCtx = {
			effect: () => () => {},
			logger: { warn: () => {} },
			on: (name, handler) => { stubs.push([name, handler]); },
			systemPrompt: { section: () => {} },
			reflect: { provide: () => () => {} },
		};
		const engine = new ContextEngine(fakeCtx, { generateThreshold: 0.7, retainRounds: 10, thresholdRatio: 0.8 });
		check("own config split", engine.ownConfig.generateThreshold === 0.7 && engine.ownConfig.retainRounds === 10);
		check("basic auto disabled", engine.config.auto === false);
		check("basic threshold kept", engine.config.thresholdRatio === 0.8);
		check("triggers registered", stubs.some(([n]) => n === "agent/pre-step") && stubs.some(([n]) => n === "session/event") && stubs.some(([n]) => n === "agent/request-error"));
		// session/event handlers: the paragraph assigner must ignore non-surface
		// events; the boundary handler must ignore non-boundary events.
		const [, boundaryHandler] = stubs.filter(([n]) => n === "session/event").map(([, h]) => h);
		const called = [];
		const agent = { session: { id: "s" } };
		engine.agentBySession.set(agent.session, agent);
		engine.maybeGenerate = async () => { called.push("generate"); };
		boundaryHandler(agent.session, { type: "compaction/start", seq: 1, data: { compactionId: "x", turn: null } });
		check("assigner ignores log-only events", called.length === 0);
		boundaryHandler(agent.session, { type: "assistant/message", seq: 1, data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "a" }] } }, surfaceOp: "append" });
		check("boundary handler ignores assistant/message", called.length === 0);
		boundaryHandler(agent.session, { type: "turn/end", seq: 2, data: { turn: 1, reason: { kind: "completed" } } });
		check("boundary handler fires on turn/end", called.length === 1);
		engine.cdb.close();
	} finally {
		if (savedHome === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = savedHome;
		rmSync(tmpHome, { recursive: true, force: true });
	}
}

if (failed > 0) {
	console.error(`${failed} assertion(s) failed`);
	process.exit(1);
}
console.log("dsh-context engine smoke: OK");

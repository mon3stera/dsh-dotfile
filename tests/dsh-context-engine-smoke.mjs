// dsh-magic-context organizer (summarizer) + engine wiring smoke test.
import { mkdtempSync, rmSync } from "node:fs";
import { parseOrganizerOutput, buildSummarizationInput } from "/home/mon3tr/.dsh/profiles/node_modules/dsh-magic-context/lib/summarizer.js";
import { ContextEngine } from "/home/mon3tr/.dsh/profiles/node_modules/dsh-magic-context/lib/engine.js";
import { installParagraphInjector } from "/home/mon3tr/.dsh/profiles/node_modules/dsh-magic-context/lib/paragraphs.js";
import { getContextUsage } from "/home/mon3tr/.dsh/profiles/node_modules/dsh-magic-context/lib/usage.js";

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
		const registeredTools = [];
		const promptSections = [];
		const fakeCtx = {
			effect: () => () => {},
			logger: { warn: () => {} },
			tokenMeter: { estimateMessage: () => 178 },
			on: (name, handler) => { stubs.push([name, handler]); },
			systemPrompt: { section: (section) => promptSections.push(section) },
			tools: { register: (tool) => registeredTools.push(tool) },
			reflect: { provide: () => () => {} },
		};
		const engine = new ContextEngine(fakeCtx, { generateThreshold: 0.7, retainRounds: 10, thresholdRatio: 0.8, embeddingDim: 4 });
		check("own config split", engine.ownConfig.generateThreshold === 0.7 && engine.ownConfig.retainRounds === 10);
		check("basic auto disabled", engine.config.auto === false);
		check("basic threshold kept", engine.config.thresholdRatio === 0.8);
		check("embedding dimension wired", engine.cdb.embeddingDim === 4);
		check("context tools registered", registeredTools.some((tool) => tool.name === "ctx_reduce") && registeredTools.some((tool) => tool.name === "ctx_expand"));
		const guidance = promptSections.find((section) => section.name === "context-tool-guidance");
		check("context tool guidance injected", guidance?.text.includes("ctx_reduce") && guidance.text.includes("ctx_memory") && guidance.text.includes("ctx_search") && guidance.text.includes("ctx_expand"));
		check("triggers registered", stubs.some(([n]) => n === "agent/pre-step") && stubs.some(([n]) => n === "session/event") && stubs.some(([n]) => n === "agent/request-error"));
		const injectionSession = {};
		engine.injection.set(injectionSession, { text: "<project_memory>one time</project_memory>", consumed: false });
		const injectionConsumer = stubs.find(([n, handler]) => n === "session/event" && String(handler).includes("injection"))?.[1];
		injectionConsumer?.(injectionSession, { type: "step/end" });
		check("memory injection consumed after first step", engine.injection.get(injectionSession).consumed === true);
		check("periodic trigger removed", !stubs.some(([n]) => n === "timer") && !stubs.some(([n]) => n === "setInterval"));

		// Dreamer runs once for an idle interaction round; plugin notices and
		// other background events do not re-arm it until the next turn starts.
		const idleHandler = stubs.find(([n, handler]) => n === "session/event" && String(handler).includes("_runDreamerForAgent"))?.[1];
		const dreamerSession = { id: "dreamer-idle" };
		engine.agentBySession.set(dreamerSession, { session: dreamerSession });
		engine.ownConfig.dreamerConfig.idleMinutes = 0.001;
		let dreamerCalls = 0;
		const realDreamer = engine._runDreamerForAgent;
		engine._runDreamerForAgent = async () => { dreamerCalls += 1; };
		const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
		idleHandler?.(dreamerSession, { type: "turn/start", seq: 1, data: { turn: 1 } });
		idleHandler?.(dreamerSession, { type: "turn/end", seq: 2, data: { turn: 1 } });
		await wait(100);
		check("dreamer runs once per interaction round", dreamerCalls === 1);
		idleHandler?.(dreamerSession, { type: "user/message", seq: 3, data: { source: { kind: "plugin", plugin: "dsh-magic-context", form: "notice" } } });
		await wait(100);
		check("dreamer does not repeat without a new turn", dreamerCalls === 1);
		idleHandler?.(dreamerSession, { type: "turn/start", seq: 4, data: { turn: 2 } });
		idleHandler?.(dreamerSession, { type: "turn/end", seq: 5, data: { turn: 2 } });
		await wait(100);
		check("dreamer runs again after a new turn", dreamerCalls === 2);

		// A completed pass publishes a concise UI notice with the action summary.
		engine._runDreamerForAgent = realDreamer;
		const completionNotices = [];
		const completionSession = {
			id: "dreamer-completion",
			header: { cwd: process.cwd() },
			requestHeader: () => ({ config: { provider: "p", model: "m" } }),
			events: [],
		};
		engine.cdb.writeMemory({ category: "CONVENTIONS", scopePath: process.cwd(), summary: "completion notice test", content: "test", importance: 5 });
		fakeCtx.llm = { async *stream() { yield { type: "text-delta", text: "done" }; } };
		await engine._runDreamerForAgent({ session: completionSession, inject: (message) => completionNotices.push(message) });
		const completionText = completionNotices.map((notice) => notice.content?.map((block) => block.text ?? "").join("\n")).join("\n");
		check("dreamer completion notice", completionText.includes("Dreamer completed") && completionText.includes("Summary:") && completionText.includes("Archived compartments: 0."));

		const shortAgent = { session: { id: "short-history" } };
		const shortResult = await engine._createAndSummarize(shortAgent, { start: 1, end: 2 }, 100);
		check("short source skips impossible summary", shortResult === null && engine.cdb.readyCompartments("short-history").length === 0);
		let releaseGeneration;
		const generationGate = new Promise((resolve) => { releaseGeneration = resolve; });
		let generationCalls = 0;
		engine._maybeGenerate = async () => { generationCalls += 1; await generationGate; };
		const singleSession = { id: "single-flight" };
		const firstGeneration = engine.maybeGenerate({ session: singleSession });
		const secondGeneration = engine.maybeGenerate({ session: singleSession });
		check("generation single-flight shares promise", firstGeneration === secondGeneration);
		releaseGeneration();
		await firstGeneration;
		check("generation single-flight runs once", generationCalls === 1 && !engine.inFlight.has(singleSession.id));

		// legacy checkpoint migration: a checkpoint node produced by the old
		// engine (source marker present, no compartments row) gets registered
		// as a landed compartment when the engine first looks at the session.
		const legacySession = {
			id: "legacy-s",
			events: {
				0: { seq: 0, type: "user/message", data: { content: [{ type: "text", text: "q" }] }, surfaceOp: "append" },
				1: { seq: 1, type: "user/message", data: { content: [{ type: "text", text: "<compacted-summary>old big block</compacted-summary>" }], source: { kind: "plugin", plugin: "compact", compactionId: "old-1" } }, surfaceOp: { op: "replace", start: 0, end: 0 } },
				2: { seq: 2, type: "user/message", data: { content: [{ type: "text", text: "after" }] }, surfaceOp: "append" },
			},
			surface: { nodes: [1, 2], replaceGeneration: 1 },
		};
		engine._registerUnownedCheckpoints({ session: legacySession });
		const registered = engine.cdb.allActiveCompartments();
		check("legacy checkpoint registered", registered.length === 1 && registered[0].session_id === "legacy-s" && registered[0].landing_seq === 1);
		check("legacy checkpoint summary kept", registered[0].summary === "<compacted-summary>old big block</compacted-summary>");
		check("migration idempotent", (() => { engine._registerUnownedCheckpoints({ session: legacySession }); return engine.cdb.allActiveCompartments().length; })() === 1);
		// a second legacy checkpoint chains on with the next generation number
		const chained = {
			id: "legacy-s",
			events: { ...legacySession.events, 3: { seq: 3, type: "user/message", data: { content: [{ type: "text", text: "cp2" }], source: { kind: "plugin", plugin: "compact", compactionId: "old-2" } }, surfaceOp: { op: "replace", start: 2, end: 2 } } },
			surface: { nodes: [1, 3], replaceGeneration: 2 },
		};
		engine._registerUnownedCheckpoints({ session: chained });
		const chained2 = engine.cdb.allActiveCompartments();
		check("second legacy checkpoint registered", chained2.length === 2 && chained2[1].landing_seq === 3 && chained2[1].generation === 2);
		// session/event handlers: the paragraph assigner must ignore non-surface
		// events; the boundary handler must ignore non-boundary events.
		const boundaryHandler = stubs.find(([n, h]) => n === "session/event" && String(h).includes("maybeGenerate"))?.[1];
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

		// A successful landing starts a fresh, unconsumed memory injection. The
		// derived head is replaced in place, so the next request sees new memories
		// instead of appending a second project_memory block.
		const landingEvents = [
			{ type: "turn/start", seq: 0, time: 0, data: { turn: 1 } },
			{ type: "user/message", seq: 1, time: 0, data: { content: [{ type: "text", text: "landing user" }] }, surfaceOp: "append" },
			{ type: "step/start", seq: 2, time: 0, data: { turn: 1, step: 1 } },
			{ type: "assistant/message", seq: 3, time: 0, data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "landing answer" }] } }, surfaceOp: "append" },
		];
		const landingSession = {
			id: "landing-refresh",
			header: { cwd: process.cwd() },
			events: landingEvents,
			surface: { nodes: [1, 3], replaceGeneration: 0 },
			append(type, data, extra = {}) {
				const event = { type, seq: this.events.length, time: Date.now(), data, ...extra };
				this.events.push(event);
				if (event.surfaceOp !== undefined) {
					if (event.surfaceOp === "append") this.surface.nodes.push(event.seq);
					else {
						const startIdx = this.surface.nodes.indexOf(event.surfaceOp.start);
						const endIdx = this.surface.nodes.indexOf(event.surfaceOp.end);
						this.surface.nodes.splice(startIdx, endIdx - startIdx + 1, event.seq);
						this.surface.replaceGeneration += 1;
					}
				}
				return event;
			},
		};
		const landingAgent = { session: landingSession, inject: () => {} };
		const originalCdb = engine.cdb;
		const originalMeter = engine.ctx.tokenMeter;
		const originalRefresh = engine.refreshInjection;
		const originalAnnounce = engine._announceCompartment;
		const refreshCalls = [];
		engine.cdb = { markCompartmentLanded: () => {} };
		engine.ctx.tokenMeter = {
			estimateMessage: () => 25,
			measure: (session) => ({ nodes: session.surface.nodes.map((seq) => ({ seq, tokens: 1 })) }),
		};
		engine.refreshInjection = (session, options) => refreshCalls.push({ session, options });
		engine._announceCompartment = () => {};
		let landingError;
		try {
			await engine.land(landingAgent, {
				id: 77,
				start_seq: 1,
				end_seq: 3,
				summary: "landing summary",
				shadowed_tokens: 100,
				provider: "provider",
				model: "model",
			}, new AbortController().signal);
		} catch (error) {
			landingError = error;
		} finally {
			engine.cdb = originalCdb;
			engine.ctx.tokenMeter = originalMeter;
			engine.refreshInjection = originalRefresh;
			engine._announceCompartment = originalAnnounce;
		}
		check("landing refreshes memory injection", landingError === undefined && refreshCalls.length === 1 && refreshCalls[0].session === landingSession && refreshCalls[0].options.consumed === false);

		const memorySession = {
			id: "memory-refresh",
			header: { cwd: process.cwd() },
			events: [],
			surface: { nodes: [], replaceGeneration: 0 },
			deriveEventMessage: () => null,
		};
		engine.injection.set(memorySession, { text: "<project_memory>old</project_memory>", consumed: false, memoryCount: 1, memoryTokens: 1 });
		installParagraphInjector(memorySession, engine.cdb, {
			extraMessage: () => {
				const injection = engine.injection.get(memorySession);
				return injection?.consumed || injection?.text.length === 0
					? null
					: { role: "user", content: [{ type: "text", text: injection.text }] };
			},
		});
		check("memory head starts with cached block", memorySession.deriveMessages()[0]?.content?.[0]?.text === "<project_memory>old</project_memory>");
		engine.cdb.writeMemory({ category: "CONVENTIONS", scopePath: process.cwd(), summary: "memory created after landing", content: "new", importance: 10 });
		engine.refreshInjection(memorySession, { consumed: false });
		const refreshedHead = memorySession.deriveMessages()[0]?.content?.[0]?.text ?? "";
		check("memory head is replaced with refreshed block", refreshedHead.includes("memory created after landing") && !refreshedHead.includes("<project_memory>old</project_memory>"));

		// Long tool-heavy sessions can exceed the pressure threshold before they
		// reach the default retainRounds count; automatic generation must fall back
		// to the short-history policy instead of returning no range.
		let seq = 0;
		const longEvents = [];
		const add = (type, data = {}, extra = {}) => {
			const event = { type, seq: seq++, data, ...extra };
			longEvents.push(event);
			return event;
		};
		for (let turn = 1; turn <= 3; turn += 1) {
			add("turn/start", { turn });
			add("user/message", { role: "user", content: [{ type: "text", text: `q${turn}` }] }, { surfaceOp: "append" });
			add("step/start", { turn, step: 1 });
			add("assistant/message", { turn, step: 1, message: { role: "assistant", content: [{ type: "text", text: `a${turn}` }] } }, { surfaceOp: "append" });
			add("step/end", { turn, step: 1 });
			add("turn/end", { turn, reason: { kind: "completed" } });
		}
		const longSession = {
			id: "long-turn-history",
			events: longEvents,
			surface: { nodes: [1, 3, 7, 9, 13, 15] },
			requestHeader: () => ({ config: { provider: "p", model: "m" } }),
		};
		engine._maybeGenerate = ContextEngine.prototype._maybeGenerate;
		engine._contextWindow = async () => 1000;
		engine.ctx.tokenMeter.measure = (session) => ({ totalTokens: session.surface.nodes.length * 200, nodes: session.surface.nodes.map((node) => ({ seq: node, tokens: 200 })) });
		const generatedRanges = [];
		engine._createAndSummarize = async (_agent, range) => { generatedRanges.push(range); return 1; };
		await engine._maybeGenerate({ session: longSession });
		check("automatic generation uses paragraph tail", generatedRanges.length === 1 && generatedRanges[0].start === 1 && generatedRanges[0].end === 1);

		const usageSession = {
			id: "usage-window",
			events: {
				1: { seq: 1, type: "user/message", data: { content: [{ type: "text", text: "q" }] } },
				3: { seq: 3, type: "user/message", data: { content: [{ type: "text", text: "<compacted-summary>c</compacted-summary>" }], source: { kind: "plugin", plugin: "compact", compactionId: "c1" } } },
				5: { seq: 5, type: "user/message", data: { content: [{ type: "text", text: "latest" }] } },
			},
			surface: { nodes: [1, 3, 5] },
		};
		engine.ctx.tokenMeter.measure = () => ({ nodes: [{ seq: 1, tokens: 100 }, { seq: 3, tokens: 77 }, { seq: 5, tokens: 200 }] });
		engine.injection.set(usageSession, { memoryCount: 6, memoryTokens: 456, consumed: false });
		engine._refreshContextUsage(usageSession);
		let usage = getContextUsage(usageSession.id);
		check("usage counts visible compartment and unconsumed memory", usage.compartments.count === 1 && usage.compartments.tokens === 77 && usage.memories.count === 6 && usage.memories.tokens === 456 && usage.totalTokens === 533);
		engine.injection.get(usageSession).consumed = true;
		engine._refreshContextUsage(usageSession);
		usage = getContextUsage(usageSession.id);
		check("consumed memory leaves current window usage", usage.memories.count === 0 && usage.memories.tokens === 0 && usage.totalTokens === 77);
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

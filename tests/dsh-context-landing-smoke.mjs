// dsh-magic-context landing + range selection smoke test.
import { selectCompartmentRange, selectManualCompartmentRange } from "/home/mon3tr/.dsh/profiles/node_modules/dsh-magic-context/lib/range.js";
import { estimateFramedSummaryTokens, landCompartment, frameCompartmentSummary } from "/home/mon3tr/.dsh/profiles/node_modules/dsh-magic-context/lib/landing.js";

/** The 0.1.2 host compaction balance cache reads session.eventAt(seq). */
const eventAtFor = (events) => (seq) => (Array.isArray(events) ? events : Object.values(events)).find((event) => event.seq === seq);

let failed = 0;
const check = (label, ok) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
	if (!ok) failed += 1;
};

// ── range selection ─────────────────────────────────────────────────────────
{
	// Log (seq 0-based): turn1 (2 nodes), turn2 (2 nodes), turn3 (2 nodes).
	let seq = 0;
	const events = [];
	const ev = (type, data = {}, extra = {}) => {
		const e = { type, seq: seq++, time: 0, data, ...extra };
		events.push(e);
		return e;
	};
	const turn = (n) => {
		ev("turn/start", { turn: n });
		ev("user/message", { content: [{ type: "text", text: `t${n}q` }] }, { surfaceOp: "append" });
		ev("step/start", { turn: n, step: 1 });
		ev("assistant/message", { turn: n, step: 1, message: { content: [{ type: "text", text: `t${n}a` }] } }, { surfaceOp: "append" });
		ev("turn/end", { turn: n, reason: { kind: "completed" } });
	};
	turn(1); turn(2); turn(3);
	// surface nodes: user1=1, asst1=3, user2=6, asst2=8, user3=11, asst3=13
	const surface = { nodes: [1, 3, 6, 8, 11, 13], replaceGeneration: 0 };
	const session = { events, surface, eventAt: eventAtFor(events) };
	let r = selectCompartmentRange(session, { retainRounds: 1 });
	check("retain 1 keeps one paragraph", r !== null && r.start === 1 && r.end === 11 && r.shadowedSeqs.join(",") === "1,3,6,8,11");
	r = selectCompartmentRange(session, { retainRounds: 2 });
	check("retain 2 keeps two paragraphs", r !== null && r.start === 1 && r.end === 8 && r.shadowedSeqs.join(",") === "1,3,6,8");
	r = selectCompartmentRange(session, { retainRounds: 3 });
	check("retain 3 keeps three paragraphs", r !== null && r.start === 1 && r.end === 6 && r.shadowedSeqs.join(",") === "1,3,6");
	r = selectManualCompartmentRange(session, { retainRounds: 20 });
	check("manual short history keeps one paragraph tail", r !== null && r.start === 1 && r.end === 1 && r.shadowedSeqs.join(",") === "1");
	const oneTurn = { events: events.slice(0, 5), surface: { nodes: [1, 3], replaceGeneration: 0 }, eventAt: eventAtFor(events) };
	check("manual short history leaves one paragraph", (() => { const one = selectManualCompartmentRange(oneTurn, { retainRounds: 20 }); return one !== null && one.start === 1 && one.end === 1; })());

	// checkpointed surface: node 16 is a landed checkpoint (head), turns 4+5 follow.
	const events2 = [...events];
	events2.push({ type: "compaction/summary", seq: 15, time: 0, data: {} });
	events2.push({ type: "user/message", seq: 16, time: 0, data: { content: [{ type: "text", text: "cp" }], source: { kind: "plugin", plugin: "compact", compactionId: "c1" } }, surfaceOp: { op: "replace", start: 1, end: 13 } });
	const nodes2 = [16, 19, 22]; // checkpoint, t4 assistant, t5 assistant
	events2.push({ type: "tool/call", seq: 17, time: 0, data: { callId: "x", name: "bash", arguments: "{}" } });
	events2.push({ type: "step/start", seq: 18, time: 0, data: { turn: 4, step: 1 } });
	events2.push({ type: "assistant/message", seq: 19, time: 0, data: { turn: 4, step: 1, message: { content: [{ type: "text", text: "t4" }] } }, surfaceOp: "append" });
	events2.push({ type: "turn/end", seq: 20, time: 0, data: { turn: 4, reason: { kind: "completed" } } });
	events2.push({ type: "step/start", seq: 21, time: 0, data: { turn: 5, step: 1 } });
	events2.push({ type: "assistant/message", seq: 22, time: 0, data: { turn: 5, step: 1, message: { content: [{ type: "text", text: "t5" }] } }, surfaceOp: "append" });
	events2.push({ type: "turn/end", seq: 23, time: 0, data: { turn: 5, reason: { kind: "completed" } } });
	const session2 = { events: events2, surface: { nodes: nodes2, replaceGeneration: 1 }, eventAt: eventAtFor(events2) };
	// the checkpoint itself is never re-summarizable: only t4 stays compressible
	r = selectCompartmentRange(session2, { retainRounds: 2 });
	check("checkpointed retain 2 null", r === null);
	r = selectCompartmentRange(session2, { retainRounds: 1 });
	check("checkpointed retain 1 after checkpoint", r !== null && r.start === 19 && r.end === 19);
	r = selectCompartmentRange(session2, { retainRounds: 5 });
	check("checkpointed retain 5 null", r === null);

	// chain surface [C1][C2]+content: BOTH head checkpoints are skipped, so the
	// range starts at the first real content after the last checkpoint.
	const events3 = events2.slice(0, 23); // seq 0..22, then the new generation
	events3.push({ type: "compaction/summary", seq: 23, time: 0, data: {} });
	events3.push({ type: "user/message", seq: 24, time: 0, data: { content: [{ type: "text", text: "cp2" }], source: { kind: "plugin", plugin: "compact", compactionId: "c2" } }, surfaceOp: { op: "replace", start: 19, end: 19 } });
	events3.push({ type: "step/start", seq: 25, time: 0, data: { turn: 6, step: 1 } });
	events3.push({ type: "assistant/message", seq: 26, time: 0, data: { turn: 6, step: 1, message: { content: [{ type: "text", text: "t6" }] } }, surfaceOp: "append" });
	events3.push({ type: "tool/call", seq: 27, time: 0, data: { callId: "y", name: "read", arguments: "{}" } });
	events3.push({ type: "step/start", seq: 28, time: 0, data: { turn: 7, step: 1 } });
	events3.push({ type: "assistant/message", seq: 29, time: 0, data: { turn: 7, step: 1, message: { content: [{ type: "text", text: "t7" }] } }, surfaceOp: "append" });
	events3.push({ type: "turn/end", seq: 30, time: 0, data: { turn: 7, reason: { kind: "completed" } } });
	const session3 = { events: events3, surface: { nodes: [16, 24, 26, 29], replaceGeneration: 2 }, eventAt: eventAtFor(events3) };
	r = selectCompartmentRange(session3, { retainRounds: 1 });
	check("chain skips both checkpoints", r !== null && r.start === 26 && r.end === 26 && r.shadowedSeqs.join(",") === "26");
	r = selectCompartmentRange(session3, { retainRounds: 0 });
	check("chain retain 0 still skips checkpoints", r !== null && r.start === 26 && r.end === 29);

	// 0.1.5: surface node 0 is the system prompt. Compaction must start after
	// it (and still skip the checkpoint chain that now sits at index 1+).
	const withSystem = {
		events: [
			{ type: "turn/start", seq: 0, time: 0, data: { turn: 1 } },
			{ type: "step/start", seq: 1, time: 0, data: { turn: 1, step: 1 } },
			{ type: "system/message", seq: 2, time: 0, data: { turn: 1, step: 1, message: { role: "system", content: [{ type: "text", text: "prompt" }] } }, surfaceOp: "append" },
			{ type: "user/message", seq: 3, time: 0, data: { content: [{ type: "text", text: "q1" }] }, surfaceOp: "append" },
			{ type: "assistant/message", seq: 4, time: 0, data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "a1" }] } }, surfaceOp: "append" },
			{ type: "turn/end", seq: 5, time: 0, data: { turn: 1, reason: { kind: "completed" } } },
			{ type: "turn/start", seq: 6, time: 0, data: { turn: 2 } },
			{ type: "user/message", seq: 7, time: 0, data: { content: [{ type: "text", text: "q2" }] }, surfaceOp: "append" },
			{ type: "assistant/message", seq: 8, time: 0, data: { turn: 2, step: 1, message: { content: [{ type: "text", text: "a2" }] } }, surfaceOp: "append" },
			{ type: "turn/end", seq: 9, time: 0, data: { turn: 2, reason: { kind: "completed" } } },
			{ type: "turn/start", seq: 10, time: 0, data: { turn: 3 } },
			{ type: "user/message", seq: 11, time: 0, data: { content: [{ type: "text", text: "q3" }] }, surfaceOp: "append" },
			{ type: "assistant/message", seq: 12, time: 0, data: { turn: 3, step: 1, message: { content: [{ type: "text", text: "a3" }] } }, surfaceOp: "append" },
		],
		surface: { nodes: [2, 3, 4, 7, 8, 11, 12], replaceGeneration: 0 },
	};
	withSystem.eventAt = eventAtFor(withSystem.events);
	r = selectCompartmentRange(withSystem, { retainRounds: 1 });
	check("system head is never in the compactable range", r !== null && r.start === 3 && r.end === 11 && !r.shadowedSeqs.includes(2));
	r = selectManualCompartmentRange(withSystem, { retainRounds: 20 });
	check("manual short history still skips the system head", r !== null && r.start === 3 && r.end === 3);

	const chained = {
		events: [
			...withSystem.events,
			{ type: "compaction/summary", seq: 13, time: 0, data: {} },
			{ type: "user/message", seq: 14, time: 0, data: { content: [{ type: "text", text: "cp" }], source: { kind: "plugin", plugin: "compact", compactionId: "c1" } }, surfaceOp: { op: "replace", startSeq: 3, endSeq: 8 } },
			{ type: "assistant/message", seq: 15, time: 0, data: { turn: 4, step: 1, message: { content: [{ type: "text", text: "t4" }] } }, surfaceOp: "append" },
			{ type: "assistant/message", seq: 16, time: 0, data: { turn: 5, step: 1, message: { content: [{ type: "text", text: "t5" }] } }, surfaceOp: "append" },
		],
		surface: { nodes: [2, 14, 15, 16], replaceGeneration: 1 },
	};
	chained.eventAt = eventAtFor(chained.events);
	r = selectCompartmentRange(chained, { retainRounds: 1 });
	check("system head then checkpoint chain starts after both", r !== null && r.start === 15 && r.end === 15);
	r = selectCompartmentRange(chained, { retainRounds: 0 });
	check("system+checkpoint retain 0 still skips both", r !== null && r.start === 15 && r.end === 16);

	// A later in-history system/message is ordinary history and MAY be shadowed.
	const laterSystem = {
		events: [
			{ type: "system/message", seq: 0, time: 0, data: { turn: 1, step: 1, message: { role: "system", content: [{ type: "text", text: "p0" }] } }, surfaceOp: "append" },
			{ type: "user/message", seq: 1, time: 0, data: { content: [{ type: "text", text: "q1" }] }, surfaceOp: "append" },
			{ type: "system/message", seq: 2, time: 0, data: { turn: 1, step: 2, message: { role: "system", content: [{ type: "text", text: "p1" }] } }, surfaceOp: "append" },
			{ type: "user/message", seq: 3, time: 0, data: { content: [{ type: "text", text: "q2" }] }, surfaceOp: "append" },
			{ type: "assistant/message", seq: 4, time: 0, data: { turn: 1, step: 2, message: { content: [{ type: "text", text: "a2" }] } }, surfaceOp: "append" },
		],
		surface: { nodes: [0, 1, 2, 3, 4], replaceGeneration: 0 },
	};
	laterSystem.eventAt = eventAtFor(laterSystem.events);
	r = selectCompartmentRange(laterSystem, { retainRounds: 1 });
	check("later system/message may sit inside the range", r !== null && r.start === 1 && r.end === 3 && r.shadowedSeqs.includes(2) && !r.shadowedSeqs.includes(0));
}

// ── landing transaction ─────────────────────────────────────────────────────
{
	const seed = [
		{ type: "turn/start", seq: 0, time: 0, data: { turn: 1 } },
		{ type: "user/message", seq: 1, time: 0, data: { content: [{ type: "text", text: "a" }] }, surfaceOp: "append" },
		{ type: "step/start", seq: 2, time: 0, data: { turn: 1, step: 1 } },
		{ type: "assistant/message", seq: 3, time: 0, data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "b" }] } }, surfaceOp: "append" },
	];
	const events = [...seed];
	let nextSeq = 4;
	const session = {
		id: "s1",
		events,
		surface: { nodes: [1, 3], replaceGeneration: 0 },
		eventAt: eventAtFor(events),
		append(type, data, extra = {}) {
			const event = { type, seq: nextSeq++, time: Date.now(), data, ...extra };
			this.events.push(event);
			if (event.surfaceOp !== undefined) {
				if (event.surfaceOp === "append") {
					this.surface.nodes.push(event.seq);
				} else {
					// The marker's key names moved at 0.1.5; the fake fold accepts both.
					const start = event.surfaceOp.startSeq ?? event.surfaceOp.start;
					const end = event.surfaceOp.endSeq ?? event.surfaceOp.end;
					const startIdx = this.surface.nodes.indexOf(start);
					const endIdx = this.surface.nodes.indexOf(end);
					this.surface.nodes.splice(startIdx, endIdx - startIdx + 1, event.seq);
					this.surface.replaceGeneration += 1;
				}
			}
			return event;
		},
	};
	let landed = 0;
	const cdb = { markCompartmentLanded: () => { landed += 1; } };
	const meter = {
		estimateMessage: () => 25,
		measure: (s) => ({ nodes: s.surface.nodes.map((seq) => ({ seq, tokens: 1 })) }),
	};
	check("framed summary estimate delegates to meter", estimateFramedSummaryTokens(meter, "") === 25);
	const compartment = { id: 9, start_seq: 1, end_seq: 3, summary: "compressed history summary", shadowed_tokens: 100, provider: "deepseek-official", model: "deepseek-v4-flash" };

	const result = await landCompartment({ session, cdb, meter }, compartment, { owner: "current-turn" });
	check("landing result shape", result.compactionId !== undefined && result.summarySeq !== undefined && result.endSeq !== undefined);
	check("landing event order", events.map((e) => e.type).join(",") === "turn/start,user/message,step/start,assistant/message,compaction/start,compaction/summary,user/message,compaction/end");
	const replace = events.find((e) => e.type === "user/message" && e.surfaceOp?.op === "replace");
	// Assert against the HOST's own validator rather than a hardcoded shape, so a
	// future rename fails this test instead of failing every live landing.
	const surface = await import("/home/mon3tr/.dsh/profiles/node_modules/@deepseek-ai/dsh-session/lib/types/surface.js");
	let markerValid = false;
	let markerError;
	try {
		surface.validateSurfaceMetadata(replace);
		markerValid = true;
	} catch (error) {
		markerError = error;
	}
	check("landing replace op accepted by host validator", markerValid ? true : (console.error(`      ${markerError.message}`), false));
	const expectsLegacy = replace.surfaceOp.start !== undefined;
	check(
		"landing replace op uses the installed reader's key names",
		expectsLegacy ? (replace.surfaceOp.end !== undefined) : (replace.surfaceOp.startSeq === 1 && replace.surfaceOp.endSeq === 3),
	);
	check("landing checkpoint source", replace.data.source?.plugin === "compact" && replace.data.source.compactionId === result.compactionId);
	check("landing shadowed price", events.find((e) => e.type === "compaction/summary").data.shadowedTokenCount === 100);
	check("landing surface now one node", session.surface.nodes.length === 1);
	check("landing marked", landed === 1);
	check("landing frame", frameCompartmentSummary("x").includes("<compacted-summary>") && frameCompartmentSummary("x").includes("</compacted-summary>"));

	// manual landing with an open turn must fail busy
	const busyEvents = [...seed];
	const busy = await landCompartment(
		{ session: { ...session, events: busyEvents, surface: { nodes: [1, 3], replaceGeneration: 0 }, eventAt: eventAtFor(busyEvents) }, cdb, meter },
		{ ...compartment, start_seq: 1, end_seq: 3 },
		{ owner: null, signal: new AbortController().signal },
	).then(() => null, (e) => e);
	check("manual landing busy with open turn", busy !== null && busy.code === "busy");

	// span changed (start missing from surface) must fail with SurfaceChangedError
	const changed = await landCompartment(
		{ session: { ...session, events, surface: { nodes: [99], replaceGeneration: 2 }, eventAt: eventAtFor(events) }, cdb, meter },
		compartment,
		{ owner: "current-turn" },
	).then(() => null, (e) => e);
	check("landing span-changed fails", changed !== null && changed.name === "SurfaceChangedError");

	// summary not smaller than shadowed content must fail
	const fat = await landCompartment(
		{ session: { ...session, events, surface: { nodes: [1, 3], replaceGeneration: 3 }, eventAt: eventAtFor(events) }, cdb, meter: { ...meter, estimateMessage: () => 500 } },
		compartment,
		{ owner: "current-turn" },
	).then(() => null, (e) => e);
	check("landing summary-not-smaller fails", fat !== null && fat.message.includes("not smaller"));
}

// ── 0.1.5 system-head protection ────────────────────────────────────────────
{
	const foldSurface = (await import("/home/mon3tr/.dsh/profiles/node_modules/@deepseek-ai/dsh-session/lib/types/surface.js")).foldSurface;
	const seed = [
		{ type: "turn/start", seq: 0, time: 0, data: { turn: 1 } },
		{ type: "step/start", seq: 1, time: 0, data: { turn: 1, step: 1 } },
		{ type: "system/message", seq: 2, time: 0, data: { turn: 1, step: 1, message: { role: "system", content: [{ type: "text", text: "prompt" }] } }, surfaceOp: "append" },
		{ type: "user/message", seq: 3, time: 0, data: { content: [{ type: "text", text: "a" }] }, surfaceOp: "append" },
		{ type: "assistant/message", seq: 4, time: 0, data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "b" }] } }, surfaceOp: "append" },
	];
	const makeSession = (events, nodes, nextSeq) => {
		let seq = nextSeq;
		const session = {
			id: "s-sys",
			events,
			surface: { nodes: [...nodes], replaceGeneration: 0 },
			eventAt: eventAtFor(events),
			append(type, data, extra = {}) {
				const event = { type, seq: seq++, time: Date.now(), data, ...extra };
				this.events.push(event);
				if (event.surfaceOp !== undefined) {
					if (event.surfaceOp === "append") {
						this.surface.nodes.push(event.seq);
					} else {
						const start = event.surfaceOp.startSeq ?? event.surfaceOp.start;
						const end = event.surfaceOp.endSeq ?? event.surfaceOp.end;
						const startIdx = this.surface.nodes.indexOf(start);
						const endIdx = this.surface.nodes.indexOf(end);
						this.surface.nodes.splice(startIdx, endIdx - startIdx + 1, event.seq);
						this.surface.replaceGeneration += 1;
					}
				}
				return event;
			},
		};
		return session;
	};
	const cdb = { markCompartmentLanded: () => {} };
	const meter = {
		estimateMessage: () => 25,
		measure: (s) => ({ nodes: s.surface.nodes.map((seq) => ({ seq, tokens: 1 })) }),
	};

	const events = [...seed];
	const session = makeSession(events, [2, 3, 4], 5);
	const result = await landCompartment(
		{ session, cdb, meter },
		{ id: 1, start_seq: 2, end_seq: 4, summary: "compressed", shadowed_tokens: 100 },
		{ owner: "current-turn" },
	);
	check("system-head landing commits", result.endSeq !== undefined);
	const replace = events.find((e) => e.type === "user/message" && e.surfaceOp?.op === "replace");
	const replaceStart = replace.surfaceOp.startSeq ?? replace.surfaceOp.start;
	check("system-head landing trims node 0 from the replace", replaceStart === 3 && (replace.surfaceOp.endSeq ?? replace.surfaceOp.end) === 4);
	check("system-head stays on the stub surface", session.surface.nodes[0] === 2 && session.surface.nodes.includes(replace.seq));
	let folded;
	let foldError;
	try {
		folded = foldSurface(events);
	} catch (error) {
		foldError = error;
	}
	check(
		"system-head landing is accepted by the host fold",
		foldError === undefined && folded.nodes[0] === 2 && folded.nodes.includes(replace.seq),
	);
	if (foldError !== undefined) console.error(`      ${foldError.message}`);

	// Rewritten system head: stored start names the previous prompt node,
	// which the current node 0 replaced. The conversation span still lands.
	const rewrittenEvents = [
		{ type: "turn/start", seq: 0, time: 0, data: { turn: 1 } },
		{ type: "step/start", seq: 1, time: 0, data: { turn: 1, step: 1 } },
		{ type: "system/message", seq: 2, time: 0, data: { turn: 1, step: 1, message: { role: "system", content: [{ type: "text", text: "old" }] } }, surfaceOp: "append" },
		{ type: "user/message", seq: 3, time: 0, data: { content: [{ type: "text", text: "a" }] }, surfaceOp: "append" },
		{ type: "assistant/message", seq: 4, time: 0, data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "b" }] } }, surfaceOp: "append" },
		{ type: "system/message", seq: 5, time: 0, data: { turn: 1, step: 2, message: { role: "system", content: [{ type: "text", text: "new" }] } }, surfaceOp: { op: "replace", startSeq: 2, endSeq: 2 }, sourceEventSeqs: [2] },
	];
	const rewritten = makeSession(rewrittenEvents, [5, 3, 4], 6);
	const rewrittenResult = await landCompartment(
		{ session: rewritten, cdb, meter },
		{ id: 2, start_seq: 2, end_seq: 4, summary: "compressed", shadowed_tokens: 100 },
		{ owner: "current-turn" },
	).then((value) => ({ value }), (error) => ({ error }));
	check("rewritten system-head landing commits", rewrittenResult.value !== undefined);
	const rewrittenReplace = rewrittenEvents.find((e) => e.type === "user/message" && e.surfaceOp?.op === "replace");
	check(
		"rewritten system-head landing starts at the first conversation node",
		rewrittenReplace !== undefined && (rewrittenReplace.surfaceOp.startSeq ?? rewrittenReplace.surfaceOp.start) === 3,
	);
	let rewrittenFold;
	let rewrittenFoldError;
	try {
		rewrittenFold = foldSurface(rewrittenEvents);
	} catch (error) {
		rewrittenFoldError = error;
	}
	check(
		"rewritten system-head landing is accepted by the host fold",
		rewrittenFoldError === undefined && rewrittenFold.nodes[0] === 5,
	);
	if (rewrittenFoldError !== undefined) console.error(`      ${rewrittenFoldError.message}`);

	// System head + checkpoint chain: a gen-N compartment that incorrectly
	// started at node 0 must not replace the checkpoints.
	const chainedEvents = [
		{ type: "turn/start", seq: 0, time: 0, data: { turn: 1 } },
		{ type: "step/start", seq: 1, time: 0, data: { turn: 1, step: 1 } },
		{ type: "system/message", seq: 2, time: 0, data: { turn: 1, step: 1, message: { role: "system", content: [{ type: "text", text: "prompt" }] } }, surfaceOp: "append" },
		{ type: "user/message", seq: 3, time: 0, data: { content: [{ type: "text", text: "cp" }], source: { kind: "plugin", plugin: "compact", compactionId: "c1" } }, surfaceOp: "append" },
		{ type: "user/message", seq: 4, time: 0, data: { content: [{ type: "text", text: "new" }] }, surfaceOp: "append" },
		{ type: "assistant/message", seq: 5, time: 0, data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "ok" }] } }, surfaceOp: "append" },
	];
	const chainedSession = makeSession(chainedEvents, [2, 3, 4, 5], 6);
	const chainedResult = await landCompartment(
		{ session: chainedSession, cdb, meter },
		{ id: 3, start_seq: 2, end_seq: 5, summary: "compressed", shadowed_tokens: 100 },
		{ owner: "current-turn" },
	).then((value) => ({ value }), (error) => ({ error }));
	check("system+checkpoint landing commits", chainedResult.value !== undefined);
	const chainedReplace = chainedEvents.find((e) => e.type === "user/message" && e.surfaceOp?.op === "replace");
	check(
		"system+checkpoint landing starts after the checkpoint",
		chainedReplace !== undefined && (chainedReplace.surfaceOp.startSeq ?? chainedReplace.surfaceOp.start) === 4,
	);
	check("system+checkpoint landing leaves the checkpoint on the surface", chainedSession.surface.nodes.includes(3) && chainedSession.surface.nodes[0] === 2);
}

if (failed > 0) {
	console.error(`${failed} assertion(s) failed`);
	process.exit(1);
}
console.log("dsh-context landing smoke: OK");

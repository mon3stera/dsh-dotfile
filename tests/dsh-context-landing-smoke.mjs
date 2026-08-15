// dsh-plugin-context landing + range selection smoke test.
import { selectCompartmentRange } from "/home/mon3tr/.dsh/profiles/node_modules/dsh-plugin-context/lib/range.js";
import { landCompartment, frameCompartmentSummary } from "/home/mon3tr/.dsh/profiles/node_modules/dsh-plugin-context/lib/landing.js";

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
	const session = { events, surface };
	let r = selectCompartmentRange(session, { retainRounds: 1 });
	check("retain 1 keeps turn3", r !== null && r.start === 1 && r.end === 8 && r.shadowedSeqs.join(",") === "1,3,6,8");
	r = selectCompartmentRange(session, { retainRounds: 2 });
	check("retain 2 keeps turns 2+3", r !== null && r.start === 1 && r.end === 3 && r.shadowedSeqs.join(",") === "1,3");
	r = selectCompartmentRange(session, { retainRounds: 3 });
	check("retain 3 null", r === null);

	// checkpointed surface: node 16 is a landed checkpoint (head), turns 4+5 follow.
	const events2 = [...events];
	events2.push({ type: "compaction/summary", seq: 15, time: 0, data: {} });
	events2.push({ type: "user/message", seq: 16, time: 0, data: { content: [{ type: "text", text: "cp" }] }, surfaceOp: { op: "replace", start: 1, end: 13 } });
	const nodes2 = [16, 19, 22]; // checkpoint, t4 assistant, t5 assistant
	events2.push({ type: "tool/call", seq: 17, time: 0, data: { callId: "x", name: "bash", arguments: "{}" } });
	events2.push({ type: "step/start", seq: 18, time: 0, data: { turn: 4, step: 1 } });
	events2.push({ type: "assistant/message", seq: 19, time: 0, data: { turn: 4, step: 1, message: { content: [] } }, surfaceOp: "append" });
	events2.push({ type: "turn/end", seq: 20, time: 0, data: { turn: 4, reason: { kind: "completed" } } });
	events2.push({ type: "step/start", seq: 21, time: 0, data: { turn: 5, step: 1 } });
	events2.push({ type: "assistant/message", seq: 22, time: 0, data: { turn: 5, step: 1, message: { content: [] } }, surfaceOp: "append" });
	events2.push({ type: "turn/end", seq: 23, time: 0, data: { turn: 5, reason: { kind: "completed" } } });
	const session2 = { events: events2, surface: { nodes: nodes2, replaceGeneration: 1 } };
	r = selectCompartmentRange(session2, { retainRounds: 2 });
	check("checkpointed retain 2", r !== null && r.start === 16 && r.end === 16);
	r = selectCompartmentRange(session2, { retainRounds: 5 });
	check("checkpointed retain 5 null", r === null);
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
		append(type, data, extra = {}) {
			const event = { type, seq: nextSeq++, time: Date.now(), data, ...extra };
			this.events.push(event);
			if (event.surfaceOp !== undefined) {
				if (event.surfaceOp === "append") {
					this.surface.nodes.push(event.seq);
				} else {
					const startIdx = this.surface.nodes.indexOf(event.surfaceOp.start);
					const endIdx = this.surface.nodes.indexOf(event.surfaceOp.end);
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
	const compartment = { id: 9, start_seq: 1, end_seq: 3, summary: "compressed history summary", shadowed_tokens: 100, provider: "deepseek-official", model: "deepseek-v4-flash" };

	const result = await landCompartment({ session, cdb, meter }, compartment, { owner: "current-turn" });
	check("landing result shape", result.compactionId !== undefined && result.summarySeq !== undefined && result.endSeq !== undefined);
	check("landing event order", events.map((e) => e.type).join(",") === "turn/start,user/message,step/start,assistant/message,compaction/start,compaction/summary,user/message,compaction/end");
	const replace = events.find((e) => e.type === "user/message" && e.surfaceOp?.op === "replace");
	check("landing replace op", replace.surfaceOp.start === 1 && replace.surfaceOp.end === 3);
	check("landing checkpoint source", replace.data.source?.plugin === "compact" && replace.data.source.compactionId === result.compactionId);
	check("landing shadowed price", events.find((e) => e.type === "compaction/summary").data.shadowedTokenCount === 100);
	check("landing surface now one node", session.surface.nodes.length === 1);
	check("landing marked", landed === 1);
	check("landing frame", frameCompartmentSummary("x").includes("<compacted-summary>") && frameCompartmentSummary("x").includes("</compacted-summary>"));

	// manual landing with an open turn must fail busy
	const busyEvents = [...seed];
	const busy = await landCompartment(
		{ session: { ...session, events: busyEvents, surface: { nodes: [1, 3], replaceGeneration: 0 } }, cdb, meter },
		{ ...compartment, start_seq: 1, end_seq: 3 },
		{ owner: null, signal: new AbortController().signal },
	).then(() => null, (e) => e);
	check("manual landing busy with open turn", busy !== null && busy.code === "busy");

	// span changed (start missing from surface) must fail with SurfaceChangedError
	const changed = await landCompartment(
		{ session: { ...session, events, surface: { nodes: [99], replaceGeneration: 2 } }, cdb, meter },
		compartment,
		{ owner: "current-turn" },
	).then(() => null, (e) => e);
	check("landing span-changed fails", changed !== null && changed.name === "SurfaceChangedError");

	// summary not smaller than shadowed content must fail
	const fat = await landCompartment(
		{ session: { ...session, events, surface: { nodes: [1, 3], replaceGeneration: 3 } }, cdb, meter: { ...meter, estimateMessage: () => 500 } },
		compartment,
		{ owner: "current-turn" },
	).then(() => null, (e) => e);
	check("landing summary-not-smaller fails", fat !== null && fat.message.includes("not smaller"));
}

if (failed > 0) {
	console.error(`${failed} assertion(s) failed`);
	process.exit(1);
}
console.log("dsh-context landing smoke: OK");

// dsh-magic-context coordinate rebuild smoke test.
//
// Two behaviours, both against the strongest available evidence:
//   1. A log-shape fixture (always present): rows written in a FORMER event
//      coordinate space are detected, rebuilt into the live numbering, made
//      idempotent, and a ready compartment holding an unreachable span is
//      retired instead of blocking the landing queue.
//   2. A real migrated log, when one is present in the deployment: the rebuild
//      is checked against an actual v0→v3 session (thousands of events, the
//      case that motivated the work), and a real ready compartment is landed on
//      a surface folded by the HOST's own fold, so the produced surfaceOp and
//      the whole landing transaction are validated by the real reader rather
//      than by a stub. Skipped cleanly when no migrated log exists.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const RUNTIME = "/home/mon3tr/.dsh/profiles/node_modules/dsh-magic-context";
const HOST = "/home/mon3tr/.dsh/profiles/node_modules";
const { openDatabase } = await import(`${RUNTIME}/lib/db.js`);
const { CURRENT_FORMAT_VERSION, DEFAULT_RETAIN_RATIO, inspectSessionCoordinates, rebuildSessionCoordinates, replayParagraphs } = await import(`${RUNTIME}/lib/coordinates.js`);
const { landCompartment } = await import(`${RUNTIME}/lib/landing.js`);
const { firstCompactableIndex } = await import(`${RUNTIME}/lib/range.js`);
const { readSessionLog, logGeneration, highestGenerationLogName, parseLogText } = await import(`${RUNTIME}/lib/logs.js`);
const { foldSurface, validateSurfaceMetadata } = await import(`${HOST}/@deepseek-ai/dsh-session/lib/types/surface.js`);
const { createUserMessage } = await import(`${HOST}/@deepseek-ai/dsh-llm/lib/index.js`);
const { toolPairingBalancedAfter, toolPairingBalancedBefore } = await import(`${HOST}/@deepseek-ai/dsh-compaction/lib/index.js`);

let failed = 0;
const check = (label, ok) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
	if (!ok) failed += 1;
};
const skip = (label, why) => console.log(`SKIP ${label} (${why})`);

const root = mkdtempSync(join(tmpdir(), "dsh-context-coords-"));
const home = join(root, "home");
mkdirSync(join(home, "magic-context"), { recursive: true });

/** One session-shaped view over a static event list (the rebuild's needs). */
const sessionView = (id, events) => ({
	id,
	eventAt: (seq) => events[seq],
	events,
	surface: { nodes: [], replaceGeneration: 0 },
});

/** Append events to a log the way the host does: seq continues, surface refolds. */
function appendEvent(events, type, data, extra = {}) {
	const event = { type, seq: events.length, time: Date.now(), data, ...extra };
	validateSurfaceMetadata(event);
	events.push(event);
	return event;
}

/** The landing's own tool-pairing boundary rules, applied to a real folded log. */
const toolBalancedBefore = (session, seq) => {
	try {
		return toolPairingBalancedBefore(session, seq);
	} catch {
		return false;
	}
};
const toolBalancedAfter = (session, seq) => {
	try {
		return toolPairingBalancedAfter(session, seq);
	} catch {
		return false;
	}
};


// ── fixture: the rebuild itself ─────────────────────────────────────────────
{
	const cdb = openDatabase(home);
	// A twelve-turn conversation: enough paragraphs that the old row set is the
	// same order of magnitude, which is what a real former epoch looks like. A
	// postage-stamp log with a huge row set is a DIFFERENT incident (a truncated
	// log) and is covered by the refusal block below.
	const events = [];
	const paragraphSeqs = [];
	for (let turn = 1; turn <= 12; turn += 1) {
		events.push({ type: "turn/start", seq: events.length, time: events.length, data: { turn } });
		paragraphSeqs.push(events.length);
		appendEvent(events, "user/message", { content: [{ type: "text", text: `question ${turn}` }] }, { surfaceOp: "append" });
		paragraphSeqs.push(events.length);
		appendEvent(events, "assistant/message", { turn, step: 1, message: { content: [{ type: "text", text: `answer ${turn}` }] } }, { surfaceOp: "append" });
		events.push({ type: "turn/end", seq: events.length, time: events.length, data: { turn, reason: { kind: "completed" } } });
	}
	const excludedCallSeq = events.length;
	appendEvent(events, "assistant/message", { turn: 12, step: 2, message: { content: [{ type: "tool-call", callId: "c1", name: "ctx_reduce", arguments: "{}" }] } }, { surfaceOp: "append" });
	events.push({ type: "tool/call", seq: excludedCallSeq + 1, time: events.length, data: { callId: "c1", name: "ctx_reduce", arguments: "{}" } });
	appendEvent(events, "tool/result", { callId: "c1", message: createUserMessage({ content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "shrunk" }] }] }) }, { surfaceOp: "append" });
	const excludedResultSeq = events.length - 1;
	const id = "session-fixture-0001";
	const session = sessionView(id, events);
	// Former epoch: the same conversation at old coordinates. The row count stays
	// comparable (24 vs the replay's 24), and two rows collide with live seqs —
	// which is what makes a stale row worse than a missing one, because
	// paragraphFor answers with the wrong paragraph instead of nothing.
	const seeded = [];
	for (let index = 0; index < 22; index += 1) seeded.push({ seq: 400000 + index, paragraph_no: index + 1 });
	seeded.push({ seq: paragraphSeqs[0], paragraph_no: 23 });
	seeded.push({ seq: paragraphSeqs[paragraphSeqs.length - 1], paragraph_no: 24 });
	cdb.replaceSessionCoordinates(id, seeded);
	const before = inspectSessionCoordinates(cdb, session);
	check("former-epoch rows are detected", before.state === "stale");
	check("former-epoch max seq is reported", before.maxStoredSeq === 400021);
	check("live max seq is reported", before.maxLiveSeq === events.length - 1);
	check("stale rows collide with live seqs", cdb.paragraphFor(id, paragraphSeqs[0]) === 23);

	const expected = replayParagraphs(session);
	const dry = rebuildSessionCoordinates(cdb, session, { dryRun: true });
	check("dry run writes nothing", dry.applied === false && cdb.paragraphFor(id, paragraphSeqs[0]) === 23);
	check("dry run reports the intended change", dry.previousRows === seeded.length && dry.rows === expected.length);

	const summary = rebuildSessionCoordinates(cdb, session);
	check("rebuild applies", summary.applied === true && summary.changed === true);
	check("rebuild replaced every row", cdb.sessionParagraphs(id).length === expected.length);
	const rows = cdb.sessionParagraphs(id);
	check("rebuild numbering is 1..N in live seq order", rows.every((row, index) => row.paragraph_no === index + 1 && (index === 0 || row.seq > rows[index - 1].seq)));
	check("excluded tool call is not numbered", cdb.paragraphFor(id, excludedCallSeq) === undefined);
	check("excluded tool result is not numbered", cdb.paragraphFor(id, excludedResultSeq) === undefined);
	check("colliding stale row is gone", cdb.paragraphFor(id, paragraphSeqs[0]) === 1);
	check("replay matches the stored rows", JSON.stringify(expected) === JSON.stringify(rows));

	const second = rebuildSessionCoordinates(cdb, session);
	check("second rebuild is skipped", second.skipped === true && second.applied === false);
	check("epoch is stamped", inspectSessionCoordinates(cdb, session).state === "current" && cdb.sessionEpoch(id).formatVersion === CURRENT_FORMAT_VERSION);
	check("rows unchanged by the second call", JSON.stringify(cdb.sessionParagraphs(id)) === JSON.stringify(rows));

	// Skip marks follow the rebuilt numbering by seq.
	const markedSeq = paragraphSeqs[3];
	const markedParagraph = cdb.paragraphFor(id, markedSeq);
	cdb.markSkip(id, markedSeq, markedParagraph);
	const forced = rebuildSessionCoordinates(cdb, session, { force: true });
	const marked = cdb.db.prepare("SELECT paragraph_no FROM skip_marks WHERE session_id = ? AND seq = ?").get(id, markedSeq);
	check("skip mark remapped", forced.applied === true && marked.paragraph_no === cdb.paragraphFor(id, markedSeq));
	cdb.markSkip(id, 424242, 1);
	rebuildSessionCoordinates(cdb, session, { force: true });
	check("skip mark for a dead seq is dropped", cdb.db.prepare("SELECT COUNT(*) AS n FROM skip_marks WHERE session_id = ?").get(id).n === 1);
	check("row count survived every rebuild", cdb.sessionParagraphs(id).length === rows.length);

	// The truncation guard: a tiny log must not wipe a large numbering.
	const damagedId = "session-fixture-damaged";
	const damagedEvents = [{ type: "turn/start", seq: 0, time: 1, data: { turn: 1 } }];
	const damaged = sessionView(damagedId, damagedEvents);
	const many = [];
	for (let index = 0; index < 400; index += 1) many.push({ seq: 9000 + index, paragraph_no: index + 1 });
	cdb.replaceSessionCoordinates(damagedId, many);
	const refused = rebuildSessionCoordinates(cdb, damaged);
	check("truncated log is refused, not rebuilt", refused.refused === true && refused.applied === false);
	check("refusal keeps the stored rows", cdb.sessionParagraphs(damagedId).length === 400);
	check("refusal states the reason", typeof refused.reason === "string" && refused.reason.includes("truncated"));
	check("retain ratio is a fraction between 0 and 1", DEFAULT_RETAIN_RATIO > 0 && DEFAULT_RETAIN_RATIO < 1);
	const forcedThrough = rebuildSessionCoordinates(cdb, damaged, { force: true });
	check("--force overrides the guard", forcedThrough.applied === true && cdb.sessionParagraphs(damagedId).length === 0);
	cdb.close();
}

// ── fixture: stale ready compartments leave the queue ───────────────────────
{
	const home2 = join(root, "home-retire");
	mkdirSync(join(home2, "magic-context"), { recursive: true });
	const cdb = openDatabase(home2);
	const events = [];
	events.push({ type: "turn/start", seq: 0, time: 1, data: { turn: 1 } });
	appendEvent(events, "user/message", { content: [{ type: "text", text: "hi" }] }, { surfaceOp: "append" });
	const id = "session-fixture-0002";
	const session = sessionView(id, events);
	cdb.replaceSessionCoordinates(id, [{ seq: 400000, paragraph_no: 1 }]);
	const staleId = cdb.insertCompartment({ sessionId: id, generation: 1, startSeq: 400000, endSeq: 400010, startPara: 1, endPara: 2, summary: "old", shadowedTokens: 100 });
	const liveId = cdb.insertCompartment({ sessionId: id, generation: 0, startSeq: 0, endSeq: 0, startPara: 1, endPara: 1, summary: "live", shadowedTokens: 100 });
	cdb.setCompartmentSummary(staleId, { summary: "old" });
	cdb.setCompartmentSummary(liveId, { summary: "live" });
	check("both compartments are ready before the rebuild", cdb.readyCompartments(id).length === 2);
	const summary = rebuildSessionCoordinates(cdb, session);
	check("only the unreachable compartment is retired", summary.retired.join(",") === String(staleId));
	check("the retired row leaves the ready queue", cdb.readyCompartments(id).map((c) => c.id).join(",") === String(liveId));
	check("retirement is durable and explained", cdb.compartmentById(staleId).stale === 1 && cdb.compartmentById(staleId).error.includes("pre-migration"));
	check("the live compartment is untouched", cdb.compartmentById(liveId).stale === 0 && cdb.compartmentById(liveId).status === "ready");
	cdb.close();
}

// ── real data: a migrated session from this deployment ──────────────────────
{
	const sessionsRoot = join(process.env.DSH_HOME ?? join(process.env.HOME ?? "/home/mon3tr", ".dsh"), "sessions");
	const migrated = findMigratedLog(sessionsRoot);
	if (migrated === null) {
		skip("real migrated log", "no session.v*.jsonl.zstd in this deployment");
	} else {
		await verifyRealSession(migrated, join(root, "home-real"));
	}
}

/** Highest-generation log for the largest migrated session in the store. */
function findMigratedLog(sessionsRoot) {
	if (!existsSync(sessionsRoot)) return null;
	let best = null;
	for (const project of readdirSync(sessionsRoot)) {
		const projectDir = join(sessionsRoot, project);
		let entries;
		try {
			entries = readdirSync(projectDir);
		} catch {
			continue;
		}
		for (const entry of entries) {
			const dir = join(projectDir, entry);
			let name;
			try {
				if (!statSync(dir).isDirectory()) continue;
				name = highestGenerationLogName(dir);
			} catch {
				continue;
			}
			if (name === null || logGeneration(name) === 0) continue;
			let size = 0;
			try {
				size = statSync(join(dir, name)).size;
			} catch {
				continue;
			}
			if (best === null || size > best.size) best = { dir, sessionId: entry, size };
		}
	}
	return best;
}

/** Rebuild + land one real session entirely on the host's own reader. */
async function verifyRealSession(fixture, homeDir) {
	mkdirSync(join(homeDir, "magic-context"), { recursive: true });
	const log = readSessionLog(fixture.dir);
	console.log(`     fixture: ${fixture.sessionId} v${log.generation}, ${log.events.length} events`);
	const cdb = openDatabase(homeDir);
	const session = sessionView(fixture.sessionId, log.events);
	const before = inspectSessionCoordinates(cdb, session);
	const summary = rebuildSessionCoordinates(cdb, session);
	check("real session: rebuild applied", summary.applied === true);
	check("real session: every stored seq names a live event", cdb.sessionParagraphs(fixture.sessionId).every((row) => row.seq >= 0 && row.seq < log.events.length));
	check(
		"real session: every live conversation node has a paragraph number",
		foldSurface(log.events).nodes.every((seq) => log.events[seq]?.type === "system/message" || cdb.paragraphFor(fixture.sessionId, seq) !== undefined),
	);
	check("real session: second rebuild is a no-op", rebuildSessionCoordinates(cdb, session).skipped === true);
	console.log(`     ${before.state}: ${summary.previousRows} -> ${summary.rows} paragraph rows, retired ${summary.retired.length}`);

	// Land a REAL compartment span of this log. If the session still has its own
	// ready row stored, use it (it carries the exact span and summary the
	// deployment generated); otherwise synthesise one over a live-coordinate
	// span, so the landing path is always exercised on real events.
	const liveEvents = log.events.slice();
	// Automatic landing must run inside an open turn; the stored log ends between
	// turns, so open one exactly as the host would.
	const openTurn = Number.isSafeInteger(liveEvents.at(-1)?.data?.turn) ? liveEvents.at(-1).data.turn + 1 : 1;
	appendEvent(liveEvents, "turn/start", { turn: openTurn });
	const appending = {
		id: fixture.sessionId,
		events: liveEvents,
		eventAt: (seq) => liveEvents[seq],
		surface: { nodes: [], replaceGeneration: 0 },
		append(type, data, extra = {}) {
			return appendEvent(liveEvents, type, data, extra);
		},
	};
	appending.surface.nodes = foldSurface(liveEvents).nodes;
	const ready = cdb.readyCompartments(fixture.sessionId);
	let compartment = ready[0];
	if (compartment === undefined) {
		// A span the landing itself would accept: after the protected system
		// head and the contiguous checkpoint chain, with balanced tool pairing
		// on both ends. Index 1 is often a checkpoint on a 0.1.5 surface
		// (`[system][C1]…`), and landing would then trim past a 1-node span.
		const nodes = appending.surface.nodes;
		const compactFrom = firstCompactableIndex(appending);
		let start;
		let end;
		for (let index = compactFrom; index < nodes.length - 1 && start === undefined; index += 1) {
			if (!toolBalancedBefore(appending, nodes[index])) continue;
			for (let other = index; other < nodes.length - 1; other += 1) {
				if (!toolBalancedAfter(appending, nodes[other])) continue;
				start = nodes[index];
				end = nodes[other];
				break;
			}
		}
		if (start === undefined) {
			skip("real session: live landing", "no tool-balanced inner span in this log");
			cdb.close();
			return;
		}
		compartment = {
			id: cdb.insertCompartment({
				sessionId: fixture.sessionId,
				generation: 99,
				startSeq: start,
				endSeq: end,
				startPara: cdb.paragraphFor(fixture.sessionId, start) ?? 0,
				endPara: cdb.paragraphFor(fixture.sessionId, end) ?? 0,
				summary: "smoke: condensed middle of the real session log",
				shadowedTokens: 500,
			}),
			start_seq: start,
			end_seq: end,
			shadowed_tokens: 500,
			summary: "smoke: condensed middle of the real session log",
		};
		cdb.setCompartmentSummary(compartment.id, { summary: compartment.summary });
		console.log(`     synthesized ready compartment ${compartment.id} over seq ${start}-${end} of ${nodes.length} surface nodes`);
	}
	const meter = {
		estimateMessage: () => 10,
		measure: (s) => ({ nodes: s.surface.nodes.map((seq) => ({ seq, tokens: 1 })) }),
	};
	const result = await landCompartment({ session: appending, cdb, meter }, compartment, { owner: "current-turn" }).then(
		(value) => ({ value }),
		(error) => ({ error }),
	);
	if (result.error !== undefined) {
		check(`real session: live landing committed for compartment ${compartment.id}`, false);
		const cause = result.error.cause;
		console.log(`     ${result.error.name}: ${result.error.message}${cause instanceof Error ? ` (${cause.message})` : ""}`);
		cdb.close();
		return;
	}
	check("real session: live landing committed", result.value.endSeq !== undefined);
	// The replacement this landing just appended sits between summary and end.
	const replacement = liveEvents.find((event) => event.type === "user/message" && event.surfaceOp?.op === "replace" && event.seq > result.value.summarySeq && event.seq < result.value.endSeq);
	let validated = false;
	let error;
	try {
		validateSurfaceMetadata(replacement);
		validated = true;
	} catch (cause) {
		error = cause;
	}
	check(`real session: replacement accepted by the host validator${validated ? "" : ` (${error?.message})`}`, validated);
	check("real session: replacement replaced the stored span", foldSurface(liveEvents).nodes.includes(replacement.seq));
	check("real session: compartment recorded as landed", cdb.compartmentById(compartment.id).status === "landed");
	// The committed log must still satisfy the host's surface rules end to end.
	const folded = foldSurface(liveEvents);
	check("real session: the whole log still folds after the landing", folded.nodes.length > 0 && folded.nodes.includes(replacement.seq));
	cdb.close();
}

rmSync(root, { recursive: true, force: true });
if (failed > 0) {
	console.error(`${failed} assertion(s) failed`);
	process.exit(1);
}
console.log("dsh-context coordinates smoke: OK");

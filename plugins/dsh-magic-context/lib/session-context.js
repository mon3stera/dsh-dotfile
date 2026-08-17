// Bounded, read-only projections of original session records for Dreamer.
// The source session remains the durable authority; this module only formats a
// capped slice for an auxiliary model call.

export const DEFAULT_SESSION_CONTEXT_MAX_EVENTS = 48;
export const DEFAULT_SESSION_CONTEXT_MAX_CHARS = 24000;

function integerOr(value, fallback) {
	return Number.isSafeInteger(value) ? value : fallback;
}

/** Capture the current turn as provenance for a direct ctx_memory write. */
export function currentSessionSource(session) {
	const events = session?.events;
	if (!Array.isArray(events) || typeof session?.id !== "string" || session.id.length === 0) return {};
	const last = events.at(-1);
	const endSeq = last?.seq;
	if (!Number.isSafeInteger(endSeq)) return { sourceSessionId: session.id };
	const start = events.findLast((event) => event?.type === "turn/start");
	return {
		sourceSessionId: session.id,
		sourceStartSeq: Number.isSafeInteger(start?.seq) ? start.seq : endSeq,
		sourceEndSeq: endSeq,
	};
}

function projectEvent(session, event) {
	const record = { seq: event.seq, type: event.type };
	if (typeof event.time === "number") record.time = event.time;
	const data = event.data ?? {};
	if (data.turn !== undefined) record.turn = data.turn;
	if (data.step !== undefined) record.step = data.step;
	if (data.source !== undefined) record.source = data.source;
	if (event.type === "tool/call") {
		record.toolCall = { callId: data.callId, name: data.name };
	}
	try {
		const message = session.deriveEventMessage(event);
		if (message !== null && message !== undefined) record.message = message;
	} catch {
		// A malformed historical event should not make the whole context unreadable.
	}
	return record;
}

/** Return a capped, model-readable event slice from one live session. */
export function readSessionContext(session, { startSeq, endSeq, maxEvents = DEFAULT_SESSION_CONTEXT_MAX_EVENTS, maxChars = DEFAULT_SESSION_CONTEXT_MAX_CHARS } = {}) {
	const events = session?.events;
	if (!Array.isArray(events)) throw new Error("session has no readable event log");
	const lastSeq = events.at(-1)?.seq ?? -1;
	const first = integerOr(startSeq, 0);
	const last = integerOr(endSeq, lastSeq);
	const eventLimit = Math.max(1, Math.min(100, integerOr(maxEvents, DEFAULT_SESSION_CONTEXT_MAX_EVENTS)));
	const charLimit = Math.max(1000, Math.min(64000, integerOr(maxChars, DEFAULT_SESSION_CONTEXT_MAX_CHARS)));
	const candidates = events.filter((event) => Number.isSafeInteger(event?.seq) && event.seq >= first && event.seq <= last);
	const selected = candidates.length > eventLimit ? candidates.slice(-eventLimit) : candidates;
	const records = [];
	let usedChars = 2;
	let truncated = selected.length < candidates.length;
	for (const event of selected) {
		const record = projectEvent(session, event);
		const encoded = JSON.stringify(record);
		if (usedChars + encoded.length > charLimit) {
			truncated = true;
			break;
		}
		records.push(record);
		usedChars += encoded.length + 1;
	}
	return {
		sessionId: session.id,
		requestedRange: { startSeq: first, endSeq: last },
		returnedRange: records.length === 0 ? null : { startSeq: records[0].seq, endSeq: records.at(-1).seq },
		events: records,
		truncated,
	};
}

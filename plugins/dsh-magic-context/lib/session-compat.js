/**
 * 0.1.2 session-log compat: `Session.events` (the materialized event list) was
 * removed from the Session face; the durable log is read through
 * `session.eventAt(seq)` instead. These helpers support both shapes so the
 * plugin works across the update boundary.
 */

/** Read one event by seq: `eventAt(seq)` on 0.1.2+, index/key access before. */
export function sessionEventAt(session, seq) {
	if (typeof session?.eventAt === "function") return session.eventAt(seq);
	return session?.events?.[seq];
}

/** Number of events in the durable log. */
export function sessionEventCount(session) {
	if (Array.isArray(session?.events)) return session.events.length;
	if (typeof session?.eventAt !== "function") return 0;
	let count = 0;
	while (sessionEventAt(session, count) !== undefined) count += 1;
	return count;
}

/** Materialize the full event list (callers that scan or slice). */
export function sessionEvents(session) {
	if (Array.isArray(session?.events)) return session.events;
	const list = [];
	const count = sessionEventCount(session);
	for (let seq = 0; seq < count; seq += 1) list.push(sessionEventAt(session, seq));
	return list;
}

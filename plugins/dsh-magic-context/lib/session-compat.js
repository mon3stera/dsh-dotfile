/**
 * Session-log compat across the 0.1.2 -> 0.1.5 boundary.
 *
 * Two seams moved. First, `Session.events` (the materialized event list) was
 * removed from the Session face; the durable log is read through
 * `session.eventAt(seq)` instead. Second, the positional replacement marker
 * was renamed: 0.1.2 read `{ op: "replace", start, end }` and 0.1.5 validates
 * exactly `{ op: "replace", startSeq, endSeq }` (`isReplaceOp` in
 * `@deepseek-ai/dsh-session`), so a log written with the old keys is rejected
 * with `session event "user/message" carries an invalid replace surfaceOp` and
 * every landing fails. `replaceSurfaceOp` probes the installed reader instead
 * of assuming one shape.
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

/** Legacy (pre-0.1.5) and current positional-replacement key names. */
export const REPLACE_OP_SHAPES = {
	legacy: ["start", "end"],
	current: ["startSeq", "endSeq"],
};

/** The surface metadata validator the reader itself uses — the only authority. */
async function loadSurfaceValidator() {
	try {
		const surface = await import("@deepseek-ai/dsh-session/surface");
		const validate = surface?.validateSurfaceMetadata;
		return typeof validate === "function" ? validate : undefined;
	} catch {
		// A build without the `./surface` subpath: the caller falls back.
		return undefined;
	}
}

let replaceShapeSource;
let replaceShapePromise;

/**
 * Decide which replace key names the installed reader accepts. A validator that
 * takes exactly one of the two candidate encodings is decisive; anything else
 * (no subpath, both accepted, neither accepted — a different validator, not a
 * rename) keeps the legacy names, which is what 0.1.2 wrote. A validator that
 * throws for an unrelated reason also lands here: guessing is not worth an
 * exception escaping into a landing transaction.
 * @param source - validator loader; defaults to the installed `./surface`.
 * @returns "legacy" | "current"
 */
export async function probeReplaceOpShape(source) {
	let validate;
	try {
		validate = await (source ?? loadSurfaceValidator)();
	} catch {
		return "legacy";
	}
	if (typeof validate !== "function") return "legacy";
	const accepts = (keys) => {
		try {
			validate({ type: "user/message", seq: 1, surfaceOp: { op: "replace", [keys[0]]: 0, [keys[1]]: 0 } });
			return true;
		} catch {
			return false;
		}
	};
	const legacyAccepted = accepts(REPLACE_OP_SHAPES.legacy);
	const currentAccepted = accepts(REPLACE_OP_SHAPES.current);
	if (legacyAccepted === currentAccepted) return "legacy";
	return currentAccepted ? "current" : "legacy";
}

/** Override the surfaced-validator source (tests only; no argument resets). */
export function setSurfaceValidatorSourceForTesting(source) {
	replaceShapeSource = source;
	replaceShapePromise = undefined;
}

/**
 * Warm the memoized probe (never throws, safe to call at engine construction).
 * The probe loads a module, so doing it here keeps the first landing from paying
 * for it inside the compaction transaction.
 */
export function warmReplaceSurfaceOpProbe() {
	return replaceSurfaceOp(0, 0).catch(() => undefined);
}

/**
 * Build the positional-replacement marker in the installed reader's own key
 * names. Async because the first call probes the reader; the shape is memoized
 * afterwards. Getting this wrong is fatal rather than degraded: the session log
 * refuses to fold back (0.1.2's reader resolves `node.start`, 0.1.5's reads
 * `startSeq`), so there is no safe runtime recovery from a bad guess.
 * @returns the surfaceOp marker for one replacement span.
 */
export function replaceSurfaceOp(start, end) {
	if (replaceShapePromise === undefined) {
		replaceShapePromise = probeReplaceOpShape(replaceShapeSource);
	}
	return replaceShapePromise.then((shape) => {
		const [startKey, endKey] = REPLACE_OP_SHAPES[shape];
		return { op: "replace", [startKey]: start, [endKey]: end };
	});
}

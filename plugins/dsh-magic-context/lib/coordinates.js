// Coordinate reconstruction for dsh-magic-context.
//
// The 0.1.5 migration rewrites a stored v0 session log into v3: the
// `assistant/chunk` event stream is folded away (the v2→v3 edge) and synthetic
// `system/message` rows are inserted, so every event is RENUMBERED. Nothing in
// the plugin rewrites the log itself, so the seq-keyed rows in the context
// database (`paragraphs`, `skip_marks`) stay in a coordinate space that no
// longer exists. Reading them back is silently wrong, not visibly broken:
// `paragraphFor(sessionId, seq)` matches a live seq against a stale row
// whenever the two spaces overlap, so the §N§ prefix lands on the wrong
// message and `ctx_expand` resolves the wrong paragraph, while `range.js`
// keeps producing live-coordinate compartments.
//
// Why this REBUILDS rather than remaps: the old numbering cannot be translated.
// Measured on the live store (see docs/dsh-015-upgrade-handoff.md §B): a
// session's `paragraphs` rows split into a pre-migration head run (old seqs,
// old paragraph numbers) and a post-migration tail run (live seqs, paragraph
// numbers that continued the old counter), and the tail's paragraph numbers do
// NOT line up with the live replay's rank at any constant offset. The paragraph
// numbering is a monotonic utterance counter, not a durable identity, so the
// rebuild discards it and renumbers the live log from 1 — a coherent mapping is
// worth more than a partial one. `compartments`/`memories` cite old seqs too
// and cannot be recovered either; they are deliberately left untouched because
// only a `ready` compartment consumes those columns (via landing), where a
// stale span fails as an ordinary `SurfaceChangedError` instead of a fatal
// error. See `docs/session-repair.md` for the log side of the same migration.
import { createParagraphAssigner } from "./paragraphs.js";
import { sessionEvents } from "./session-compat.js";

/**
 * Format version of the migrated, chunk-free log. Bump only alongside a log
 * format change that renumbers events again.
 */
export const CURRENT_FORMAT_VERSION = 3;

/**
 * Minimum share of a session's stored paragraph rows a rebuild must retain.
 *
 * A migration folds the `assistant/chunk` stream away, so the replay is
 * legitimately smaller than the stored numbering — but not by an order of
 * magnitude: the observed migrated sessions retain 52% and 95% of their rows,
 * while a damaged 5-event log claiming 2308 rows retains 0.05%. Half is the
 * deliberately loose line between "folded" and "truncated".
 */
export const DEFAULT_RETAIN_RATIO = 0.5;

/**
 * Replay the paragraph assignment rules over one live session and return the
 * session's paragraphs in model order.
 *
 * This is the same walk the engine performs at session start, but with the
 * numbers being recomputed instead of looked up: a fresh counter assigns
 * 1..N in event order. Assignment is keyed on event seq, so a log with
 * contiguous seqs yields exactly one row per paragraph, and replaying the same
 * log twice yields the same rows (the rebuild is idempotent by construction).
 * @param session - live session (reads `sessionEvents`).
 * @returns [{ seq, paragraph_no }] in ascending seq order.
 */
export function replayParagraphs(session) {
	const rows = [];
	const assign = createParagraphAssigner({ assignParagraph: (_sessionId, seq) => { rows.push({ seq, paragraph_no: rows.length + 1 }); } });
	for (const event of sessionEvents(session)) assign(session, event);
	return rows;
}

/**
 * Decide whether one session's stored rows still live in the current event
 * coordinate space.
 *
 * An epoch marker is the fast path. Without one, stored rows are untrustworthy
 * by construction: they were written before the migration, and the migration
 * renumbers every event (chunk removal plus synthetic inserts), so no stored
 * seq can be assumed to name the same event. The `maxStoredSeq`/`maxLiveSeq`
 * comparison is kept as the human-readable evidence in the report; it is not
 * what decides.
 * @param cdb - context database.
 * @param session - live session.
 * @returns { state: "current" | "stale" | "empty", epoch, maxStoredSeq, maxLiveSeq, eventCount }
 */
export function inspectSessionCoordinates(cdb, session) {
	const eventCount = sessionEvents(session).length;
	const epoch = cdb.sessionEpoch(session.id);
	const maxStoredSeq = cdb.maxStoredSeq(session.id);
	const maxLiveSeq = eventCount - 1;
	const detail = { epoch, maxStoredSeq, maxLiveSeq, eventCount };
	if (epoch !== undefined && epoch.formatVersion === CURRENT_FORMAT_VERSION) return { state: "current", ...detail };
	if (maxStoredSeq < 0) return { state: "empty", ...detail };
	return { state: "stale", ...detail };
}

/**
 * Retire ready compartments whose stored span the live log can never satisfy.
 *
 * A ready compartment is the only row that consumes stored seq coordinates
 * (landing validates the span against the live surface), so one generated in a
 * pre-migration space sits at the head of the landing queue forever: it throws
 * on every 80% landing attempt and, because generation is skipped while a ready
 * compartment exists, it also blocks fresh compactions. Retiring it is what lets
 * the session heal itself. A live-coordinate row is never touched — the log
 * length is the whole test.
 * @param cdb - context database.
 * @param session - live session.
 * @returns the ids retired.
 */
export function retireStaleReadyCompartments(cdb, session) {
	const eventCount = sessionEvents(session).length;
	const stale = cdb.staleReadyCompartments(session.id, eventCount);
	for (const compartment of stale) {
		cdb.markCompartmentStale(
			compartment.id,
			`generated in a pre-migration coordinate space: span ${compartment.start_seq}-${compartment.end_seq} is past the end of the current log (${eventCount} events)`
		);
	}
	return stale.map((compartment) => compartment.id);
}

/**
 * Rebuild one session's coordinate rows from its live log and stamp the epoch.
 *
 * Idempotent: a session already marked at the current format version is left
 * alone unless `force`, and a rebuild always recomputes the same rows from the
 * log. Never call this while the session is being written — run it at session
 * start (`agent/session-start`) or offline through
 * `scripts/rebuild-coordinates.mjs`, and back the database up first (the script
 * does).
 *
 * `retainRatio` is the guard against rebuilding on a truncated log: a session
 * whose log is 5 events long but whose rows claim 2300 paragraphs (a real case
 * in this store) is a damaged log, not a stale coordinate space, and rebuilding
 * it would delete the only copy of that numbering. Below the ratio the rebuild
 * is refused and reported instead.
 * @param cdb - context database.
 * @param session - live session whose events define the numbering.
 * @param opts - { formatVersion?, force?, dryRun?, retainRatio? }.
 * @returns a summary of what was (or would be) written.
 */
export function rebuildSessionCoordinates(cdb, session, opts = {}) {
	const { formatVersion = CURRENT_FORMAT_VERSION, force = false, dryRun = false, retainRatio = DEFAULT_RETAIN_RATIO } = opts;
	const inspected = inspectSessionCoordinates(cdb, session);
	const summary = {
		sessionId: session.id,
		formatVersion,
		events: inspected.eventCount,
		maxStoredSeq: inspected.maxStoredSeq,
		maxLiveSeq: inspected.maxLiveSeq,
		previousRows: 0,
		rows: 0,
		changed: false,
		applied: false,
		skipped: false,
		refused: false,
		retired: [],
		reason: inspected.state,
	};
	if (inspected.state === "current" && !force) {
		summary.skipped = true;
		return summary;
	}
	const rows = replayParagraphs(session);
	summary.previousRows = inspected.maxStoredSeq < 0 ? 0 : cdb.sessionParagraphs(session.id).length;
	summary.rows = rows.length;
	summary.changed = summary.previousRows !== rows.length || inspected.state !== "current";
	if (!force && summary.previousRows > 0 && rows.length < summary.previousRows * retainRatio) {
		summary.refused = true;
		summary.reason = `rebuild would delete ${summary.previousRows - rows.length} of ${summary.previousRows} stored paragraph rows (${summary.events} events in the log) — the log looks truncated, not renumbered`;
		return summary;
	}
	if (dryRun) return summary;
	const written = cdb.replaceSessionCoordinates(session.id, rows);
	cdb.markSessionEpoch(session.id, { formatVersion, events: inspected.eventCount });
	summary.applied = true;
	summary.changed = true;
	summary.skipMarks = written.skipMarks;
	summary.retired = retireStaleReadyCompartments(cdb, session);
	return summary;
}

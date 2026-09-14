#!/usr/bin/env node
/**
 * Offline coordinate rebuild for dsh-magic-context.
 *
 * A DSH format migration renumbers every event (the v2→v3 edge folds the
 * assistant/chunk stream away and inserts synthetic system messages), so the
 * seq-keyed rows in the context database stop naming the events they were
 * written for. The engine rebuilds them lazily on `agent/session-start`, but
 * only for sessions that are actually resumed; sessions that already migrated
 * keep their stale rows until something reads them. This entry does the same
 * rebuild for a named set of sessions without a running DSH, and is the only
 * supported way to touch the database offline.
 *
 * Run it against the installed copy so plugin dependencies resolve:
 *
 *   node ~/.dsh/profiles/node_modules/dsh-magic-context/scripts/rebuild-coordinates.mjs \
 *     [--dry-run] [--force] [all | <sessionId> ...]
 *
 * With no session ids it processes every session directory that has a stored
 * coordinate epoch mismatch (see lib/coordinates.js). The database is copied
 * with `VACUUM INTO` before the first write; a dry run writes nothing at all.
 * A session whose log is too short to account for its stored rows is refused
 * (not rebuilt) — see DEFAULT_RETAIN_RATIO in lib/coordinates.js.
 *
 * Safety: never run this while DSH is writing one of the target sessions — the
 * rebuild reads the log and rewrites the database, so a concurrent append would
 * land outside the rebuilt numbering. Prefer the per-session rebuild at session
 * start, which happens before the engine's own replay. Back up anyway.
 *
 * @module dsh-magic-context/scripts/rebuild-coordinates
 */
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { openDatabase } from "../lib/db.js";
import { CURRENT_FORMAT_VERSION, inspectSessionCoordinates, rebuildSessionCoordinates, replayParagraphs } from "../lib/coordinates.js";
import { readSessionLog } from "../lib/logs.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const force = args.includes("--force");
const targets = args.filter((arg) => !arg.startsWith("--"));
if (args.some((arg) => arg.startsWith("--") && arg !== "--dry-run" && arg !== "--force")) {
	console.error("usage: rebuild-coordinates.mjs [--dry-run] [--force] [all | <sessionId> ...]");
	process.exit(2);
}

const home = resolveDshHome();
const sessionsRoot = join(home, "sessions");
const dbPath = join(home, "magic-context", "context.db");
const backups = join(home, "magic-context", "backups");

/** Every session directory in the store, with its project. */
function listSessionDirs() {
	const out = [];
	let projects;
	try {
		projects = readdirSync(sessionsRoot);
	} catch {
		return out;
	}
	for (const project of projects) {
		const projectDir = join(sessionsRoot, project);
		let entries;
		try {
			entries = readdirSync(projectDir);
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.startsWith("session-")) continue;
			const dir = join(projectDir, entry);
			try {
				if (statSync(dir).isDirectory()) out.push({ project, sessionId: entry, dir });
			} catch {
				// vanished
			}
		}
	}
	return out;
}

/** One session-shaped view of a log, as the rebuild expects it. */
function sessionView(sessionId, events) {
	return {
		id: sessionId,
		eventAt: (seq) => events[seq],
		events,
		surface: { nodes: [], replaceGeneration: 0 },
	};
}

const explicit = targets.length > 0 && targets[0] !== "all";
const requested = new Set(targets.filter((target) => target !== "all"));
const candidates = listSessionDirs().filter((entry) => (explicit ? requested.has(entry.sessionId) : true));

const cdb = openDatabase(home);
let backupsMade = 0;
const report = [];

try {
	for (const entry of candidates) {
		let log;
		try {
			log = readSessionLog(entry.dir);
		} catch (error) {
			report.push({ sessionId: entry.sessionId, project: entry.project, status: "unreadable", error: String(error?.message ?? error) });
			continue;
		}
		const events = log.events;
		const session = sessionView(entry.sessionId, events);
		const inspected = inspectSessionCoordinates(cdb, session);
		if (!force && inspected.state === "current") continue;
		if (inspected.state === "empty") {
			if (!dryRun) cdb.markSessionEpoch(entry.sessionId, { formatVersion: CURRENT_FORMAT_VERSION, events: events.length });
			report.push({ sessionId: entry.sessionId, project: entry.project, status: "empty", events: events.length, generation: log.generation });
			continue;
		}
		// One backup per run, taken immediately before the first write.
		if (!dryRun && backupsMade === 0) {
			mkdirSync(backups, { recursive: true });
			const backupPath = join(backups, `context-${Date.now()}.db`);
			cdb.db.prepare(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`).run();
			backupsMade += 1;
		}
		const summary = rebuildSessionCoordinates(cdb, session, { dryRun, force });
		// Post-check: every rebuilt row must name a real event, the rows must be
		// the replay's own output, and the numbering must be 1..N in seq order.
		// (`logContiguous` reports a separate, pre-existing condition: a log whose
		// own seqs have holes or duplicates cannot be folded by the reader at all,
		// and the rebuild neither causes nor fixes that.)
		let missingSeqs = 0;
		let mismatched = 0;
		const stored = cdb.sessionParagraphs(entry.sessionId);
		if (!dryRun && summary.applied) {
			const expected = replayParagraphs(session);
			mismatched = stored.filter((row, index) => row.seq !== expected[index]?.seq || row.paragraph_no !== expected[index]?.paragraph_no).length;
			const liveSeqs = new Set(events.map((event) => event.seq));
			missingSeqs = stored.filter((row) => !liveSeqs.has(row.seq)).length;
		}
		const seqs = events.map((event) => event.seq);
		const contiguous = seqs.every((seq, index) => seq === index);
		report.push({
			sessionId: entry.sessionId,
			project: entry.project,
			status: dryRun
				? (summary.refused ? "would-refuse" : "would-rebuild")
				: (summary.refused ? "refused" : "rebuilt"),
			generation: log.generation,
			events: events.length,
			previousRows: summary.previousRows,
			rows: summary.rows,
			logContiguous: contiguous,
			...(summary.refused ? { reason: summary.reason } : { missingSeqs, mismatched }),
			...(summary.retired.length > 0 ? { retired: summary.retired } : {}),
		});
	}
} finally {
	cdb.close();
}

console.log(JSON.stringify({ home, database: dbPath, dryRun, force, backups: backupsMade, sessions: report }, null, 1));
if (report.some((row) => row.status === "unreadable")) process.exitCode = 1;

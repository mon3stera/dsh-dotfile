// Session-log reading for dsh-magic-context.
//
// DSH writes one log per session generation: `session.jsonl.zstd` is the v0
// file, and a format migration materialises the migrated log beside it as
// `session.v<version>.jsonl.zstd`, leaving the original frozen. Any offline
// reader must therefore pick the HIGHEST generation present, not the unversioned
// name — the v0 file stops at the migration and would silently answer with
// pre-migration coordinates and a truncated conversation.
//
// Logs are a concatenated zstd container (one frame per append batch), so they
// decompress through the `zstd` CLI: the one-shot zlib functions decode a single
// frame only, and piping hundreds of megabytes through a child process buffer is
// unreliable (ENOBUFS) on the largest real logs. Same approach as
// dsh-plugin-session-repair.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The unversioned log name (generation 0). */
export const BASE_LOG_NAME = "session.jsonl.zstd";

/** `session.v3.jsonl.zstd` -> 3; the unversioned name -> 0. */
export function logGeneration(fileName) {
	const match = /^session\.v(\d+)\.jsonl\.zstd$/.exec(fileName);
	if (match !== null) return Number(match[1]);
	return fileName === BASE_LOG_NAME ? 0 : -1;
}

/**
 * Name of the log with the highest format generation in one session directory.
 * @param dir - session directory.
 * @returns the file name, or null when the directory holds no log.
 */
export function highestGenerationLogName(dir) {
	let best = null;
	let bestGeneration = -1;
	for (const name of readdirSync(dir)) {
		const generation = logGeneration(name);
		if (generation > bestGeneration) {
			bestGeneration = generation;
			best = name;
		}
	}
	return best;
}

/** Absolute path of the highest-generation log for one session directory. */
export function highestGenerationLog(dir) {
	const name = highestGenerationLogName(dir);
	return name === null ? null : join(dir, name);
}

/**
 * Decompress one zstd log via the CLI, through a temporary file.
 * @param path - log file path.
 * @returns the decompressed Buffer.
 */
export function decompressLogFile(path) {
	const dst = join(tmpdir(), `dsh-magic-context-${process.pid}-${randomBytes(4).toString("hex")}`);
	try {
		execFileSync("zstd", ["-dc", "-o", dst, path], { maxBuffer: 1024 * 1024 });
		return readFileSync(dst);
	} finally {
		try {
			unlinkSync(dst);
		} catch {
			// already gone
		}
	}
}

/**
 * Parse one decompressed log into its header and seq-keyed event rows.
 *
 * Only rows carrying an integer `seq` are events; the first line is the session
 * header and anything else (unrecognised, non-sequenced) is reported but not
 * treated as an event, because the coordinate space is defined by seq.
 * @param text - decompressed JSONL.
 * @returns { header, events, malformed }.
 */
export function parseLogText(text) {
	const lines = text.split("\n").filter((line) => line.length > 0);
	if (lines.length === 0) throw new Error("session log is empty");
	let header = null;
	const events = [];
	let malformed = 0;
	for (const line of lines) {
		let row;
		try {
			row = JSON.parse(line);
		} catch {
			malformed += 1;
			continue;
		}
		if (row?.type === "session" && header === null) {
			header = row;
			continue;
		}
		if (Number.isSafeInteger(row?.seq)) events.push(row);
	}
	events.sort((a, b) => a.seq - b.seq);
	return { header, events, malformed };
}

/**
 * Find one session directory by id across every project directory.
 * @param sessionsRoot - the deployment's sessions root.
 * @param sessionId - full session id.
 * @returns the directory path, or null.
 */
export function findSessionDir(sessionsRoot, sessionId) {
	if (!existsSync(sessionsRoot)) return null;
	for (const project of readdirSync(sessionsRoot)) {
		const candidate = join(sessionsRoot, project, sessionId);
		try {
			if (statSync(candidate).isDirectory()) return candidate;
		} catch {
			// not this project
		}
	}
	return null;
}

/**
 * Read one session's current log (highest generation) as events.
 * @param dir - session directory.
 * @returns { path, generation, header, events, malformed }.
 */
export function readSessionLog(dir) {
	const path = highestGenerationLog(dir);
	if (path === null) throw new Error(`no session log under ${dir}`);
	const fileName = path.slice(path.lastIndexOf("/") + 1);
	const parsed = parseLogText(decompressLogFile(path).toString("utf8"));
	return { path, generation: logGeneration(fileName), ...parsed };
}

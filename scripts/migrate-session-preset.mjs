#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { cp, mkdir, readdir, readFile, rename, stat, writeFile, utimes } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

const SESSION_SUFFIXES = [".jsonl.zstd", ".jsonl"];
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/;

function resolveDshHome(value = process.env.DSH_HOME) {
	if (typeof value !== "string" || value.trim() === "") return join(homedir(), ".dsh");
	const trimmed = value.trim();
	if (trimmed === "~") return homedir();
	if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
	return resolve(trimmed);
}

function usage() {
	return [
		"Migrate session headers from one agent preset id to another.",
		"",
		"Default mode is a dry run. The service must be stopped for --apply.",
		"",
		"Usage:",
		"  node scripts/migrate-session-preset.mjs [options]",
		"",
		"Options:",
		"  --from <id>                 Source preset id (default: my-compact)",
		"  --to <id>                   Target preset id (default: context-compact)",
		"  --home <path>               DSH home (default: $DSH_HOME or ~/.dsh)",
		"  --port <number>             Refuse --apply when this port is open (default: 3080)",
		"  --backup-dir <path>         Backup directory for --apply",
		"  --apply                     Write changes after creating a backup",
		"  --skip-service-check        Skip the localhost port safety check",
		"  --restore <backup-dir>      Restore files from a migration backup",
		"  --help                      Show this help",
	].join("\n");
}

function parseArgs(argv) {
	const args = {
		from: "my-compact",
		to: "context-compact",
		home: resolveDshHome(),
		port: 3080,
		backupDir: undefined,
		apply: false,
		skipServiceCheck: false,
		restore: undefined,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const value = () => {
			const next = argv[index + 1];
			if (next === undefined || next.startsWith("--")) throw new Error(`${arg} requires a value`);
			index += 1;
			return next;
		};
		switch (arg) {
			case "--from": args.from = value(); break;
			case "--to": args.to = value(); break;
			case "--home": args.home = resolveDshHome(value()); break;
			case "--port": args.port = Number(value()); break;
			case "--backup-dir": args.backupDir = resolve(value()); break;
			case "--apply": args.apply = true; break;
			case "--skip-service-check": args.skipServiceCheck = true; break;
			case "--restore": args.restore = resolve(value()); break;
			case "--help": console.log(usage()); process.exit(0); break;
			default: throw new Error(`unknown option: ${arg}`);
		}
	}
	if (!PRESET_ID.test(args.from) || !PRESET_ID.test(args.to)) throw new Error("preset ids must match /^[a-z0-9][a-z0-9-]*$/");
	if (args.from === args.to) throw new Error("source and target preset ids must differ");
	if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) throw new Error("port must be an integer from 1 to 65535");
	if (args.restore !== undefined && args.apply) throw new Error("use either --restore or --apply, not both");
	return args;
}

async function collectSessionLogs(root) {
	const result = [];
	async function walk(directory) {
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch (error) {
			if (error.code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile() && SESSION_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) result.push(path);
		}
	}
	await walk(root);
	return result.sort();
}

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function decodeLog(file, compressed, bytes) {
	const raw = compressed ? zstdDecompressSync(bytes) : bytes;
	const newline = raw.indexOf(0x0a);
	if (newline < 0) throw new Error(`session log has no header line: ${file}`);
	const headerBytes = raw.subarray(0, newline).toString("utf8");
	let header;
	try {
		header = JSON.parse(headerBytes);
	} catch (error) {
		throw new Error(`invalid session header in ${file}: ${error.message}`);
	}
	if (header?.type !== "session" || typeof header.id !== "string") throw new Error(`invalid session header shape: ${file}`);
	const lineStart = newline > 0 && raw[newline - 1] === 0x0d ? newline - 1 : newline;
	return { raw, header, suffix: raw.subarray(lineStart) };
}

function updatedBytes(file, bytes, nextPreset) {
	const compressed = file.endsWith(".zstd");
	const decoded = decodeLog(file, compressed, bytes);
	const nextHeader = { ...decoded.header, agentPreset: nextPreset };
	const nextRaw = Buffer.concat([Buffer.from(JSON.stringify(nextHeader), "utf8"), decoded.suffix]);
	return {
		bytes: compressed ? zstdCompressSync(nextRaw) : nextRaw,
		header: decoded.header,
		nextHeader,
	};
}

function portIsOpen(port) {
	return new Promise((resolvePort) => {
		const socket = createConnection({ host: "127.0.0.1", port });
		let settled = false;
		const finish = (open) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolvePort(open);
		};
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
		socket.setTimeout(500, () => finish(false));
	});
}

async function assertServiceStopped(args) {
	if (args.skipServiceCheck) return;
	if (await portIsOpen(args.port)) {
		throw new Error(`127.0.0.1:${args.port} is still accepting connections; stop DSH before --apply or pass --skip-service-check`);
	}
}

async function assertTargetPreset(home, preset) {
	const composition = join(home, ".agent-presets", preset, "agent.cordis.yml");
	try {
		const info = await stat(composition);
		if (!info.isFile()) throw new Error();
	} catch {
		throw new Error(`target preset composition does not exist: ${composition}`);
	}
}

async function prepareUpdates(home, from, to) {
	const sessionRoot = join(home, "sessions");
	const files = await collectSessionLogs(sessionRoot);
	const updates = [];
	for (const file of files) {
		const original = await readFile(file);
		const changed = updatedBytes(file, original, to);
		if (changed.header.agentPreset !== from) continue;
		updates.push({
			file,
			relativePath: relative(home, file),
			sessionId: changed.header.id,
			oldPreset: changed.header.agentPreset,
			newPreset: changed.nextHeader.agentPreset,
			original,
			originalHash: sha256(original),
			updated: changed.bytes,
			updatedHash: sha256(changed.bytes),
		});
	}
	return { files, updates };
}

async function writeAtomic(file, bytes, mode, times) {
	const temporary = `${file}.preset-migration-${process.pid}-${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, bytes, { mode: mode & 0o777 });
		await rename(temporary, file);
		await utimes(file, times.atime, times.mtime);
	} finally {
		try { await rename(temporary, `${temporary}.failed`); } catch {}
	}
}

async function createBackup(home, backupDir, updates, args) {
	await mkdir(dirname(backupDir), { recursive: true });
	await mkdir(backupDir);
	const manifest = {
		version: 1,
		createdAt: new Date().toISOString(),
		dshHome: home,
		from: args.from,
		to: args.to,
		files: [],
	};
	for (const update of updates) {
		const backupFile = join(backupDir, update.relativePath);
		await mkdir(dirname(backupFile), { recursive: true });
		await cp(update.file, backupFile);
		manifest.files.push({
			path: update.relativePath,
			sessionId: update.sessionId,
			oldPreset: update.oldPreset,
			newPreset: update.newPreset,
			sha256: update.originalHash,
		});
	}
	await writeFile(join(backupDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	return manifest;
}

async function applyUpdates(updates) {
	for (const update of updates) {
		const current = await readFile(update.file);
		if (sha256(current) !== update.originalHash) throw new Error(`session changed during migration preparation: ${update.file}`);
	}
	for (const update of updates) {
		const info = await stat(update.file);
		await writeAtomic(update.file, update.updated, info.mode, info);
	}
}

async function restoreBackup(args) {
	await assertServiceStopped(args);
	const manifestFile = join(args.restore, "manifest.json");
	const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
	if (!Array.isArray(manifest.files)) throw new Error(`invalid migration manifest: ${manifestFile}`);
	const home = args.home;
	for (const entry of manifest.files) {
		const backupFile = join(args.restore, entry.path);
		const targetFile = join(home, entry.path);
		const bytes = await readFile(backupFile);
		await mkdir(dirname(targetFile), { recursive: true });
		const info = await stat(targetFile);
		await writeAtomic(targetFile, bytes, info.mode, info);
	}
	console.log(`Restored ${manifest.files.length} session log${manifest.files.length === 1 ? "" : "s"} from ${args.restore}`);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.restore !== undefined) {
		await restoreBackup(args);
		return;
	}
	await assertTargetPreset(args.home, args.to);
	const { files, updates } = await prepareUpdates(args.home, args.from, args.to);
	console.log(`Scanned ${files.length} session log${files.length === 1 ? "" : "s"}; found ${updates.length} with agentPreset=${JSON.stringify(args.from)}.`);
	for (const update of updates) console.log(`  ${update.sessionId} ${update.relativePath}`);
	if (!args.apply || updates.length === 0) {
		console.log(args.apply ? "Nothing to migrate." : "Dry run only. Re-run with --apply after stopping DSH to write changes.");
		return;
	}
	await assertServiceStopped(args);
	const backupDir = args.backupDir ?? join(args.home, "session-preset-migrations", `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${args.from}-to-${args.to}`);
	await createBackup(args.home, backupDir, updates, args);
	try {
		await applyUpdates(updates);
	} catch (error) {
		console.error(`Migration failed after backup creation at ${backupDir}: ${error.message}`);
		throw error;
	}
	console.log(`Migrated ${updates.length} session log${updates.length === 1 ? "" : "s"} to agentPreset=${JSON.stringify(args.to)}.`);
	console.log(`Backup: ${backupDir}`);
}

try {
	await main();
} catch (error) {
	console.error(`Session preset migration failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}

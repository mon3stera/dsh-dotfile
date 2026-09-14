#!/usr/bin/env node
/**
 * Offline CLI for dsh-plugin-session-repair.
 *
 * The HTTP routes run inside a DSH process, but a container-broken log bricks
 * every profile at boot (`assertZstdHeaderFrame` fail-closes workspace init),
 * so the web tool can be unreachable exactly when it is needed. This entry
 * needs no running DSH: it works directly on a log path. Run it against the
 * installed copy so the plugin's dependencies resolve:
 *
 *   node ~/.dsh/profiles/node_modules/dsh-plugin-session-repair/lib/cli.mjs \
 *     scan <session.jsonl.zstd>
 *   node .../cli.mjs repair <session.jsonl.zstd> [--dry-run]
 *   node .../cli.mjs scan-all
 *   node .../cli.mjs normalize-all [--dry-run] [--skip <sessionId>]... [--min-age-seconds <n>]
 *
 * repair fixes every covered class in one write: the backward-seq collision
 * (lib/repair.js), a broken container framing (whole-file single frame), stale
 * provenance, and released-v0 schema violations (lib/normalize.js) — always
 * re-emitting the two-frame layout the reader asserts. The original is backed up
 * as `session.jsonl.zstd.bak-<unix-ms>` before any write.
 *
 * normalize-all is the pre-upgrade sweep: it walks every project directory and
 * rewrites only the logs whose rows a newer line's format catalog would refuse
 * to migrate, leaving structurally healthy logs untouched.
 *
 * A rewrite replaces the file, so a log a RUNNING DSH process still holds open
 * must be skipped: its later appends would land on the unlinked inode and be
 * lost. `--skip <sessionId>` (repeatable) excludes named sessions and
 * `--min-age-seconds <n>` excludes logs modified more recently than n seconds —
 * the two together cover a session that is resident and one being written right
 * now. Skipped sessions are reported and can be swept once the service stops.
 *
 * @module dsh-plugin-session-repair/cli
 */
import { repairLogFile, scanSessionFile, scanWorkspaces, sessionsRoot } from "./index.js";
import { statSync } from "node:fs";
import { join } from "node:path";

function usage() {
  console.error("usage: node cli.mjs scan <log> | repair <log> [--dry-run] | scan-all | normalize-all [--dry-run] [--skip <sessionId>]... [--min-age-seconds <n>]");
  process.exit(2);
}

/** Collect repeatable `--skip <id>` values plus an optional `--min-age-seconds`. */
function normalizeOptions(args) {
  const skip = new Set();
  let minAgeSeconds = 0;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--dry-run") continue;
    if (flag === "--skip") {
      const value = args[index + 1];
      if (value === undefined) usage();
      skip.add(value);
      index += 1;
      continue;
    }
    if (flag === "--min-age-seconds") {
      const value = Number(args[index + 1]);
      if (!Number.isFinite(value) || value < 0) usage();
      minAgeSeconds = value;
      index += 1;
      continue;
    }
    usage();
  }
  return { skip, minAgeSeconds };
}

const [command, target, ...rest] = process.argv.slice(2);
if (command === undefined) usage();

if (command === "scan") {
  if (target === undefined) usage();
  console.log(JSON.stringify(scanSessionFile(target), null, 2));
} else if (command === "repair") {
  if (target === undefined) usage();
  const summary = repairLogFile(target, rest.includes("--dry-run"));
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exit(1);
} else if (command === "scan-all") {
  const { sessions, healthyCount, legacyShapedCount, needsNormalization } = scanWorkspaces(undefined);
  console.log(JSON.stringify({ healthyCount, legacyShapedCount, sessions, needsNormalization }, null, 2));
  if (sessions.length > 0) process.exit(1);
} else if (command === "normalize-all") {
  // No positionals in this verb, so the first flag lands in `target`.
  const args = [target, ...rest].filter((value) => value !== undefined);
  const options = normalizeOptions(args);
  const dryRun = args.includes("--dry-run");
  const root = sessionsRoot();
  const { needsNormalization } = scanWorkspaces(undefined);
  const results = [];
  const skipped = [];
  const cutoff = Date.now() - options.minAgeSeconds * 1000;
  for (const entry of needsNormalization) {
    const path = join(root, entry.projectDir, entry.sessionId, "session.jsonl.zstd");
    if (options.skip.has(entry.sessionId)) {
      skipped.push({ sessionId: entry.sessionId, reason: "skipped by --skip", legacyShapes: entry.legacyShapes });
      console.error(`skipping ${entry.sessionId}: named by --skip`);
      continue;
    }
    // A log touched within the age window may be held open by a running DSH
    // process; replacing it would strand that process's appends on the old inode.
    if (entry.mtimeMs !== undefined && entry.mtimeMs > cutoff) {
      skipped.push({ sessionId: entry.sessionId, reason: "modified within --min-age-seconds", legacyShapes: entry.legacyShapes });
      console.error(`skipping ${entry.sessionId}: modified ${Math.round((Date.now() - entry.mtimeMs) / 1000)}s ago`);
      continue;
    }
    // Optimistic guard: the scan read this log before, so any append since then
    // means a writer is active right now. Skip it instead of racing the append.
    const current = statSync(path);
    if (entry.mtimeMs !== undefined && current.mtimeMs !== entry.mtimeMs) {
      skipped.push({ sessionId: entry.sessionId, reason: "changed after the scan", legacyShapes: entry.legacyShapes });
      console.error(`skipping ${entry.sessionId}: modified after the scan`);
      continue;
    }
    const summary = repairLogFile(path, dryRun);
    results.push({
      sessionId: entry.sessionId,
      projectDir: entry.projectDir,
      legacyShapes: entry.legacyShapes,
      ok: summary.ok === true,
      verified: summary.verified === true,
      dryRun: summary.dryRun === true,
      fixes: summary.normalizePass?.fixes ?? null,
      repairClasses: {
        seq: summary.passes?.length ?? 0,
        provenance: summary.staleProvenance ?? 0,
        container: summary.containerBroken === true,
        normalized: summary.normalizePass?.count ?? 0
      },
      error: summary.ok === true ? undefined : summary.error
    });
    // Progress on stderr keeps stdout a single JSON document.
    console.error(`${dryRun ? "would normalize" : "normalized"} ${entry.sessionId}: ${summary.ok === true ? "ok" : summary.error}`);
  }
  const failed = results.filter((entry) => !entry.ok);
  console.log(JSON.stringify({
    dryRun,
    scanned: needsNormalization.length,
    normalized: results.length - failed.length,
    failed: failed.length,
    skipped: skipped.length,
    skipDetail: skipped,
    results
  }, null, 2));
  if (failed.length > 0) process.exit(1);
} else {
  usage();
}

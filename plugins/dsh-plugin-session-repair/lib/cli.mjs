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
 *
 * repair fixes both incident classes in one write: the backward-seq collision
 * (lib/repair.js) and a broken container framing (whole-file single frame),
 * always re-emitting the two-frame layout the reader asserts. The original is
 * backed up as `session.jsonl.zstd.bak-<unix-ms>` before any write.
 *
 * @module dsh-plugin-session-repair/cli
 */
import { repairLogFile, scanSessionFile, scanWorkspaces } from "./index.js";

function usage() {
  console.error("usage: node cli.mjs scan <log> | repair <log> [--dry-run] | scan-all");
  process.exit(2);
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
  const { sessions, healthyCount } = scanWorkspaces(undefined);
  console.log(JSON.stringify({ healthyCount, sessions }, null, 2));
  if (sessions.length > 0) process.exit(1);
} else {
  usage();
}

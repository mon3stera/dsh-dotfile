/**
 * Smoke test for dsh-plugin-session-repair (core repair + host routes with stubs).
 * Run: node tests/dsh-session-repair-smoke.mjs (from the repo root)
 *
 * The corruption under test: a turn interrupted while a tool call is pending
 * persists a synthetic interrupted-tool-result batch, and the original session
 * object later commits the real tool result (or a queued prompt splice) with
 * its pre-interrupt event counter, leaving a backward seq transition. The
 * fixed repair pattern deletes the synthetic batch (renumbering the remaining
 * committed rows) and then shifts the late tail up; both directions are
 * cross-checked against an independent expansion of the stored row encoding,
 * and the repaired log is additionally folded with the HOST's own surface
 * reader (`foldSurface`, still exported by 0.1.5's `dsh-session`) so a repair
 * that breaks the reader fails here.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const PLUGIN_DIR = fileURLToPath(new URL("../plugins/dsh-plugin-session-repair/", import.meta.url));
const INSTALLED_PLUGIN_DIR = "/home/mon3tr/.dsh/profiles/node_modules/dsh-plugin-session-repair";
const TEST_HOME = "/home/mon3tr/dsh-session-repair-test-home";
process.env.DSH_HOME = TEST_HOME;
rmSync(TEST_HOME, { recursive: true, force: true });
mkdirSync(TEST_HOME, { recursive: true });

// The DSH installation provides @deepseek-ai/* for the host half and the real
// surface reader for cross-checking the repaired logs. `decodeStorageRecord`
// was removed from 0.1.5's dsh-session, so the event expansion below is this
// test's own implementation of the documented row encoding.
const DSH_LIB = "/home/mon3tr/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai";

const repoRepair = await import(`${PLUGIN_DIR}/lib/repair.js`);
const repoNormalize = await import(`${PLUGIN_DIR}/lib/normalize.js`);
const host = await import(`${INSTALLED_PLUGIN_DIR}/lib/index.js`);
const { foldSurface, decodeSeqRanges } = await import(`${DSH_LIB}/dsh-session/lib/index.js`);
const { validateSurfaceMetadata } = await import(`${DSH_LIB}/dsh-session/lib/types/surface.js`);

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  ok: ${label}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL: ${label}`);
}

/**
 * Expand one stored JSONL row into the event seqs it occupies, from the row
 * encoding alone: a packed streaming-chunk run (`text-chunks`,
 * `reasoning-chunks`, `tool-call-chunks`) carries `seq0` and occupies one slot
 * per member, every other numbered row occupies exactly one slot.
 * @returns number[] of event seqs, ascending (empty for the header row).
 */
function expandRow(obj) {
  if (typeof obj?.seq0 === "number") {
    const members = obj.type === "tool-call-chunks" ? obj.data?.args : obj.data?.texts;
    const count = Array.isArray(members) ? members.length : 0;
    return Array.from({ length: count }, (_unused, index) => obj.seq0 + index);
  }
  return typeof obj?.seq === "number" ? [obj.seq] : [];
}

/**
 * The real persistence invariant, applied to the documented row encoding: rows
 * must expand to events whose seqs continue densely from zero.
 */
function scanWithRealDecoder(jsonlText) {
  const lines = jsonlText.split("\n").filter((line) => line !== "");
  let expected = 0;
  for (const [index, line] of lines.slice(1).entries()) {
    for (const seq of expandRow(JSON.parse(line))) {
      if (seq !== expected) {
        return { ok: false, expected, got: seq, index: index + 1 };
      }
      expected += 1;
    }
  }
  return { ok: true, events: expected };
}

/**
 * Mirror the reader's container contract: the first frame must decode to
 * exactly the header line, and all frames together must reproduce the JSONL.
 * Frames are located by the zstd magic number, which is exact for CLI-written
 * files and the only structural detail the repair can get wrong that the
 * JSONL-level decoder above cannot see.
 */
function verifyFrameLayout(logPath, jsonlText) {
  const blob = readFileSync(logPath);
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const starts = [];
  for (let at = blob.indexOf(MAGIC); at !== -1; at = blob.indexOf(MAGIC, at + 1)) starts.push(at);
  if (starts[0] !== 0) return "first frame does not start at byte 0";
  let plaintext = "";
  for (const [index, start] of starts.entries()) {
    const end = index + 1 < starts.length ? starts[index + 1] : blob.length;
    let frame;
    try {
      frame = zstdDecompressSync(blob.subarray(start, end));
    } catch (error) {
      return `frame ${index} failed to decode: ${error?.message ?? error}`;
    }
    plaintext += frame.toString("utf8");
    if (index === 0 && frame.toString("utf8") !== jsonlText.slice(0, jsonlText.indexOf("\n") + 1)) {
      return "first frame is not exactly the header line";
    }
  }
  return plaintext === jsonlText ? null : "decoded frames do not reproduce the log";
}

/** Compress JSONL text into a single-frame zstd log file. */
function writeLog(path, jsonlText) {
  writeFileSync(path, execFileSync("zstd", ["-q", "-3", "--"], { input: jsonlText }));
}

/**
 * Compress JSONL text into the two-frame container the persistence reader
 * asserts (one frame carrying only the header line, one for the rest), so a
 * fixture exercises the schema pass without also being container-broken.
 */
function writeTwoFrameLog(path, jsonlText) {
  const newline = jsonlText.indexOf("\n");
  const head = jsonlText.slice(0, newline + 1);
  const rest = jsonlText.slice(newline + 1);
  const frames = [zstdCompressSync(Buffer.from(head, "utf8"))];
  if (rest.length > 0) frames.push(zstdCompressSync(Buffer.from(rest, "utf8")));
  writeFileSync(path, Buffer.concat(frames));
}

const HEADER = JSON.stringify({ type: "session", version: 0, id: "session-00000000-0000-4000-8000-00000000000x", createdAt: 1, cwd: "/tmp/proj", delegationDepth: 0, agentPreset: "default" });

/** Build Case A: interrupted pending tool call + late real result. */
function caseABatchLines() {
  const lines = [HEADER];
  const row = (type, seq, data, extra = {}) => lines.push(JSON.stringify({ type, seq, time: 1000 + seq, data, ...extra }));
  row("user/message", 0, { content: [{ type: "text", text: "run it" }], role: "user", id: "u0" });
  row("turn/start", 1, { turn: 1 });
  row("step/start", 2, { turn: 1, step: 1 });
  row("assistant/message", 3, { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: "..." }] } });
  row("tool/call", 4, { turn: 1, step: 1, callId: "call_x", name: "bash", arguments: "{}" });
  row("tool/result", 5, { turn: 1, step: 1, message: { id: "interrupted-tool-result-call_x-5", role: "user", source: { kind: "tool", callId: "call_x" } } });
  row("step/end", 6, { turn: 1, step: 1 });
  row("turn/end", 7, { turn: 1, reason: { kind: "interrupted" } });
  row("session/end-seed", 8, {});
  row("command/run", 9, { commandId: "c1", name: "Context: project memory injection" });
  row("command/done", 10, { commandId: "c1", kind: "success", text: "ok" });
  // Late tail from the stale pre-interrupt counter (next seq was 5).
  row("tool/result", 5, { turn: 1, step: 1, message: { source: { kind: "tool", callId: "call_x" } } }, { sourceEventSeqs: [4] });
  row("step/end", 6, { turn: 1, step: 1 });
  row("step/start", 7, { turn: 1, step: 2 });
  lines.push(JSON.stringify({ type: "reasoning-chunks", seq0: 8, time0: 2000, data: { turn: 1, step: 2, index: 0, dt: [5], texts: ["a", "b"] } }));
  row("assistant/message", 10, { turn: 1, step: 2, message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
  row("turn/end", 11, { turn: 1, reason: { kind: "completed" } });
  return lines;
}

/** Build Case B: no synthetic batch - a queued prompt splice arrives late. */
function caseBShiftLines() {
  const lines = [HEADER];
  const row = (type, seq, data) => lines.push(JSON.stringify({ type, seq, time: 1000 + seq, data }));
  row("user/message", 0, { content: [{ type: "text", text: "hi" }], role: "user", id: "u0" });
  row("session/end-seed", 1, {});
  row("command/run", 2, { commandId: "c1", name: "Context: project memory injection" });
  row("command/done", 3, { commandId: "c1", kind: "success", text: "ok" });
  // Late tail from the stale pre-interrupt counter (next seq was 1).
  row("agent/inbox/spliced", 1, { target: "next-turn", start: 0, inserted: [] });
  row("turn/start", 2, { turn: 1 });
  row("turn/end", 3, { turn: 1, reason: { kind: "completed" } });
  return lines;
}

/**
 * Build Case C: Case A plus two checkpoint-landing replacement markers in the
 * late tail. The first replaces the opening surface range; the second replaces
 * the first marker itself. Both carry `surfaceOp` start/end refs into the
 * renumbered region, so the repair must shift them together with the seqs -
 * otherwise restore fails with "surface replace: end seq not found in surface"
 * even though the contiguity scan passes (observed on a real log, 2026-09-06).
 */
function caseCMarkerLines() {
  // Surface rows must carry the append marker the real writer always stores.
  const lines = caseABatchLines().map((line) => {
    const obj = JSON.parse(line);
    if ((obj.type === "user/message" || obj.type === "assistant/message" || obj.type === "tool/result") && obj.surfaceOp === undefined) {
      obj.surfaceOp = "append";
    }
    return JSON.stringify(obj);
  });
  // Landing marker 1: replaces surface seqs 0..3 (stored refs are pre-repair).
  lines.push(JSON.stringify({
    type: "user/message", seq: 12, time: 1120,
    data: { content: [{ type: "text", text: "[checkpoint]" }], role: "user", id: "cp1" },
    surfaceOp: { op: "replace", start: 0, end: 3 },
    sourceEventSeqs: [0, 3]
  }));
  // Landing marker 2: replaces marker 1 by its pre-repair seq.
  lines.push(JSON.stringify({
    type: "user/message", seq: 13, time: 1130,
    data: { content: [{ type: "text", text: "[checkpoint 2]" }], role: "user", id: "cp2" },
    surfaceOp: { op: "replace", start: 12, end: 12 },
    sourceEventSeqs: [12]
  }));
  return lines;
}

// ---------- core repair: Case A (delete-batch then shift-tail) ----------
console.log("case A: synthetic interrupt batch");
{
  const parsed = repoRepair.parseLog(caseABatchLines().join("\n") + "\n");
  const before = repoRepair.scanRows(parsed.rows);
  check("scan detects the gap", !before.ok && before.gap.expected === 11 && before.gap.got === 5);

  const repaired = repoRepair.repairRows(parsed);
  check("repair converges", repaired.ok);
  check("two passes (batch delete, tail shift)", repaired.passes.length === 2 && repaired.passes[0].mode === "delete-batch" && repaired.passes[1].mode === "shift-tail");
  check("three synthetic rows dropped", repaired.passes[0].dropped === 3);
  check("event count is 11 prefix - 3 synthetic + 7 tail", repaired.scan.events === 15);

  const objs = parsed.rows.map((r) => r.obj);
  check("synthetic rows are gone", !objs.some((o) => typeof o?.data?.message?.id === "string" && o.data.message.id.startsWith("interrupted-tool-result-")));
  const realResult = objs.find((o) => o.type === "tool/result" && o.data?.message?.source?.callId === "call_x");
  check("real tool result renumbered to 8", realResult?.seq === 8);
  check("provenance still points at the unmoved tool/call", JSON.stringify(realResult.sourceEventSeqs) === "[4]");
  const packed = objs.find((o) => o.type === "reasoning-chunks");
  check("packed chunk row seq0 shifted to 11", packed?.seq0 === 11);
  const turnEnd = objs.at(-1);
  check("tail turn/end renumbered to 14", turnEnd?.seq === 14);
  check("end-seed row renumbered to 5", objs.some((o) => o.type === "session/end-seed" && o.seq === 5));

  const real = scanWithRealDecoder(repoRepair.serializeLog(parsed));
  check("real DSH decoder accepts the repaired log", real.ok && real.events === 15);
}

// ---------- core repair: Case B (shift-tail only) ----------
console.log("case B: late prompt splice without synthetic batch");
{
  const parsed = repoRepair.parseLog(caseBShiftLines().join("\n") + "\n");
  const before = repoRepair.scanRows(parsed.rows);
  check("scan detects the gap", !before.ok && before.gap.expected === 4 && before.gap.got === 1);

  const repaired = repoRepair.repairRows(parsed);
  check("repair converges in one shift pass", repaired.ok && repaired.passes.length === 1 && repaired.passes[0].mode === "shift-tail");
  check("event count preserved", repaired.scan.events === 7);
  const splice = parsed.rows.find((r) => r.obj.type === "agent/inbox/spliced").obj;
  check("splice renumbered to 4", splice.seq === 4);

  const real = scanWithRealDecoder(repoRepair.serializeLog(parsed));
  check("real DSH decoder accepts the repaired log", real.ok && real.events === 7);
}

// ---------- core repair: Case C (replace markers ride the renumber) ----------
console.log("case C: landing replace markers in the shifted tail");
{
  const parsed = repoRepair.parseLog(caseCMarkerLines().join("\n") + "\n");
  const before = repoRepair.scanRows(parsed.rows);
  check("scan detects the gap", !before.ok && before.gap.expected === 11 && before.gap.got === 5);

  const repaired = repoRepair.repairRows(parsed);
  check("repair converges in two passes", repaired.ok && repaired.passes.length === 2 && repaired.passes[1].mode === "shift-tail");

  const objs = parsed.rows.map((r) => r.obj);
  const marker1 = objs.find((o) => o.data?.id === "cp1");
  const marker2 = objs.find((o) => o.data?.id === "cp2");
  check("marker 1 renumbered to 15", marker1?.seq === 15);
  check("marker 1 range tracks the shifted surface", marker1.surfaceOp.start === 0 && marker1.surfaceOp.end === 3);
  check("marker 1 provenance still cites unmoved seqs", JSON.stringify(marker1.sourceEventSeqs) === "[0,3]");
  check("marker 2 renumbered to 16", marker2?.seq === 16);
  check("marker 2 range rides the marker 1 renumber", marker2.surfaceOp.start === 15 && marker2.surfaceOp.end === 15);
  check("marker 2 provenance rides the marker 1 renumber", JSON.stringify(marker2.sourceEventSeqs) === "[15]");

  const real = scanWithRealDecoder(repoRepair.serializeLog(parsed));
  check("real DSH decoder accepts the repaired log", real.ok && real.events === 17);

  // A v0 log's surface rows carry chunk rows that only a v0 reader folds; the
  // marker shape itself is validated against the host (see case C2 for the v3
  // shape the current reader actually writes).
  let markerError = null;
  for (const marker of [marker1, marker2]) {
    try {
      validateSurfaceMetadata({ ...marker, sourceEventSeqs: decodeSeqRanges(marker.sourceEventSeqs) });
    } catch (error) {
      markerError = `${marker.data.id}: ${error.message}`;
    }
  }
  check(
    markerError === null
      ? "legacy-shaped markers are not accepted by the 0.1.5 reader (expected)"
      : `legacy-shaped markers rejected by the 0.1.5 reader (${markerError})`,
    markerError !== null,
  );
}

// ---------- core repair: Case C2 (v3 marker shape) ----------
// DSH 0.1.5 renamed the replacement keys to {startSeq, endSeq}, and a v3 log has
// no chunk rows at all. The repair must shift the NEW shape too: a marker left
// behind on a renumbered log makes restore fail with
// "surface replace: end seq ... not found in surface" while the contiguity scan
// still passes. Same corruption as Case C, expressed as a v3 log.
console.log("case C2: v3-shaped replacement markers");
{
  const lines = caseCMarkerLines().map((line) => {
    const obj = JSON.parse(line);
    if (obj.surfaceOp !== null && typeof obj.surfaceOp === "object" && !Array.isArray(obj.surfaceOp)) {
      const { start, end } = obj.surfaceOp;
      obj.surfaceOp = { op: "replace", startSeq: start, endSeq: end };
    }
    return JSON.stringify(obj);
  });
  const parsed = repoRepair.parseLog(lines.join("\n") + "\n");
  const before = repoRepair.scanRows(parsed.rows);
  check("v3 scan detects the gap", !before.ok && before.gap.expected === 11 && before.gap.got === 5);

  const repaired = repoRepair.repairRows(parsed);
  check("v3 repair converges", repaired.ok);

  const objs = parsed.rows.map((r) => r.obj);
  const marker1 = objs.find((o) => o.data?.id === "cp1");
  const marker2 = objs.find((o) => o.data?.id === "cp2");
  check("v3 marker keeps only its new key names", marker1.surfaceOp.startSeq !== undefined && marker1.surfaceOp.endSeq !== undefined && marker1.surfaceOp.start === undefined && marker1.surfaceOp.end === undefined);
  check("v3 marker 1 rides the renumber", marker1.seq === 15 && marker1.surfaceOp.startSeq === 0 && marker1.surfaceOp.endSeq === 3);
  check("v3 marker 2 rides the renumber", marker2.seq === 16 && marker2.surfaceOp.startSeq === 15 && marker2.surfaceOp.endSeq === 15);
  check("v3 marker provenance rides the renumber", JSON.stringify(marker2.sourceEventSeqs) === "[15]");

  const real = scanWithRealDecoder(repoRepair.serializeLog(parsed));
  check("v3 log satisfies the contiguity contract", real.ok && real.events === 17);
  // The host's own validator is the authority on the marker shape: after the
  // repair, both markers must still pass it (a v0-shaped marker does not).
  let markerError = null;
  for (const marker of [marker1, marker2]) {
    try {
      validateSurfaceMetadata({ ...marker, sourceEventSeqs: decodeSeqRanges(marker.sourceEventSeqs) });
    } catch (error) {
      markerError = `${marker.data.id}: ${error.message}`;
    }
  }
  check(`host validator accepts the repaired v3 markers${markerError === null ? "" : ` (${markerError})`}`, markerError === null);
  // A v0-shaped marker must be REJECTED by the same validator, which is what
  // makes the shape test above meaningful rather than tautological.
  let legacyRejected = false;
  try {
    validateSurfaceMetadata({ type: "user/message", seq: 30, surfaceOp: { op: "replace", start: 0, end: 0 } });
  } catch {
    legacyRejected = true;
  }
  check("host validator rejects the legacy marker shape", legacyRejected);
}

/**
 * Build Case D: a seq-healthy log whose last assistant/message cites the three
 * events BEFORE its own chunk run. This is the shape the 2026-09-06 repair batch
 * produced when its renumber skipped range-encoded provenance pairs: the
 * message's seq moved +3 but its [start, end] pair kept the pre-shift positions,
 * so the token meter re-assembles user/message + turn/start + step/start as
 * provider output and throws "source seq N is not assistant/chunk", which
 * silently blocks every compaction path for the session. The earlier message's
 * provenance is healthy and must stay untouched.
 *
 * seq layout: 0..2 chunk run, 3..5 chunk run, 6 assistant/message citing [3,5],
 * 7 turn/end, 8 step/start, 9..10 more non-chunk rows, 11..13 chunk run,
 * 14 assistant/message citing [8,10] (stale: should cite [11,13]), 15 turn/end.
 */
function caseDProvenanceLines() {
  // The first line is always the session header; parseLog treats it as the
  // header row rather than an event.
  const lines = [JSON.stringify({ type: "session", version: 0, id: "session-44444444-2222-4333-8444-555566667777", createdAt: 1, cwd: "/tmp/x", delegationDepth: 0, agentPreset: "context-compact" })];
  const row = (type, seq, data, extra = {}) => {
    lines.push(JSON.stringify({ type, seq, time: seq, data, ...extra }));
  };
  const chunkRow = (type, seq0, count, extra = {}) => {
    const data = type === "tool-call-chunks" ? { args: Array.from({ length: count }, () => "{}") } : { texts: Array.from({ length: count }, () => "x") };
    lines.push(JSON.stringify({ type, seq0, time: seq0, data, ...extra }));
  };
  // 0..5 two chunk runs, 6 a healthy assistant message citing [3,5],
  // 7 turn/end, 8..10 non-chunk rows, 11..13 a chunk run, 14 the STALE message
  // citing [8,10] (the pre-shift positions; [11,13] is the run it belongs to),
  // 15 turn/end. The seqs are contiguous, so only provenance is corrupt.
  chunkRow("text-chunks", 0, 3);
  chunkRow("text-chunks", 3, 3);
  row("assistant/message", 6, { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: "one" }] } }, { surfaceOp: "append", sourceEventSeqs: [[3, 5]] });
  row("turn/end", 7, { turn: 1, reason: { kind: "completed" } });
  row("step/start", 8, { turn: 2, step: 1 });
  row("step/end", 9, { turn: 2, step: 1 });
  row("sandbox/mode", 10, { mode: "danger-full-access" });
  chunkRow("text-chunks", 11, 3);
  row("assistant/message", 14, { turn: 2, step: 1, message: { role: "assistant", content: [{ type: "text", text: "two" }] } }, { surfaceOp: "append", sourceEventSeqs: [[8, 10]] });
  row("turn/end", 15, { turn: 2, reason: { kind: "completed" } });
  return lines;
}

console.log("case D: stale provenance resync");
{
  const parsed = repoRepair.parseLog(caseDProvenanceLines().join("\n") + "\n");
  check("seq scan passes (the corruption is provenance-only)", repoRepair.scanRows(parsed.rows).ok);

  const issues = repoRepair.scanProvenance(parsed.rows);
  check("scan flags exactly the stale message", issues.length === 1 && issues[0].seq === 14);
  check("the stale refs are the non-chunk head", JSON.stringify(issues[0].invalidSeqs) === "[8,9,10]");

  const pass = repoRepair.repairStaleProvenance(parsed.rows);
  check("resync realigns by +3", pass?.ok === true && JSON.stringify(pass.repaired) === JSON.stringify([{ seq: 14, delta: 3 }]));
  check("stale refs now cite the chunk run", JSON.stringify(parsed.rows.find((r) => r.obj.seq === 14).obj.sourceEventSeqs) === "[[11,13]]");
  check("healthy row untouched", JSON.stringify(parsed.rows.find((r) => r.obj.seq === 6).obj.sourceEventSeqs) === "[[3,5]]");
  check("rescan is clean", repoRepair.scanProvenance(parsed.rows).length === 0);
  const real = scanWithRealDecoder(repoRepair.serializeLog(parsed));
  check("real DSH decoder accepts the resynced log", real.ok && real.events === 16);

  // A hopeless alignment must fail loudly instead of writing a wrong row.
  const bad = repoRepair.parseLog(caseDProvenanceLines().join("\n") + "\n");
  // Break the chunk run the stale list would realign onto: the first row of the
  // run becomes a message, so no contiguous assistant/chunk run ends at 13.
  bad.rows.find((r) => r.obj.seq0 === 11).obj.type = "user/message";
  const failed = repoRepair.repairStaleProvenance(bad.rows);
  check("unaligned run fails without repairing", failed?.ok === false && failed.repaired.length === 0 && failed.failures.length === 1);
}

// ---------- project key encoding matches the deployed layout ----------
console.log("project key encoding");
{
  check("home workspace", repoRepair.projectKey("/home/mon3tr") === "--home-mon3tr--");
  check("repo workspace", repoRepair.projectKey("/home/mon3tr/dev/dsh-dotfile") === "--home-mon3tr-dev-dsh-dotfile--");
  check("session id is segment-safe", repoRepair.encodeSegment("session-abc-123") === "session-abc-123");
}

// ---------- host routes with stubs ----------
console.log("host routes");
{
  const cwd = "/tmp/dsh-session-repair-proj";
  const registered = [];
  const ctx = {
    inject(_, fn) {
      const httpCtx = { webServer: { register: (route) => { registered.push(route); return () => {}; } }, effect: (factory) => factory() };
      fn(httpCtx);
    }
  };
  host.apply(ctx);
  check("three routes registered", registered.length === 3);
  const route = (path) => registered.find((r) => r.path === path).handler;

  const projectDir = `${TEST_HOME}/sessions/${repoRepair.projectKey(cwd)}`;
  const sessionDir = `${projectDir}/session-11111111-2222-4333-8444-555566667777`;
  mkdirSync(sessionDir, { recursive: true });
  writeLog(`${sessionDir}/session.jsonl.zstd`, caseABatchLines().join("\n") + "\n");

  const respond = async (handler, req) => {
    const chunks = [];
    const res = {
      statusCode: 0,
      headers: null,
      body: "",
      writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
      end(body) { if (body !== undefined) this.body += body; }
    };
    chunks.push(res);
    await handler(req, res);
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, res };
  };
  const jsonRequest = (method, url, body) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return {
      method,
      url,
      [Symbol.asyncIterator]: async function* () {
        if (payload !== undefined) yield Buffer.from(payload);
      }
    };
  };

  const scan = route("/session-repair/scan");
  const scanRes = await respond(scan, jsonRequest("GET", `/session-repair/scan?cwd=${encodeURIComponent(cwd)}`));
  check("scan reports one corrupted session", scanRes.status === 200 && scanRes.body.ok && scanRes.body.sessions.length === 1);
  check("scan flags the synthetic batch", scanRes.body.sessions[0].hasSyntheticBatch === true);
  check("scan gap numbers", scanRes.body.sessions[0].gap.expected === 11 && scanRes.body.sessions[0].gap.got === 5);
  check("scan also flags the fixture's single-frame container", scanRes.body.sessions[0].containerBroken === true);

  const repair = route("/session-repair/repair");
  const sessionId = "session-11111111-2222-4333-8444-555566667777";

  const dry = await respond(repair, jsonRequest("POST", "/session-repair/repair", { sessionId, cwd, dryRun: true }));
  check("dry run succeeds without writing", dry.status === 200 && dry.body.dryRun === true && dry.body.eventsAfter === 15 && !dry.body.backup);

  const fixed = await respond(repair, jsonRequest("POST", "/session-repair/repair", { sessionId, cwd }));
  check("repair verifies post-write", fixed.status === 200 && fixed.body.verified === true);
  check("backup written", typeof fixed.body.backup === "string" && existsSync(fixed.body.backup));

  const rescanned = await respond(scan, jsonRequest("GET", "/session-repair/scan?cwd=" + encodeURIComponent(cwd)));
  check("rescan finds no corruption", rescanned.body.sessions.length === 0 && rescanned.body.healthyCount === 1);

  const repairedText = execFileSync("zstd", ["-dc", "--", `${sessionDir}/session.jsonl.zstd`]).toString("utf8");
  const real = scanWithRealDecoder(repairedText);
  check("repaired file passes the real decoder", real.ok && real.events === 15);
  const framing = verifyFrameLayout(`${sessionDir}/session.jsonl.zstd`, repairedText);
  check("repaired file keeps the header-frame container layout", framing === null);

  const refuse = await respond(repair, jsonRequest("POST", "/session-repair/repair", { sessionId, cwd }));
  check("repair refuses a clean log", refuse.status === 409);

  const restore = route("/session-repair/restore");
  const restored = await respond(restore, jsonRequest("POST", "/session-repair/restore", { sessionId }));
  check("restore brings the corrupt original back", restored.status === 200);
  const restoredText = execFileSync("zstd", ["-dc", "--", `${sessionDir}/session.jsonl.zstd`]).toString("utf8");
  check("restored file is corrupt again", !scanWithRealDecoder(restoredText).ok);

  const missing = await respond(repair, jsonRequest("POST", "/session-repair/repair", { sessionId: "session-does-not-exist-0001" }));
  check("repair 404s unknown sessions", missing.status === 404);
}

// ---------- container-only incident (2026-09-06 class) ----------
// A whole-file single-frame compression leaves the seq numbering healthy but
// bricks every profile at boot (assertZstdHeaderFrame fail-closes workspace
// init). Scan must flag it, repair must re-containerize without touching the
// event content, and the offline CLI must reach it without a running DSH.
console.log("container-only incident");
{
  const healthyLines = [HEADER];
  const row = (type, seq, data) => healthyLines.push(JSON.stringify({ type, seq, time: 1000 + seq, data }));
  row("user/message", 0, { content: [{ type: "text", text: "hello" }], role: "user", id: "u0" });
  row("turn/start", 1, { turn: 1 });
  row("turn/end", 2, { turn: 1, reason: { kind: "completed" } });
  const healthyText = healthyLines.join("\n") + "\n";

  const logPath = `${TEST_HOME}/container-case/session.jsonl.zstd`;
  mkdirSync(`${TEST_HOME}/container-case`, { recursive: true });
  writeLog(logPath, healthyText);
  const before = execFileSync("zstd", ["-dc", "--", logPath]).toString("utf8");
  check("fixture is a single-frame healthy log", verifyFrameLayout(logPath, healthyText) !== null && scanWithRealDecoder(before).ok);

  const scanned = host.scanSessionFile(logPath);
  check("scan flags the container as broken", scanned.containerBroken === true && scanned.corrupted === true && scanned.gap === null);
  check("scan still counts the events", scanned.events === 3);

  const dry = host.repairLogFile(logPath, true);
  check("dry run reports recontainerize-only", dry.ok && dry.dryRun === true && dry.recontainerizeOnly === true && dry.passes.length === 0 && !dry.backup);

  const cli = execFileSync("node", [`${INSTALLED_PLUGIN_DIR}/lib/cli.mjs`, "repair", logPath, "--dry-run"], { encoding: "utf8" });
  const cliSummary = JSON.parse(cli);
  check("offline CLI reaches the log without a running DSH", cliSummary.ok === true && cliSummary.recontainerizeOnly === true);

  const fixed = host.repairLogFile(logPath, false);
  check("repair verifies post-write", fixed.ok && fixed.verified === true);
  check("backup written", typeof fixed.backup === "string" && existsSync(fixed.backup));

  const after = execFileSync("zstd", ["-dc", "--", logPath]).toString("utf8");
  check("content is byte-identical after re-containerize", after === before);
  check("written file satisfies the header-frame layout", verifyFrameLayout(logPath, after) === null);
  check("container passes the validation after repair", host.containerHeaderBroken(logPath) === false);
  check("re-containerized log is not corrupted again", host.repairLogFile(logPath, false).status === 409);
}

// ---------- provenance-only incident (2026-09-06 repair batch follow-up) ----------
// Seq numbering healthy, container intact, but range-encoded provenance pairs
// left behind by a pre-fix renumber block every compaction: scan must count
// the log as corrupted, repair must resync without touching any seq.
console.log("provenance-only incident");
{
  const logPath = `${TEST_HOME}/provenance-case/session.jsonl.zstd`;
  mkdirSync(`${TEST_HOME}/provenance-case`, { recursive: true });
  writeLog(logPath, caseDProvenanceLines().join("\n") + "\n");

  const scanned = host.scanSessionFile(logPath);
  // The single-frame fixture is also container-broken (writeLog compresses
  // whole); the provenance count is the assertion that matters here.
  check("scan counts stale provenance as corrupted", scanned.corrupted === true && scanned.staleProvenance === 1);
  check("scan samples the first stale row", scanned.staleProvenanceSample?.seq === 14);

  const cli = execFileSync("node", [`${INSTALLED_PLUGIN_DIR}/lib/cli.mjs`, "repair", logPath, "--dry-run"], { encoding: "utf8" });
  const cliSummary = JSON.parse(cli);
  check("offline CLI dry run builds the resync", cliSummary.ok === true && cliSummary.staleProvenance === 1 && cliSummary.provenancePass?.repaired?.[0]?.delta === 3);

  const before = execFileSync("zstd", ["-dc", "--", logPath]).toString("utf8");
  const fixed = host.repairLogFile(logPath, false);
  check("repair writes and verifies", fixed.ok === true && fixed.verified === true && fixed.passes.length === 0);

  const after = execFileSync("zstd", ["-dc", "--", logPath]).toString("utf8");
  const objs = after.split("\n").filter((line) => line !== "").slice(1).map((line) => JSON.parse(line));
  check("seqs are untouched", JSON.stringify(objs.map((o) => o.seq ?? o.seq0)) === JSON.stringify(before.split(String.fromCharCode(10)).filter((line) => line !== "").slice(1).map((line) => { const o = JSON.parse(line); return o.seq ?? o.seq0; })));
  check("the fixture is the contiguous shape the resync expects", repoRepair.scanRows(repoRepair.parseLog(before).rows).ok === true);
  check("stale row now cites its chunk run", JSON.stringify(objs.find((o) => o.seq === 14).sourceEventSeqs) === "[[11,13]]");
  check("resynced log scans clean", host.scanSessionFile(logPath).corrupted === false);
  check("repair of a clean log is refused again", host.repairLogFile(logPath, false).status === 409);
}

// ---------- released-v0 schema hygiene (0.1.5 migration gate) ----------
// Structurally healthy logs can still carry members the released v0 inventory
// does not declare. The 0.1.2 line loads them; a 0.1.5 reader refuses to MIGRATE
// them, so the session stays listed but cannot be resumed there. scan reports
// them as legacyShapes (never as corruption) and repair normalizes them in the
// same write. Observed on the real store: 309 of 380 sessions refused.
console.log("released-v0 schema hygiene");
{
  const lines = [HEADER];
  const row = (type, seq, data, extra = {}) => lines.push(JSON.stringify({ type, seq, time: 1000 + seq, data, ...extra }));
  row("user/message", 0, { content: [{ type: "text", text: "hi" }], role: "user", id: "u0" });
  // A: the shape dsh-magic-context's activity rows used to write.
  row("command/run", 1, { commandId: "dsh-magic-context/abc-1", name: "Context: project memory injection", source: { kind: "plugin", plugin: "dsh-magic-context" } });
  // A2: `command/done` declares no source member at all.
  row("command/done", 2, { commandId: "dsh-magic-context/abc-1", kind: "success", text: "ok", source: { kind: "plugin" } });
  // B: the host's own resolveCallConfig result, appended verbatim by
  // selectForNextRequest.
  row("model/selection", 3, { provider: "codelink", model: "gpt-5.6-luna", maxTokens: 256000, reasoningEffort: "low" });
  // C: the host subagent writer's version-2 descriptor.
  row("subagent/descriptor", 4, { version: 2, mode: "continuable", provider: "spawn", label: "梳理规则测试", agentProvider: "openai", agentModel: "gpt-5.6-sol" });
  // Control: a conforming activity row that must not be touched.
  row("command/run", 5, { commandId: "c2", name: "organize-memories", args: "整理", source: { kind: "user" } });
  // D: the 0.1.2 title writer recorded the prompt text but an off-by-N seq; seq 6
  // here is a turn/start, while the human message sits at 8.
  row("turn/start", 6, { turn: 1 });
  row("step/start", 7, { turn: 1, step: 1 });
  row("user/message", 8, { content: [{ type: "text", text: "我想做一个 timefs" }], role: "user", source: { kind: "user" } });
  row("session/title", 9, { title: "我想做一个 timefs", messageSeqs: [6], source: { kind: "fallback" } });
  row("session/title-llm-request", 10, {
    titleProvider: "session-title-first-prompt-llm",
    messageSeqs: [6],
    route: { provider: "zai", model: "glm-5.3-flash" },
    system: "Create a concise title.",
    messages: [{
      role: "user",
      source: { kind: "plugin", plugin: "dsh-session-title-llm" },
      content: [{ type: "text", text: "Generate the session title from this JSON array of human messages:\n[{\"seq\":6,\"text\":\"我想做一个 timefs\"}]" }],
      id: "titlereq"
    }]
  });
  const logPath = `${TEST_HOME}/schema-case/session.jsonl.zstd`;
  mkdirSync(`${TEST_HOME}/schema-case`, { recursive: true });
  writeTwoFrameLog(logPath, lines.join("\n") + "\n");

  const parsed = repoNormalize.scanLegacyShapes(repoRepair.parseLog(lines.join("\n") + "\n").rows);
  check("scan finds all six shapes", parsed.length === 6);
  check("classifies each fix", JSON.stringify(parsed.map((entry) => entry.fix)) === JSON.stringify(["command-run-source", "command-done-source", "model-selection-members", "descriptor-version", "title-message-seqs", "title-message-seqs"]));
  check("nothing is unfixable", parsed.every((entry) => entry.unfixable === false));

  const scanned = host.scanSessionFile(logPath);
  check("schema violations are not corruption", scanned.corrupted === false && scanned.legacyShapes === 6);
  check("scan reports migration readiness", scanned.migrationReady === false && scanned.legacyUnfixable === 0);
  check("scan samples the first violation", scanned.legacyShapeSample?.type === "command/run" && scanned.legacyShapeSample?.fix === "command-run-source");

  const dry = host.repairLogFile(logPath, true);
  check("dry run normalizes without writing", dry.ok === true && dry.dryRun === true && dry.normalizePass?.count === 6);
  check("dry run names the shapes it would fix", JSON.stringify(dry.normalizePass.fixes) === JSON.stringify({ "command-run-source": 1, "command-done-source": 1, "model-selection-members": 1, "descriptor-version": 1, "title-message-seqs": 2 }));
  const untouched = execFileSync("zstd", ["-dc", "--", logPath]).toString("utf8");
  check("dry run leaves the file byte-identical", untouched === lines.join("\n") + "\n");

  const fixed = host.repairLogFile(logPath, false);
  check("repair writes and verifies", fixed.ok === true && fixed.verified === true && fixed.legacyShapes === 6);
  const after = execFileSync("zstd", ["-dc", "--", logPath]).toString("utf8");
  const objs = after.split("\n").filter((line) => line !== "").slice(1).map((line) => JSON.parse(line));
  check("seqs are untouched by normalization", JSON.stringify(objs.map((o) => o.seq)) === JSON.stringify([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
  check("command/run carries the released source", JSON.stringify(objs[1].data.source) === JSON.stringify({ kind: "user" }));
  check("command/done lost its source member", objs[2].data.source === undefined && objs[2].data.text === "ok");
  check("model/selection keeps the declared members", JSON.stringify(objs[3].data) === JSON.stringify({ provider: "codelink", model: "gpt-5.6-luna", reasoningEffort: "low" }));
  check("descriptor is bumped to version 3 with its members intact", objs[4].data.version === 3 && objs[4].data.agentProvider === "openai" && objs[4].data.label === "梳理规则测试");
  check("conforming rows are left alone", JSON.stringify(objs[5].data) === JSON.stringify({ commandId: "c2", name: "organize-memories", args: "整理", source: { kind: "user" } }));
  check("title cites the human message it recorded", JSON.stringify(objs[9].data.messageSeqs) === JSON.stringify([8]));
  check("title request realigns with its sibling", JSON.stringify(objs[10].data.messageSeqs) === JSON.stringify([8]));
  check("title request keeps the framing it actually sent", objs[10].data.messages[0].content[0].text.includes('"seq":6'));
  check("normalized log scans clean and migration ready", host.scanSessionFile(logPath).legacyShapes === 0 && host.scanSessionFile(logPath).migrationReady === true);
  const real = scanWithRealDecoder(after);
  check("real DSH decoder accepts the normalized log", real.ok && real.events === 11);
  check("normalized log needs no second repair", host.repairLogFile(logPath, false).status === 409);

  // A descriptor that cannot become v3 by a version bump alone must be refused,
  // not silently rewritten.
  const badLines = [HEADER, JSON.stringify({ type: "subagent/descriptor", seq: 0, time: 1, data: { version: 2, mode: "continuable", provider: "spawn", label: "x", surprise: true } })];
  const badPath = `${TEST_HOME}/schema-bad/session.jsonl.zstd`;
  mkdirSync(`${TEST_HOME}/schema-bad`, { recursive: true });
  writeTwoFrameLog(badPath, badLines.join("\n") + "\n");
  const badScan = host.scanSessionFile(badPath);
  check("unfixable violation is reported", badScan.legacyShapes === 1 && badScan.legacyUnfixable === 1 && badScan.migrationReady === false);
  const badRepair = host.repairLogFile(badPath, false);
  check("unfixable violation refuses the write", badRepair.ok === false && badRepair.status === 422);
  check("refused write leaves the file untouched", execFileSync("zstd", ["-dc", "--", badPath]).toString("utf8") === badLines.join("\n") + "\n");

  // Workspace-level sweep: the offline pre-upgrade view names the sessions a
  // newer line would refuse to migrate without calling them damaged.
  const sweepCwd = "/tmp/schema-sweep";
  const sweepId = "session-11111111-2222-4333-8444-55555555555a";
  const sweepDir = `${TEST_HOME}/sessions/${repoRepair.projectKey(sweepCwd)}/${sweepId}`;
  mkdirSync(sweepDir, { recursive: true });
  // The scan reports the id from the stored header, so the fixture keeps the
  // header and the directory in agreement exactly as a real store does.
  const sweepLines = [JSON.stringify({ ...JSON.parse(HEADER), id: sweepId }), ...lines.slice(1)];
  writeTwoFrameLog(`${sweepDir}/session.jsonl.zstd`, sweepLines.join("\n") + "\n");
  const sweep = host.scanWorkspaces(sweepCwd);
  check("workspace sweep counts healthy-but-unmigratable sessions", sweep.sessions.length === 0 && sweep.healthyCount === 1 && sweep.legacyShapedCount === 1);
  check("workspace sweep names the session", sweep.needsNormalization[0]?.sessionId === sweepId && sweep.needsNormalization[0]?.legacyShapes === 6);

  // The pre-upgrade verb itself, including its option parsing: `normalize-all` has
  // no positional argument, so its first flag lands in the positional slot — a
  // parser that only reads the tail silently turns `--dry-run` into a real write.
  const cliRun = (args) => JSON.parse(execFileSync("node", [`${INSTALLED_PLUGIN_DIR}/lib/cli.mjs`, ...args], { encoding: "utf8", env: { ...process.env, DSH_HOME: TEST_HOME } }));
  const sweepFile = `${sweepDir}/session.jsonl.zstd`;
  const dirtyBytes = readFileSync(sweepFile);
  const cliDry = cliRun(["normalize-all", "--dry-run"]);
  check("CLI dry run reports itself as a dry run", cliDry.dryRun === true && cliDry.scanned === 1 && cliDry.normalized === 1 && cliDry.failed === 0);
  check("CLI dry run writes nothing", readFileSync(sweepFile).equals(dirtyBytes));
  const cliFresh = cliRun(["normalize-all", "--min-age-seconds", "3600"]);
  check("CLI age guard skips a just-written log", cliFresh.dryRun === false && cliFresh.normalized === 0 && cliFresh.skipped === 1 && cliFresh.skipDetail[0]?.reason === "modified within --min-age-seconds");
  check("CLI age guard writes nothing", readFileSync(sweepFile).equals(dirtyBytes));
  const cliSkip = cliRun(["normalize-all", "--skip", sweepId]);
  check("CLI skip guard names the session it left alone", cliSkip.normalized === 0 && cliSkip.skipped === 1 && cliSkip.skipDetail[0]?.reason === "skipped by --skip");
  const cliReal = cliRun(["normalize-all", "--min-age-seconds", "0"]);
  check("CLI sweep normalizes and verifies the log", cliReal.normalized === 1 && cliReal.failed === 0 && cliReal.results[0]?.verified === true && cliReal.results[0]?.fixes?.["command-run-source"] === 1);
  check("CLI sweep leaves the session migration ready", host.scanSessionFile(sweepFile).legacyShapes === 0 && host.scanSessionFile(sweepFile).migrationReady === true);
}

// ---------- client contract ----------

console.log("client contract");
{
  const clientText = readFileSync(`${PLUGIN_DIR}/lib/client.js`, "utf8");
  check("registers the settings section", clientText.includes('ctx.slots.inject("settings.section"'));
  check("registers the session-header utility", clientText.includes('ctx.slots.inject("conversation.session.header.utilities"'));
  check("header entry keeps a distinct order in the utilities band", /id: "session-repair",\s*\n\s*order: 74/.test(clientText));
  check("trigger reads cwd from the sessions list store", clientText.includes("useSessions"));
  check("dry run doubles as the status probe", clientText.includes("dryRun: true") && clientText.includes("error.status === 409"));
  check("zh and en dictionaries both carry the trigger keys", ["trigger", "panelTitle", "damagedMsg", "repairedMsg"].every((key) =>
    (clientText.match(new RegExp(`"${key}":`, "g")) ?? []).length === 2
  ));
  check("panel paints a menu surface token, not the wallpaper-transparent base", clientText.includes("var(--dsw-specific-menu)") && !/\.dsr-hpanel\{[^}]*bg-base/.test(clientText));
}

rmSync(TEST_HOME, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");

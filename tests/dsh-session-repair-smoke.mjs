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
 * cross-checked against the REAL DSH storage decoder.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { zstdDecompressSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const PLUGIN_DIR = fileURLToPath(new URL("../plugins/dsh-plugin-session-repair/", import.meta.url));
const INSTALLED_PLUGIN_DIR = "/home/mon3tr/.dsh/profiles/node_modules/dsh-plugin-session-repair";
const TEST_HOME = "/home/mon3tr/dsh-session-repair-test-home";
process.env.DSH_HOME = TEST_HOME;
rmSync(TEST_HOME, { recursive: true, force: true });
mkdirSync(TEST_HOME, { recursive: true });

// The DSH installation provides @deepseek-ai/* for the host half and the real
// storage decoder for cross-checking the repaired logs.
const DSH_LIB = "/home/mon3tr/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai";

const repoRepair = await import(`${PLUGIN_DIR}/lib/repair.js`);
const host = await import(`${INSTALLED_PLUGIN_DIR}/lib/index.js`);
const { decodeStorageRecord, foldSurface, decodeSeqRanges } = await import(`${DSH_LIB}/dsh-session/lib/index.js`);

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
 * The real persistence invariant, applied with DSH's own decoder: every stored
 * row expands to one or more events whose seqs must continue densely.
 */
function scanWithRealDecoder(jsonlText) {
  const lines = jsonlText.split("\n").filter((line) => line !== "");
  let expected = 0;
  for (const [index, line] of lines.slice(1).entries()) {
    for (const event of decodeStorageRecord(JSON.parse(line))) {
      if (event.seq !== expected) {
        return { ok: false, expected, got: event.seq, index: index + 1 };
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

  // Fold the repaired events exactly as the restore path does: chunk rows
  // expand to assistant/chunk events, stored provenance ranges decode first.
  const events = [];
  for (const obj of objs) {
    const span = repoRepair.rowSpan(obj);
    if (span && !(span.len === 1 && typeof obj.seq === "number")) {
      for (let k = 0; k < span.len; k++) {
        events.push({ type: "assistant/chunk", seq: span.start + k, time: obj.time0 ?? 0, data: { turn: 0, step: 0, chunk: { index: 0, type: "text-delta", text: "" } } });
      }
      continue;
    }
    events.push(Array.isArray(obj.sourceEventSeqs) ? { ...obj, sourceEventSeqs: decodeSeqRanges(obj.sourceEventSeqs) } : obj);
  }
  let foldError = null;
  try { foldSurface(events); } catch (error) { foldError = error.message; }
  check("restore surface fold accepts the repaired log", foldError === null);
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

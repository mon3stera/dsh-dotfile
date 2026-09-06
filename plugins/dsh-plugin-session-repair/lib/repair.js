/**
 * dsh-plugin-session-repair: core repair logic for session logs whose event
 * sequence numbering collided.
 *
 * The corruption pattern (observed on six real logs, 2026-08-17 .. 2026-09-06):
 * a turn is interrupted while a tool call is still pending, the interrupt path
 * persists a synthetic `interrupted-tool-result` batch, and the original
 * in-flight session object later commits the real tool result (or a queued
 * prompt splice) with its pre-interrupt event counter. The log then contains a
 * backward seq transition, and the persistence reader fails closed with
 * "seq gap in committed region".
 *
 * The stored encoding packs streaming-chunk runs into `text-chunks` /
 * `reasoning-chunks` / `tool-call-chunks` rows that carry `seq0` and expand to
 * `data.texts.length` / `data.args.length` events. Every other row carries one
 * explicit `seq` and occupies exactly one event slot. Repairs must therefore
 * shift both `seq` and `seq0`, plus the provenance references in
 * `sourceEventSeqs`.
 *
 * Fixed repair pattern (history loss is acceptable by design):
 *
 *   1. locate the first backward seq transition (expected E, got G);
 *   2. if the committed rows in [G, E) contain the synthetic interrupt batch
 *      (`interrupted-tool-result` + `step/end` + interrupted `turn/end`),
 *      delete those three rows and shift every later row down by three - this
 *      avoids leaving two tool results for one tool call, which providers
 *      reject;
 *   3. otherwise shift every row from the gap onward up by (E - G);
 *   4. repeat while the log still fails the exact contiguity scan.
 *
 * @module dsh-plugin-session-repair/repair
 */

const CHUNK_ROW_TYPES = new Set(["text-chunks", "reasoning-chunks", "tool-call-chunks"]);
const MAX_REPAIR_PASSES = 10;

/**
 * Number of event slots one stored row occupies, and its first seq.
 * Returns null for the header row (or any row without usable numbering).
 *
 * @param {object} obj - one parsed JSONL row.
 * @returns {{start: number, len: number}|null}
 */
export function rowSpan(obj) {
  if (typeof obj !== "object" || obj === null) return null;

  if (typeof obj.seq0 === "number") {
    const members = obj.type === "tool-call-chunks" ? obj.data?.args : obj.data?.texts;
    if (!Array.isArray(members)) return null;
    return { start: obj.seq0, len: members.length };
  }

  if (typeof obj.seq === "number") return { start: obj.seq, len: 1 };
  return null;
}

/**
 * Parse decompressed JSONL text into a header row plus event rows.
 * A trailing fragment without a newline is kept as a torn tail row and will
 * fail the scan; the caller can refuse to repair such files.
 *
 * @param {string} text - full decompressed log text.
 * @returns {{header: object|null, rows: Array<{line: string, obj: object}>}}
 */
export function parseLog(text) {
  const lines = text.split("\n");
  if (lines.length > 0 && lines.at(-1) === "") lines.pop();

  let header = null;
  const rows = [];
  for (const [index, line] of lines.entries()) {
    let obj = null;
    try {
      obj = JSON.parse(line);
    } catch {
      obj = { type: "<unparsable>" };
    }
    if (index === 0) header = obj;
    else rows.push({ line, obj });
  }
  return { header, rows };
}

/**
 * Exact contiguity scan over parsed rows, mirroring the persistence reader's
 * invariant (each row's event span must start at the running event count).
 *
 * @param {Array<{obj: object}>} rows - event rows (header excluded).
 * @returns {{ok: boolean, events: number, lastSeq: number, gap: {expected: number, got: number, index: number}|null}}
 */
export function scanRows(rows) {
  let expected = 0;
  for (const [index, row] of rows.entries()) {
    const span = rowSpan(row.obj);
    if (span === null) {
      return { ok: false, events: expected, lastSeq: expected - 1, gap: { expected, got: null, index } };
    }
    if (span.start !== expected) {
      return { ok: false, events: expected, lastSeq: expected - 1, gap: { expected, got: span.start, index } };
    }
    expected += span.len;
  }
  return { ok: true, events: expected, lastSeq: expected - 1, gap: null };
}

/** Shift every seq-bearing field of one row by `delta`. */
function shiftRow(obj, threshold, delta) {
  if (typeof obj === "object" && obj !== null) {
    if (typeof obj.seq === "number" && obj.seq >= threshold) obj.seq += delta;
    if (typeof obj.seq0 === "number" && obj.seq0 >= threshold) obj.seq0 += delta;
    if (Array.isArray(obj.sourceEventSeqs)) {
      obj.sourceEventSeqs = obj.sourceEventSeqs.map((seq) => (seq >= threshold ? seq + delta : seq));
    }
  }
}

/**
 * Find the synthetic interrupt batch (interrupted tool result + step/end +
 * interrupted turn/end, consecutive seqs) inside the committed rows in
 * [collisionStart, collisionEnd).
 *
 * @returns {[number, number, number]|null} file indexes of the three rows.
 */
function findSyntheticBatch(rows, collisionStart, collisionEnd) {
  // The whole three-row batch must sit strictly before the gap row.
  for (let i = collisionStart; i + 3 <= collisionEnd; i++) {
    const result = rows[i].obj;
    const stepEnd = rows[i + 1].obj;
    const turnEnd = rows[i + 2].obj;
    const resultId = result?.data?.message?.id;

    if (result?.type !== "tool/result" || typeof resultId !== "string") continue;
    if (!resultId.startsWith("interrupted-tool-result-")) continue;
    if (stepEnd?.type !== "step/end" || turnEnd?.type !== "turn/end") continue;
    if (turnEnd?.data?.reason?.kind !== "interrupted") continue;

    const spans = [result, stepEnd, turnEnd].map(rowSpan);
    if (spans.some((span) => span === null)) continue;
    if (spans[1].start !== spans[0].start + 1 || spans[2].start !== spans[0].start + 2) continue;
    return [i, i + 1, i + 2];
  }
  return null;
}

/**
 * One repair pass over the first backward seq transition. Mutates the row
 * objects in place (seq/seq0/sourceEventSeqs). Returns a summary fragment, or
 * null when nothing was done.
 *
 * Batch mode deliberately only deletes the synthetic batch and renumbers the
 * remaining committed rows; the late tail (numbered from the stale counter,
 * which sits at or below the batch) is left for the next pass, where the
 * rescanned gap yields the correct upward shift in one move.
 */
function repairPass(rows, gap) {
  const { expected, got, index } = gap;
  if (got === null || got >= expected) return null;

  // Committed rows occupying [got, expected) sit immediately before the gap.
  let collisionStart = index;
  while (collisionStart > 0) {
    const span = rowSpan(rows[collisionStart - 1].obj);
    if (span === null || span.start < got || span.start + span.len > expected) break;
    collisionStart -= 1;
  }

  const batch = findSyntheticBatch(rows, collisionStart, index);
  if (batch !== null) {
    const [start] = batch;
    const threshold = rowSpan(rows[start].obj).start + 3;
    rows.splice(start, 3);
    for (const row of rows.slice(start, index - 3)) shiftRow(row.obj, threshold, -3);
    return { mode: "delete-batch", dropped: 3, threshold, delta: -3 };
  }

  for (const row of rows.slice(index)) shiftRow(row.obj, got, expected - got);
  return { mode: "shift-tail", dropped: 0, threshold: got, delta: expected - got };
}

/**
 * Repair a parsed log with the fixed pattern until the exact scan passes.
 *
 * @param {{header: object|null, rows: Array<{line: string, obj: object}>}} parsed - from parseLog.
 * @returns {{ok: boolean, passes: Array<object>, scan: object, error: string|null}}
 */
export function repairRows(parsed) {
  const { rows } = parsed;
  const passes = [];
  for (let pass = 0; pass < MAX_REPAIR_PASSES; pass++) {
    const scan = scanRows(rows);
    if (scan.ok) return { ok: true, passes, scan, error: null };

    const done = repairPass(rows, scan.gap);
    if (done === null) {
      return { ok: false, passes, scan, error: `unrepairable gap at row ${scan.gap.index}: expected ${scan.gap.expected}, got ${scan.gap.got}` };
    }
    passes.push(done);
  }
  return { ok: false, passes, scan: scanRows(rows), error: `repair did not converge within ${MAX_REPAIR_PASSES} passes` };
}

/**
 * Rebuild the JSONL text from a parsed log (header + rows, newline terminated).
 *
 * @returns {string}
 */
export function serializeLog(parsed) {
  const lines = [parsed.header === null ? "" : JSON.stringify(parsed.header)];
  for (const row of parsed.rows) lines.push(JSON.stringify(row.obj));
  return lines.join("\n") + "\n";
}

/**
 * Readable project-directory key for a cwd, mirroring the persistence
 * backend's `projectKey`: separator runs collapse to one `-`, safe code units
 * stay literal, everything else (including `~`) escapes as `~XXXX`, the result
 * is bounded and wrapped in `--`.
 *
 * @param {string} cwd - absolute project directory.
 * @returns {string}
 */
export function projectKey(cwd) {
  let readable = "";
  let separatorRun = false;
  for (const ch of cwd) {
    const code = ch.codePointAt(0);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
      continue;
    }
    separatorRun = false;
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) readable += ch;
    else readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/**
 * Escape one path segment the way the persistence backend does.
 *
 * @param {string} raw - session id or other single segment.
 * @returns {string}
 */
export function encodeSegment(raw) {
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0);
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += "~" + code.toString(16).toUpperCase().padStart(4, "0");
  }
  return out;
}

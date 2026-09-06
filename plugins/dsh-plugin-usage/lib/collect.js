/**
 * Pure core of dsh-plugin-usage: parse a decompressed session log and derive
 * token-usage facts.
 *
 * Two kinds of numbers come out of a session log:
 *
 * - Exact per-request accounting. Every `assistant/message` event carries
 *   `data.usage` as returned by the provider: `inputTokens` (uncached input),
 *   `outputTokens`, `totalTokens` (= input + cacheRead + output), and, when
 *   the provider reports it, `cacheReadTokens` / `cacheWriteTokens`. These
 *   are real numbers, not estimates, and they power the cumulative totals,
 *   the per-request timeline, and the cache-hit / prefix-rewrite detection.
 * - An estimated composition of the current context. The log stores the
 *   assembled request material (`request/header` carries the full system
 *   prompt and the tool definitions; message events carry the conversation),
 *   so each category can be estimated with a CJK-aware character heuristic
 *   and normalized against the last request's exact `totalTokens`. Every
 *   estimate is reported alongside its raw character count so the UI can
 *   show how rough it is.
 *
 * @module dsh-plugin-usage/collect
 */

const LOG_NAME = "session.jsonl.zstd";

/** Parse decompressed JSONL text into `{ header, rows }`. */
export function parseLog(text) {
  const lines = text.split("\n");
  let header = null;
  const rows = [];

  for (const line of lines) {
    if (line === "") continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (header === null && obj.type === "session") header = obj;
    rows.push(obj);
  }
  return { header, rows };
}

/** Sum the characters of all text blocks in a message content value. */
function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    if (typeof block.text === "string") parts.push(block.text);
    else if (typeof block.input === "string") parts.push(block.input);
    else if (block.input !== undefined && block.input !== null) parts.push(JSON.stringify(block.input));
    // Tool results nest their payload one level down, in `content`.
    if (Array.isArray(block.content)) parts.push(textContent(block.content));
  }
  return parts.join("\n");
}

/** The message object carried by a surface event row, or null. */
function messageOf(row) {
  const data = row.data;
  if (data === null || typeof data !== "object") return null;
  if (data.message !== undefined) return data.message;
  // user/message rows carry the message fields directly on data.
  if (row.type === "user/message" && Array.isArray(data.content)) return data;
  return null;
}

/**
 * CJK-aware token heuristic: CJK characters are near one token each, other
 * text is roughly four characters per token. Good enough for category
 * shares; every value is labeled an estimate in the UI.
 */
export function estimateTokens(text) {
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0x3000 && code <= 0x303f)) cjk += 1;
  }
  return Math.round(cjk * 0.85 + (text.length - cjk) / 3.8);
}

/**
 * Token heuristic over a raw character count, split by the CJK share so the
 * per-category estimates can reuse one formula without materializing strings.
 * `cjkShare` is the fraction of characters that are CJK (0 for pure ASCII).
 */
export function estimateTokensChars(chars, cjkShare = 0.1) {
  const cjk = chars * cjkShare;
  const other = chars - cjk;
  return Math.round(cjk * 0.85 + other / 3.8);
}

/** Category buckets for the composition estimate, in display order. */
export const CATEGORIES = [
  ["system", "System prompt"],
  ["tools", "Tool definitions"],
  ["instructions", "Workspace instructions"],
  ["skills", "Skill catalog"],
  ["memory", "Injected context"],
  ["user", "User messages"],
  ["assistant", "Assistant messages"],
  ["tool", "Tool results"]
];

const CATEGORY_KEYS = CATEGORIES.map(([key]) => key);

function emptyChars() {
  const chars = {};
  for (const key of CATEGORY_KEYS) chars[key] = 0;
  return chars;
}

/** Map a message source kind to a composition category. */
function categoryOf(sourceKind, role) {
  if (role === "tool") return "tool";
  if (role === "assistant") return "assistant";
  switch (sourceKind) {
    case "user":
      return "user";
    case "agent-instructions":
      return "instructions";
    case "skill-catalog":
      return "skills";
    case "plugin":
      return "memory";
    default:
      return "user";
  }
}

/** Character shares of the conversation material, deduplicated by message id. */
export function compositionChars(rows) {
  const chars = emptyChars();
  const cjk = emptyChars();
  const seen = new Set();

  const count = (key, text) => {
    chars[key] += text.length;
    for (const ch of text) {
      const code = ch.codePointAt(0);
      if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0x3000 && code <= 0x303f)) cjk[key] += 1;
    }
  };

  for (const row of rows) {
    const data = row?.data;
    let message = null;
    if (row.type === "user/message" || row.type === "assistant/message" || row.type === "tool/result") {
      message = messageOf(row);
    } else if (row.type === "agent/inbox/spliced" && Array.isArray(data?.inserted)) {
      // Spliced inserts carry the same message id as their surface rows, so
      // counting here and deduplicating by id counts each message once even
      // when the surface event never arrives.
      for (const item of data.inserted) {
        if (item === null || typeof item !== "object") continue;
        if (typeof item.id === "string") {
          if (seen.has(item.id)) continue;
          seen.add(item.id);
        }
        const key = categoryOf(item.source?.kind, item.role);
        count(key, textContent(item.content));
      }
      continue;
    }
    if (message === null || typeof message !== "object") continue;
    const id = typeof message.id === "string" ? message.id : null;
    if (id !== null) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    // The row type is authoritative: some tool-result envelopes carry
    // role "user", so the envelope role alone would misfile them.
    const key = row.type === "tool/result" ? "tool" : categoryOf(message.source?.kind, message.role);
    count(key, textContent(message.content));
  }
  return { chars, cjk };
}

/** One request's exact usage, plus running totals. */
function requestRow(event, model, index, running) {
  const usage = event.data.usage ?? {};
  const input = numberOr(usage.inputTokens, 0);
  const output = numberOr(usage.outputTokens, 0);
  const total = numberOr(usage.totalTokens, input + output);
  const cacheRead = usage.cacheReadTokens === undefined ? null : numberOr(usage.cacheReadTokens, 0);
  const cacheWrite = usage.cacheWriteTokens === undefined ? null : numberOr(usage.cacheWriteTokens, 0);

  running.requests += 1;
  running.input += input;
  running.output += output;
  running.total += total;
  if (cacheRead !== null) running.cacheRead += cacheRead;
  if (cacheWrite !== null) running.cacheWrite += cacheWrite;

  // A later request that reads no cache re-sent the whole prefix. A request
  // that reads far less than the previous context size probably re-sent most
  // of it; both are what makes billed input explode.
  let rewrite = null;
  if (index > 0 && cacheRead !== null && cacheRead === 0) rewrite = "full";
  else if (index > 0 && cacheRead !== null && running.prevTotal > 20000 && cacheRead < running.prevTotal * 0.5) rewrite = "partial";

  running.prevTotal = total;
  return {
    index,
    time: event.time ?? null,
    turn: event.data.turn ?? null,
    step: event.data.step ?? null,
    model,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    totalTokens: total,
    cumulative: { requests: running.requests, input: running.input, output: running.output, total: running.total },
    rewrite
  };
}

function numberOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** One turn's rolled-up usage. */
function turnSummary(turn) {
  const requests = turn.requests.length;
  let input = 0;
  let output = 0;
  let total = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let hasRead = false;
  let hasWrite = false;

  for (const request of turn.requests) {
    input += request.inputTokens;
    output += request.outputTokens;
    total += request.totalTokens;
    if (request.cacheReadTokens !== null) {
      cacheRead += request.cacheReadTokens;
      hasRead = true;
    }
    if (request.cacheWriteTokens !== null) {
      cacheWrite += request.cacheWriteTokens;
      hasWrite = true;
    }
  }
  const summary = { turn: turn.turn, requests, inputTokens: input, outputTokens: output, totalTokens: total, cacheReadTokens: hasRead ? cacheRead : null, cacheWriteTokens: hasWrite ? cacheWrite : null, firstTime: turn.requests[0]?.time ?? null, lastTime: turn.requests[requests - 1]?.time ?? null };
  return summary;
}

/**
 * Derive every usage fact from parsed rows.
 * @returns session facts with exact request rows, exact aggregates, and the
 *   estimated composition of the latest request's context.
 */
export function collectUsage(rows, header) {
  let model = null;
  let provider = null;
  let contextWindow = null;
  let systemChars = 0;
  let toolChars = 0;
  const requests = [];
  const turns = new Map();
  const running = { requests: 0, input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, prevTotal: 0 };

  for (const row of rows) {
    if (row.type === "request/header") {
      const raw = row.data?.header;
      let parsed = null;
      try {
        parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch {
        parsed = null;
      }
      if (parsed !== null) {
        model = parsed.config?.model ?? model;
        provider = parsed.config?.provider ?? provider;
        if (typeof parsed.system === "string") systemChars += parsed.system.length;
        if (Array.isArray(parsed.tools)) {
          for (const tool of parsed.tools) toolChars += JSON.stringify(tool).length;
        }
      }
      continue;
    }

    if (row.type === "request/context") {
      if (typeof row.data?.contextWindow === "number") contextWindow = row.data.contextWindow;
      if (row.data?.model) model = row.data.model;
      if (row.data?.provider) provider = row.data.provider;
      continue;
    }

    if (row.type === "assistant/message" && row.data?.usage !== undefined) {
      const request = requestRow(row, model, requests.length, running);
      requests.push(request);
      const turn = request.turn ?? 0;
      if (!turns.has(turn)) turns.set(turn, { turn, requests: [] });
      turns.get(turn).requests.push(request);
    }
  }

  const last = requests[requests.length - 1] ?? null;
  const { chars, cjk } = compositionChars(rows);
  chars.system += systemChars;
  chars.tools += toolChars;

  const estimated = {};
  let estimatedTotal = 0;
  for (const key of CATEGORY_KEYS) {
    const tokens = estimateTokensChars(chars[key], chars[key] > 0 ? cjk[key] / chars[key] : 0);
    estimated[key] = { chars: chars[key], tokens };
    estimatedTotal += tokens;
  }

  // Normalize the heuristic estimate to the last request's exact total so the
  // shares are anchored to a real number. The raw estimate stays visible as
  // `estimatedTokens` for calibration.
  const actualTotal = last?.totalTokens ?? null;
  let composition = null;
  if (actualTotal !== null && actualTotal > 0) {
    composition = {};
    for (const key of CATEGORY_KEYS) {
      const share = estimatedTotal > 0 ? estimated[key].tokens / estimatedTotal : 0;
      composition[key] = { tokens: Math.round(share * actualTotal), chars: estimated[key].chars, share };
    }
  }

  const rewrites = requests.filter((request) => request.rewrite !== null).length;
  const billedInput = running.input + running.cacheRead + running.cacheWrite;
  return {
    requests,
    turns: [...turns.values()].map(turnSummary),
    totals: {
      requests: running.requests,
      inputTokens: running.input,
      outputTokens: running.output,
      cacheReadTokens: running.cacheRead,
      cacheWriteTokens: running.cacheWrite,
      totalTokens: running.total,
      billedInputTokens: billedInput,
      cacheHitRate: billedInput > 0 ? running.cacheRead / billedInput : null,
      fullRewrites: requests.filter((request) => request.rewrite === "full").length,
      suspectedRewrites: rewrites
    },
    composition,
    compositionRaw: { chars, estimatedTokens: estimated, estimatedTotal, actualTotal },
    lastTotalTokens: last?.totalTokens ?? null,
    contextWindow,
    models: [...new Set(requests.map((request) => request.model).filter(Boolean))],
    provider
  };
}

/** Summarize a parsed log without keeping the full request list. */
export function summarizeUsage(collected, header, meta) {
  const totals = collected.totals;
  return {
    sessionId: header?.id ?? null,
    createdAt: header?.createdAt ?? null,
    agentPreset: header?.agentPreset ?? null,
    cwd: header?.cwd ?? null,
    lastActivity: collected.requests[collected.requests.length - 1]?.time ?? header?.createdAt ?? null,
    contextWindow: collected.contextWindow,
    lastTotalTokens: collected.lastTotalTokens,
    models: collected.models,
    provider: collected.provider,
    ...totals,
    ...meta
  };
}

export { LOG_NAME };

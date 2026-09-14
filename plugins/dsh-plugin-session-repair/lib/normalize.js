/**
 * Schema hygiene for released-v0 session logs.
 *
 * The 0.1.5 Session-format catalog freezes the released v0 member inventory and
 * audits a stored log against it BEFORE any migration runs. A row carrying a
 * member the inventory does not declare refuses the whole Session with
 * `SessionFormatUnsupportedError`, and the write-open a resume performs is what
 * fails: the session stays listed, its file stays byte-identical, and it simply
 * cannot be continued on the newer line.
 *
 * Four shapes written by this deployment's own history trip that audit, plus one
 * reference violation the same audit catches later in the migration chain. All of
 * them are inert on the 0.1.2 line (nothing validates a plugin append, and the
 * loader does not check members), so rewriting them is backward compatible:
 *
 *   command/run.source      {kind:"plugin",plugin:"dsh-magic-context"} -> {kind:"user"}
 *       The released inventory types this as exactly `{kind:"user"}`
 *       (`literalValue(exactRecord(data.source, ["kind"]), ["user"])` in
 *       dsh-session-format-v0-to-v1). The plugin attribution lives in the
 *       `commandId` namespace (`dsh-magic-context/...`) and in the row title, so
 *       nothing user-visible is lost.
 *   command/done.source     dropped — the type declares no `source` member.
 *   model/selection         members outside {provider, model, reasoningEffort}
 *                           dropped. The 0.1.2 host wrote `maxTokens` straight
 *                           from its own `resolveCallConfig` result; the frozen
 *                           inventory does not declare it.
 *   subagent/descriptor     version 2 -> 3. The frozen inventory requires the
 *                           literal 3; the member set is otherwise identical, so
 *                           the bump happens only when the rest of the row
 *                           already matches the v3 shape.
 *   session/title           `messageSeqs` realigned onto the human messages the
 *   session/title-llm-       row itself records citing. The frozen codec resolves
 *   request                 every citation against earlier `user/message` rows
 *                           whose source kind is `user`, and demands an empty
 *                           list exactly for a user-set title; the 0.1.2 title
 *                           writer stored the prompt text correctly but a seq
 *                           that lands on a `turn/start`.
 *
 * Nothing here renumbers events, so a normalization never invalidates the
 * seq-keyed references dsh-magic-context stores for the session (paragraph
 * numbers, compartment spans, memory provenance).
 */

/** Payload members the released inventory declares for the audited types. */
const MEMBERS = Object.freeze({
  "command/run": Object.freeze(["commandId", "name", "args", "source"]),
  "command/done": Object.freeze(["commandId", "kind", "text", "sourceEventSeq"]),
  "model/selection": Object.freeze(["provider", "model", "reasoningEffort"]),
});

const DESCRIPTOR_VERSION = 3;
const DESCRIPTOR_BASE = Object.freeze(["mode", "provider", "label"]);
const DESCRIPTOR_CONTINUABLE_OPTIONAL = Object.freeze([
  "agentProvider",
  "agentModel",
  "agentReasoningEffort",
  "persona",
  "toolFilter",
]);

/** Rows whose `messageSeqs` the frozen codec resolves against human messages. */
const TITLE_TYPES = Object.freeze(["session/title", "session/title-llm-request"]);

/** The framing `dsh-session-title-llm` puts in front of its cited-message JSON. */
const TITLE_FRAMING_PREFIX = "Generate the session title from this JSON array of human messages:\n";

/** Fix identifiers, stable across the scan report and the repair summary. */
export const NORMALIZE_FIX = Object.freeze({
  COMMAND_RUN_SOURCE: "command-run-source",
  COMMAND_RUN_MEMBERS: "command-run-members",
  COMMAND_DONE_SOURCE: "command-done-source",
  COMMAND_DONE_MEMBERS: "command-done-members",
  MODEL_SELECTION_MEMBERS: "model-selection-members",
  DESCRIPTOR_VERSION: "descriptor-version",
  TITLE_MESSAGE_SEQS: "title-message-seqs",
});

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/** Members of `value` outside `allowed`, in insertion order. */
function extraMembers(value, allowed) {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

/**
 * Whether one descriptor row can become a v3 descriptor by a version bump
 * alone: the mode must be known, every member must belong to that mode's v3
 * set, and the members the v3 validator requires must be present and typed.
 */
function descriptorBumpIssue(data) {
  const mode = data.mode;
  const allowed = mode === "one-shot"
    ? DESCRIPTOR_BASE
    : mode === "continuable"
      ? [...DESCRIPTOR_BASE, ...DESCRIPTOR_CONTINUABLE_OPTIONAL]
      : null;
  if (allowed === null) {
    return { detail: `unknown mode ${JSON.stringify(mode ?? null)}`, unfixable: true };
  }
  const extra = extraMembers(data, [...allowed, "version"]);
  if (extra.length > 0) {
    return { detail: `member "${extra[0]}" is not part of the v3 descriptor`, unfixable: true };
  }
  if (!nonEmptyString(data.provider)) {
    return { detail: "provider is not a non-empty string", unfixable: true };
  }
  if (mode === "one-shot") {
    if (data.label !== undefined && typeof data.label !== "string") {
      return { detail: "label is not a string", unfixable: true };
    }
    return { detail: "version 2 -> 3", unfixable: false };
  }
  if (!nonEmptyString(data.label)) {
    return { detail: "continuable descriptor needs a non-empty label", unfixable: true };
  }
  for (const key of ["agentProvider", "agentModel", "agentReasoningEffort", "persona"]) {
    if (data[key] !== undefined && !nonEmptyString(data[key])) {
      return { detail: `${key} is not a non-empty string`, unfixable: true };
    }
  }
  if ((data.agentProvider === undefined) !== (data.agentModel === undefined)) {
    return { detail: "agentProvider and agentModel must be paired", unfixable: true };
  }
  if (data.toolFilter !== undefined) {
    const filter = data.toolFilter;
    if (!isRecord(filter)) return { detail: "toolFilter is not an object", unfixable: true };
    const filterExtra = extraMembers(filter, ["allow", "deny"]);
    if (filterExtra.length > 0) {
      return { detail: `toolFilter member "${filterExtra[0]}"`, unfixable: true };
    }
    if (filter.allow === undefined && filter.deny === undefined) {
      return { detail: "toolFilter needs allow or deny", unfixable: true };
    }
    for (const key of ["allow", "deny"]) {
      if (filter[key] === undefined) continue;
      if (!Array.isArray(filter[key]) || filter[key].some((name) => !nonEmptyString(name))) {
        return { detail: `toolFilter.${key} is not an array of non-empty strings`, unfixable: true };
      }
    }
  }
  return { detail: "version 2 -> 3", unfixable: false };
}

/**
 * Read one row's schema violation, or null when the row already conforms.
 *
 * @param {object} obj - one parsed log row.
 * @param {{rows: Array<{obj: object}>, index: number}} [context] - the whole log,
 *   needed by the reference rules (title citations) that resolve against it.
 * @returns {{fix: string, detail: string, unfixable: boolean}|null}
 */
function rowIssue(obj, context) {
  if (!isRecord(obj) || !isRecord(obj.data)) return null;
  const data = obj.data;

  if (obj.type === "command/run" || obj.type === "command/done") {
    const isRun = obj.type === "command/run";
    const belongs = isRecord(data.source) ? data.source : null;
    if (isRun && (belongs === null || Object.keys(belongs).length !== 1 || belongs.kind !== "user")) {
      return {
        fix: NORMALIZE_FIX.COMMAND_RUN_SOURCE,
        detail: `source ${JSON.stringify(data.source ?? null)}`,
        unfixable: false,
      };
    }
    if (!isRun && Object.hasOwn(data, "source")) {
      return {
        fix: NORMALIZE_FIX.COMMAND_DONE_SOURCE,
        detail: `source ${JSON.stringify(data.source ?? null)}`,
        unfixable: false,
      };
    }
    const extra = extraMembers(data, MEMBERS[obj.type]);
    if (extra.length > 0) {
      return {
        fix: isRun ? NORMALIZE_FIX.COMMAND_RUN_MEMBERS : NORMALIZE_FIX.COMMAND_DONE_MEMBERS,
        detail: `member ${extra.map((key) => `"${key}"`).join(", ")}`,
        unfixable: false,
      };
    }
    return null;
  }

  if (obj.type === "model/selection") {
    const extra = extraMembers(data, MEMBERS["model/selection"]);
    if (extra.length === 0) return null;
    const missing = ["provider", "model"].filter((key) => !nonEmptyString(data[key]));
    return {
      fix: NORMALIZE_FIX.MODEL_SELECTION_MEMBERS,
      detail: extra.map((key) => `"${key}"`).join(", "),
      // Nothing to fall back on when the row is missing the members the
      // inventory requires; dropping the extras would still leave it invalid.
      unfixable: missing.length > 0,
    };
  }

  if (obj.type === "subagent/descriptor") {
    if (data.version === DESCRIPTOR_VERSION) return null;
    if (data.version !== 2) {
      return {
        fix: NORMALIZE_FIX.DESCRIPTOR_VERSION,
        detail: `version ${JSON.stringify(data.version ?? null)}`,
        unfixable: true,
      };
    }
    const issue = descriptorBumpIssue(data);
    return { fix: NORMALIZE_FIX.DESCRIPTOR_VERSION, detail: issue.detail, unfixable: issue.unfixable };
  }

  if (TITLE_TYPES.includes(obj.type)) {
    const seqs = data.messageSeqs;
    if (!Array.isArray(seqs) || seqs.some((seq) => typeof seq !== "number")) {
      return { fix: NORMALIZE_FIX.TITLE_MESSAGE_SEQS, detail: "messageSeqs is not an array of seqs", unfixable: true };
    }
    const plan = realignTitleSeqs(obj, context);
    if (plan !== null && sameNumbers(plan, seqs)) return null;
    return {
      fix: NORMALIZE_FIX.TITLE_MESSAGE_SEQS,
      detail: plan === null
        ? `messageSeqs ${JSON.stringify(seqs)} do not resolve to the human messages this row cites`
        : `messageSeqs ${JSON.stringify(seqs)} -> ${JSON.stringify(plan)}`,
      unfixable: plan === null,
    };
  }

  return null;
}

/** The text a `user/message` row carries, or null when it carries none. */
function messageText(obj) {
  const content = obj?.data?.content;
  if (!Array.isArray(content)) return null;
  const parts = content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text);
  return parts.length > 0 ? parts.join("\n") : null;
}

/** Whether a row is a human user message: `user/message` with a user source. */
function isHumanMessage(obj) {
  return obj?.type === "user/message" && isRecord(obj.data) && obj.data.source?.kind === "user";
}

function sameNumbers(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * The texts this row's citations were built from, index-aligned.
 *
 * A `session/title-llm-request` records them itself in its framed prompt (the
 * exact JSON array of `{seq, text}` the title model was shown). A plain
 * `session/title` carries no text, so the sibling request row written in the same
 * breath supplies them when it cites the same number of messages.
 */
function titleReferenceTexts(obj, context) {
  const framing = obj.type === "session/title-llm-request" ? framedReferenceJson(obj) : null;
  if (framing !== null) return framing;
  const rows = context?.rows ?? [];
  const own = obj.data.messageSeqs;
  for (const row of rows) {
    const candidate = row.obj;
    if (candidate?.type !== "session/title-llm-request") continue;
    const seqs = candidate.data?.messageSeqs;
    if (!Array.isArray(seqs) || seqs.length !== own.length) continue;
    const texts = framedReferenceJson(candidate);
    if (texts !== null) return texts;
  }
  return null;
}

/** The `{seq, text}` array inside a title request's framed prompt, or null. */
function framedReferenceJson(obj) {
  const text = obj.data?.messages?.[0]?.content?.[0]?.text;
  if (typeof text !== "string" || !text.startsWith(TITLE_FRAMING_PREFIX)) return null;
  try {
    const parsed = JSON.parse(text.slice(TITLE_FRAMING_PREFIX.length));
    if (!Array.isArray(parsed)) return null;
    return parsed.map((entry) => (typeof entry?.text === "string" ? entry.text : null));
  } catch {
    return null;
  }
}

/**
 * Plan a citation list that satisfies the frozen reference rule, or null when no
 * defensible realignment exists.
 *
 * The rule (dsh-session-format-v0-to-v1 `assertTitleSources`): every cited seq
 * must be an earlier `user/message` whose source kind is `user`, and a
 * `session/title` must cite nothing exactly when its own source kind is `user`.
 * The 0.1.2 title writer violated it — `dsh-session-title-llm` recorded the
 * prompt text correctly but an off-by-N seq that lands on a `turn/start` — and a
 * log carrying such a citation refuses migration on a newer line.
 *
 * Realignment prefers the strongest evidence available: the message the row's own
 * record says it cited (matched by text), then a positional match when the citation
 * count and the human-message count agree.
 */
function realignTitleSeqs(obj, context) {
  const seqs = obj.data.messageSeqs;
  if (obj.type === "session/title" && obj.data.source?.kind === "user") {
    // A user-set title cites nothing by definition.
    return [];
  }
  const candidates = (context?.rows ?? [])
    .map((row) => row.obj)
    .filter((candidate) => isHumanMessage(candidate) && typeof candidate.seq === "number" && candidate.seq < obj.seq);
  if (candidates.length === 0) return null;
  if (seqs.length === 0) {
    // A fallback/provider title must cite the prompt it was derived from; with
    // nothing recorded, the first human message is the only defensible source.
    return [candidates[0].seq];
  }
  const texts = titleReferenceTexts(obj, context);
  const used = new Set();
  const planned = [];
  for (const [index, seq] of seqs.entries()) {
    const cited = candidates.find((candidate) => candidate.seq === seq);
    if (cited !== undefined) {
      used.add(cited.seq);
      planned.push(cited.seq);
      continue;
    }
    const wanted = texts?.[index];
    const match = wanted === null || wanted === undefined
      ? undefined
      : candidates.find((candidate) => !used.has(candidate.seq) && messageText(candidate) === wanted);
    const fallback = candidates.length === seqs.length ? candidates[index] : undefined;
    const chosen = match ?? (fallback !== undefined && !used.has(fallback.seq) ? fallback : undefined);
    if (chosen === undefined) return null;
    used.add(chosen.seq);
    planned.push(chosen.seq);
  }
  return planned;
}

/**
 * Report every released-v0 schema violation in a parsed log, without changing
 * anything. Structurally healthy logs can (and do) carry these: they refuse a
 * newer line's migration while remaining loadable on 0.1.2.
 *
 * @param {Array<{obj: object}>} rows - event rows (header excluded).
 * @returns {Array<{seq: number|null, type: string|null, fix: string, detail: string, unfixable: boolean}>}
 */
export function scanLegacyShapes(rows) {
  const found = [];
  for (const [index, row] of rows.entries()) {
    const issue = rowIssue(row.obj, { rows, index });
    if (issue === null) continue;
    found.push({
      seq: typeof row.obj.seq === "number" ? row.obj.seq : null,
      type: typeof row.obj.type === "string" ? row.obj.type : null,
      fix: issue.fix,
      detail: issue.detail,
      unfixable: issue.unfixable,
    });
  }
  return found;
}

/** Apply one row's fix in place. Assumes {@link rowIssue} found a fixable one. */
function applyFix(obj, fix, context) {
  const data = obj.data;
  switch (fix) {
    case NORMALIZE_FIX.COMMAND_RUN_SOURCE:
      data.source = { kind: "user" };
      return;
    case NORMALIZE_FIX.COMMAND_DONE_SOURCE:
      delete data.source;
      return;
    case NORMALIZE_FIX.COMMAND_RUN_MEMBERS:
      for (const key of extraMembers(data, MEMBERS["command/run"])) delete data[key];
      return;
    case NORMALIZE_FIX.COMMAND_DONE_MEMBERS:
      for (const key of extraMembers(data, MEMBERS["command/done"])) delete data[key];
      return;
    case NORMALIZE_FIX.MODEL_SELECTION_MEMBERS:
      for (const key of extraMembers(data, MEMBERS["model/selection"])) delete data[key];
      return;
    case NORMALIZE_FIX.DESCRIPTOR_VERSION:
      data.version = DESCRIPTOR_VERSION;
      return;
    case NORMALIZE_FIX.TITLE_MESSAGE_SEQS: {
      const plan = realignTitleSeqs(obj, context);
      // rowIssue marked the row fixable, so the plan recomputes here; the framing
      // prompt of a title request is left as written, because it records what the
      // title model was actually sent and the frozen audit does not re-derive it
      // (real migrated logs carry stale seqs inside that text and are accepted).
      if (plan === null) throw new Error("title citation realignment stopped being possible");
      data.messageSeqs = plan;
      return;
    }
    default:
      throw new Error(`unknown normalization fix ${JSON.stringify(fix)}`);
  }
}

/**
 * Normalize every fixable violation in a parsed log, in place.
 *
 * @param {Array<{obj: object}>} rows - event rows (header excluded).
 * @returns {{ok: boolean, count: number, fixes: Record<string, number>, unfixable: Array<object>}}
 */
export function normalizeRows(rows) {
  const fixes = {};
  const unfixable = [];
  for (const [index, row] of rows.entries()) {
    const issue = rowIssue(row.obj, { rows, index });
    if (issue === null) continue;
    if (issue.unfixable) {
      unfixable.push({
        seq: typeof row.obj.seq === "number" ? row.obj.seq : null,
        type: typeof row.obj.type === "string" ? row.obj.type : null,
        fix: issue.fix,
        detail: issue.detail,
      });
      continue;
    }
    applyFix(row.obj, issue.fix, { rows, index });
    fixes[issue.fix] = (fixes[issue.fix] ?? 0) + 1;
  }
  const count = Object.values(fixes).reduce((total, value) => total + value, 0);
  return { ok: unfixable.length === 0, count, fixes, unfixable };
}

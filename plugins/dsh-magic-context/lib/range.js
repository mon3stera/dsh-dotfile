// Compartment range selection: the span fixed at GENERATION time.
//
// retainRounds is the historical config key, but its value means the number
// of recent paragraph-numbered model-visible messages retained verbatim. The
// engine supplies the durable paragraph lookup from ContextDb; the local
// fallback keeps detached range tests and older sessions usable when a number
// has not been assigned yet. The landing later replaces exactly this span.
//
// 0.1.5 puts the rendered system prompt at surface node 0 as a
// `system/message`. The host fold rejects a user-message replacement covering
// that node ("node 0 holds the system prompt…"), so every selected range
// starts at the first non-system node — the same rule as dsh-compaction-basic.
// Later system nodes (in-history prompt updates) are ordinary history.
import { isCompactCheckpointSource, toolPairingBalancedAfter, toolPairingBalancedBefore } from "@deepseek-ai/dsh-compaction";
import { sessionEventAt } from "./session-compat.js";

const SKIPPED_TOOL_NAMES = new Set(["ctx_reduce", "ctx_expand"]);

/** Detect an excluded tool result when durable paragraph metadata is absent. */
function isSkippedToolResult(session, event) {
	const callId = event.data?.message?.source?.callId ?? event.data?.callId;
	if (callId === undefined) return false;
	for (let index = event.seq - 1; index >= 0; index -= 1) {
		const earlier = sessionEventAt(session, index);
		if (earlier?.type === "tool/call" && earlier.data?.callId === callId) return SKIPPED_TOOL_NAMES.has(earlier.data.name);
	}
	return false;
}

/** True when one surface event is a compaction checkpoint node (any engine). */
function isCheckpointNode(session, seq) {
	const event = sessionEventAt(session, seq);
	return event?.type === "user/message" && event.data?.source !== undefined && isCompactCheckpointSource(event.data.source);
}

/**
 * Seq of the protected system prompt at surface node 0, or `undefined`.
 *
 * 0.1.5 made the rendered prompt a `system/message` surface node. The host
 * fold refuses any replacement covering that node unless the replacement is
 * itself a `system/message` over exactly that node — a user-message checkpoint
 * therefore must never start there. Later system nodes (in-history prompt
 * updates) are ordinary history and may be shadowed. Matches
 * `dsh-compaction-basic`'s `systemHead`.
 */
export function protectedSystemHeadSeq(session) {
	const nodes = session.surface.nodes;
	if (nodes.length === 0) return undefined;
	const head = sessionEventAt(session, nodes[0]);
	return head?.type === "system/message" ? nodes[0] : undefined;
}

/**
 * Every seq the current system head has replaced, including itself.
 *
 * Each prompt update rewrites node 0 with a new `system/message` whose
 * `surfaceOp` names the previous head. A compartment generated against an
 * older prompt still "starts at the system head" after those updates, even
 * though the stored start seq is no longer on the surface.
 */
export function protectedSystemHeadChain(session) {
	const seqs = new Set();
	let seq = protectedSystemHeadSeq(session);
	while (seq !== undefined && !seqs.has(seq)) {
		seqs.add(seq);
		const event = sessionEventAt(session, seq);
		if (event?.type !== "system/message") break;
		const op = event.surfaceOp;
		if (op === undefined || op === "append") break;
		const previous = op.startSeq ?? op.start;
		if (!Number.isSafeInteger(previous)) break;
		seq = previous;
	}
	return seqs;
}

/**
 * First surface index a compaction range may start at: after the protected
 * system head, after every contiguous head checkpoint, snapped to a
 * tool-balanced cut. The 0.1.5 surface is `[system][C1]…[Ck] + content`;
 * starting at 0 would both rewrite the prompt (host-rejected) and
 * re-summarize the checkpoint chain (the design forbids that).
 */
export function firstCompactableIndex(session) {
	const nodes = session.surface.nodes;
	let startIdx = protectedSystemHeadSeq(session) === undefined ? 0 : 1;
	while (startIdx < nodes.length && isCheckpointNode(session, nodes[startIdx])) startIdx += 1;
	while (startIdx < nodes.length && !toolPairingBalancedBefore(session, nodes[startIdx])) startIdx += 1;
	return startIdx;
}

/**
 * Shift a stored landing start that still names the protected system head
 * (current or rewritten-away) onto the first compactable node. A correctly
 * generated span already starts at or after that node and is returned
 * unchanged; a missing start that is not in the system-head chain is also
 * returned unchanged so `validateRange` can fail it as a genuine surface
 * change.
 */
export function adjustLandingStart(session, startSeq) {
	const nodes = session.surface.nodes;
	const compactFrom = firstCompactableIndex(session);
	if (compactFrom >= nodes.length) return startSeq;
	const startIdx = nodes.indexOf(startSeq);
	if (startIdx === -1) {
		return protectedSystemHeadChain(session).has(startSeq) ? nodes[compactFrom] : startSeq;
	}
	return startIdx < compactFrom ? nodes[compactFrom] : startSeq;
}

/** Count one model-visible paragraph when no durable DB number is available. */
function fallbackParagraph(session, seq) {
	const event = sessionEventAt(session, seq);
	if (event?.type === "user/message") return event.data?.content?.length > 0 ? 1 : undefined;
	if (event?.type === "assistant/message") {
		const content = event.data?.message?.content;
		if (!Array.isArray(content) || content.length === 0) return undefined;
		if (content.some((block) => block.type === "tool-call" && SKIPPED_TOOL_NAMES.has(block.name))) return undefined;
		return 1;
	}
	if (event?.type === "tool/result") {
		if (isSkippedToolResult(session, event)) return undefined;
		return event.data?.message?.content?.length > 0 ? 1 : undefined;
	}
	return undefined;
}

/** Resolve the durable paragraph number for one current surface node. */
function paragraphFor(session, seq, lookup) {
	const durable = typeof lookup === "function" ? lookup(session.id, seq) : undefined;
	return durable === undefined ? fallbackParagraph(session, seq) : durable;
}

/** Count paragraph-numbered nodes in the current surface. */
function visibleParagraphCount(session, lookup) {
	let count = 0;
	for (const seq of session.surface.nodes) {
		if (paragraphFor(session, seq, lookup) !== undefined) count += 1;
	}
	return count;
}

/**
 * Manual/overflow selection: retain the configured paragraph tail when
 * possible, but leave one recent paragraph available when history is short.
 */
export function selectManualCompartmentRange(session, { retainRounds, paragraphFor: lookup } = {}) {
	const paragraphs = visibleParagraphCount(session, lookup);
	if (paragraphs === 0) return null;
	const effectiveRetainRounds = Math.min(retainRounds, Math.max(1, paragraphs - 1));
	return selectCompartmentRange(session, { retainRounds: effectiveRetainRounds, paragraphFor: lookup });
}

/**
 * Select the fixed compactable range: surface head through the boundary before
 * the most recent retainRounds numbered paragraphs, snapped to tool-balanced
 * cuts. The range may end inside a user/assistant turn because paragraph count,
 * rather than turn count, is the retention contract.
 *
 * @param session - session whose surface and log are read (never mutated).
 * @param opts - { retainRounds, paragraphFor? }.
 * @returns { start, end, startIdx, endIdx, shadowedSeqs } or null when the
 * whole re-summarizable surface must be kept.
 */
export function selectCompartmentRange(session, { retainRounds, paragraphFor: lookup } = {}) {
	const nodes = session.surface.nodes;
	if (nodes.length === 0) return null;
	let keepIdx = nodes.length;
	let counted = 0;
	while (keepIdx > 0 && counted < retainRounds) {
		keepIdx -= 1;
		if (paragraphFor(session, nodes[keepIdx], lookup) !== undefined) counted += 1;
	}
	if (keepIdx === 0 && counted < retainRounds) return null;

	let endIdx = keepIdx - 1;
	while (endIdx >= 0 && !toolPairingBalancedAfter(session, nodes[endIdx])) endIdx -= 1;
	if (endIdx < 0) return null;

	// The generation range starts AFTER the protected system head (0.1.5
	// surface node 0) and every contiguous head checkpoint. After several
	// landings the surface is [system][C1][C2]…[Ck] + new content; only
	// content after the last checkpoint may be summarized again (chain
	// design — never re-summarize, and never rewrite the system prompt).
	const startIdx = firstCompactableIndex(session);
	if (startIdx >= nodes.length || endIdx < startIdx) return null;
	return {
		start: nodes[startIdx],
		end: nodes[endIdx],
		startIdx,
		endIdx,
		shadowedSeqs: nodes.slice(startIdx, endIdx + 1),
	};
}

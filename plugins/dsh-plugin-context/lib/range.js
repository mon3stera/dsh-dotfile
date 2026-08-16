// Compartment range selection: the span fixed at GENERATION time.
//
// retainRounds is the historical config key, but its value means the number
// of recent paragraph-numbered model-visible messages retained verbatim. The
// engine supplies the durable paragraph lookup from ContextDb; the local
// fallback keeps detached range tests and older sessions usable when a number
// has not been assigned yet. The landing later replaces exactly this span.
import { isCompactCheckpointSource, toolPairingBalancedAfter, toolPairingBalancedBefore } from "@deepseek-ai/dsh-compaction";

const SKIPPED_TOOL_NAMES = new Set(["ctx_reduce", "ctx_expand"]);

/** Detect an excluded tool result when durable paragraph metadata is absent. */
function isSkippedToolResult(session, event) {
	const callId = event.data?.message?.source?.callId ?? event.data?.callId;
	if (callId === undefined) return false;
	for (let index = event.seq - 1; index >= 0; index -= 1) {
		const earlier = session.events[index];
		if (earlier?.type === "tool/call" && earlier.data?.callId === callId) return SKIPPED_TOOL_NAMES.has(earlier.data.name);
	}
	return false;
}

/** True when one surface event is a compaction checkpoint node (any engine). */
function isCheckpointNode(session, seq) {
	const event = session.events[seq];
	return event?.type === "user/message" && event.data?.source !== undefined && isCompactCheckpointSource(event.data.source);
}

/** Count one model-visible paragraph when no durable DB number is available. */
function fallbackParagraph(session, seq) {
	const event = session.events[seq];
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

	// The generation range starts AFTER every contiguous head checkpoint:
	// after several landings the surface is [C1][C2]…[Ck] + new content, and
	// the head node is still the oldest checkpoint. Only content after the last
	// checkpoint may be summarized again (chain design — never re-summarize).
	let startIdx = 0;
	while (startIdx < nodes.length && isCheckpointNode(session, nodes[startIdx])) startIdx += 1;
	if (startIdx >= nodes.length) return null;
	while (startIdx < nodes.length && !toolPairingBalancedBefore(session, nodes[startIdx])) startIdx += 1;
	if (endIdx < startIdx) return null;
	return {
		start: nodes[startIdx],
		end: nodes[endIdx],
		startIdx,
		endIdx,
		shadowedSeqs: nodes.slice(startIdx, endIdx + 1),
	};
}

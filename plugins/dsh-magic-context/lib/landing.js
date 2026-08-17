// Landing transaction for dsh-magic-context: replace a pre-stored
// compartment's FIXED surface span with one checkpoint user message.
//
// Follows the seam's durable contract (compaction/start → compaction/summary →
// user/message replace → compaction/end) with SELECTED-SPAN stability: only
// the compartment's own span must remain present, contiguous, and equally
// priced — new content appended after generation does not invalidate the
// landing. This is what lets the summary run asynchronously at 65% and land at
// 80% without a whole-surface freeze.
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	CompactionId,
	ManualCompactionError,
	compactCheckpointSource,
	toolPairingBalancedAfter,
	toolPairingBalancedBefore,
} from "@deepseek-ai/dsh-compaction";
import { createUserMessage, errorChain } from "@deepseek-ai/dsh-llm";

/** Framing that makes the replacement user message established context. */
export const CHECKPOINT_PREAMBLE = "This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.";

/** Wrap one stored compartment summary in the durable checkpoint framing. */
export function frameCompartmentSummary(summaryText) {
	return `${CHECKPOINT_PREAMBLE}\n\n<compacted-summary>\n${summaryText}\n</compacted-summary>`;
}

/** Estimate the framed checkpoint size used by the landing shrink guard. */
export function estimateFramedSummaryTokens(meter, summaryText) {
	const checkpointMessage = createUserMessage({
		content: [{ type: "text", text: frameCompartmentSummary(summaryText) }],
	});
	return meter.estimateMessage(checkpointMessage);
}

/** Rejects a landing whose replacement boundaries are no longer the stored ones. */
export class SurfaceChangedError extends Error {
	name = "SurfaceChangedError";
}

/** Validate one fixed surface-position span as a replacement target. */
function validateRange(session, start, end) {
	const nodes = session.surface.nodes;
	const startIdx = nodes.indexOf(start);
	const endIdx = nodes.indexOf(end);
	if (startIdx === -1) throw new Error(`landing: start seq ${start} not found in surface`);
	if (endIdx === -1) throw new Error(`landing: end seq ${end} not found in surface`);
	if (startIdx > endIdx) throw new Error(`landing: start seq ${start} is after end seq ${end} on the surface`);
	if (!toolPairingBalancedBefore(session, nodes[startIdx])) throw new Error(`landing: start seq ${start} is not a balanced boundary`);
	if (!toolPairingBalancedAfter(session, nodes[endIdx])) throw new Error(`landing: end seq ${end} is not a balanced boundary`);
	return { start, end, startIdx, endIdx, shadowedSeqs: nodes.slice(startIdx, endIdx + 1) };
}

/** Inspect open-turn, unmatched-compaction, and latest seed-boundary state. */
function inspectEntryState(events) {
	let openTurn = null;
	let openTurnStateKnown = false;
	let unmatchedCompactionStart;
	let compactionEntryStateKnown = false;
	let latestEndSeedSeq;
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (latestEndSeedSeq === undefined && event.type === "session/end-seed") latestEndSeedSeq = event.seq;
		if (!compactionEntryStateKnown) {
			if (event.type === "compaction/start") {
				unmatchedCompactionStart = event;
				compactionEntryStateKnown = true;
			} else if (event.type === "compaction/end") compactionEntryStateKnown = true;
		}
		if (!openTurnStateKnown) {
			if (event.type === "turn/start") {
				openTurn = event.data.turn;
				openTurnStateKnown = true;
			} else if (event.type === "turn/end") openTurnStateKnown = true;
		}
		if (openTurnStateKnown && compactionEntryStateKnown && latestEndSeedSeq !== undefined) break;
	}
	return { openTurn, unmatchedCompactionStart, latestEndSeedSeq };
}

function assertInactive(unmatchedCompactionStart, latestEndSeedSeq) {
	if (unmatchedCompactionStart === undefined || (latestEndSeedSeq !== undefined && latestEndSeedSeq > unmatchedCompactionStart.seq)) return;
	throw new ManualCompactionError("busy", "landing: compaction already in progress; the session compaction lock is already active");
}

/** The stored span must still be the same present, contiguous, equally priced range. */
function assertSpanStable(session, selection, meter) {
	let current;
	try {
		current = validateRange(session, selection.start, selection.end);
	} catch (error) {
		throw new SurfaceChangedError("landing: the stored span is no longer a valid replacement target", { cause: error });
	}
	if (!isDeepStrictEqual(current.shadowedSeqs, selection.shadowedSeqs)) throw new SurfaceChangedError("landing: the stored span changed since generation");
	const priced = meter.measure(session).nodes.slice(current.startIdx, current.endIdx + 1).map((node) => node.seq);
	if (!isDeepStrictEqual(priced, selection.shadowedSeqs)) throw new SurfaceChangedError("landing: the stored span was rewritten since generation");
}

/** Classify one closed manual landing attempt. */
function throwManualFailure(failure) {
	if (failure.error instanceof SurfaceChangedError) throw new ManualCompactionError("changed", "the compacted history changed during landing", { cause: failure.error });
	throw new ManualCompactionError("summary", "landing could not produce a smaller summary", { cause: failure.error });
}

/**
 * Land one pre-stored compartment: replace its fixed span with the checkpoint
 * message built from its stored summary. No LLM call happens here — this is
 * the fast, non-blocking half of the async design.
 * @param deps - { session, cdb, meter, agent }.
 * @param compartment - stored ready compartment (start_seq/end_seq/summary/…).
 * @param opts - { owner: "current-turn" | null, sourceCommandId?, signal?, flush? }.
 * @returns the committed landing result.
 */
export async function landCompartment(deps, compartment, opts) {
	const { session, cdb, meter } = deps;
	const { owner, sourceCommandId, signal, flush } = opts;
	signal?.throwIfAborted();
	let selection;
	try {
		selection = validateRange(session, compartment.start_seq, compartment.end_seq);
	} catch (error) {
		throw new SurfaceChangedError("landing: the stored span is no longer a valid replacement target", { cause: error });
	}
	const entryState = inspectEntryState(session.events);
	assertInactive(entryState.unmatchedCompactionStart, entryState.latestEndSeedSeq);
	let ownerTurn;
	if (owner === null) {
		if (entryState.openTurn !== null) throw new ManualCompactionError("busy", "manual landing: the session already has an open turn");
		ownerTurn = null;
	} else {
		if (entryState.openTurn === null) throw new Error("landCompartment: no open turn — automatic landing must run inside a turn");
		ownerTurn = entryState.openTurn;
	}
	const compactionId = CompactionId(randomUUID());
	const lifecycle = {
		compactionId,
		...(sourceCommandId === undefined ? {} : { sourceCommandId }),
		turn: ownerTurn,
	};
	const startEvent = session.append("compaction/start", lifecycle);
	let failure;
	let flushFailure;
	let result;
	let closed = false;
	let closing = false;
	try {
		const checkpointMessage = createUserMessage({
			content: [{ type: "text", text: frameCompartmentSummary(compartment.summary) }],
			source: compactCheckpointSource(compactionId, sourceCommandId),
		});
		const framed = estimateFramedSummaryTokens(meter, compartment.summary);
		if (framed >= compartment.shadowed_tokens) {
			throw new Error(`stored summary is not smaller than the shadowed content (${framed} estimated framed tokens >= ${compartment.shadowed_tokens})`);
		}
		assertSpanStable(session, selection, meter);
		const summaryEvent = session.append("compaction/summary", {
			compactionId,
			...(sourceCommandId === undefined ? {} : { sourceCommandId }),
			summary: checkpointMessage.content,
			shadowedRange: { start: compartment.start_seq, end: compartment.end_seq },
			shadowedSeqs: [...selection.shadowedSeqs],
			shadowedTokenCount: compartment.shadowed_tokens,
			provider: compartment.provider ?? "",
			model: compartment.model ?? "",
		});
		const replaceEvent = session.append("user/message", checkpointMessage, {
			surfaceOp: { op: "replace", start: compartment.start_seq, end: compartment.end_seq },
			sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...selection.shadowedSeqs],
		});
		closing = true;
		const endEvent = session.append("compaction/end", lifecycle);
		closed = true;
		cdb.markCompartmentLanded(compartment.id, replaceEvent.seq);
		result = {
			compactionId,
			...(sourceCommandId === undefined ? {} : { sourceCommandId }),
			startSeq: startEvent.seq,
			summarySeq: summaryEvent.seq,
			endSeq: endEvent.seq,
			summary: checkpointMessage.content,
			shadowedRange: { start: compartment.start_seq, end: compartment.end_seq },
			shadowedSeqs: [...selection.shadowedSeqs],
			shadowedTokenCount: compartment.shadowed_tokens,
		};
	} catch (error) {
		failure = { error, stage: closing ? "commit" : "summary" };
		if (!closing) {
			closing = true;
			try {
				session.append("compaction/end", { ...lifecycle, error: errorChain(error) });
				closed = true;
			} catch (closeError) {
				failure = { error: closeError, stage: "commit" };
			}
		}
	}
	if (closed && flush !== undefined) {
		try {
			await flush();
		} catch (error) {
			flushFailure = error;
		}
	}
	if (owner === null) signal?.throwIfAborted();
	if (failure !== undefined) {
		if (owner === null) throwManualFailure(failure);
		throw failure.error;
	}
	if (flushFailure !== undefined) throw new ManualCompactionError("persistence", "manual landing durability checkpoint failed", { cause: flushFailure });
	if (result === undefined) throw new Error("landing committed without a result");
	return result;
}

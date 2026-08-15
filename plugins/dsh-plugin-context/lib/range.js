// Compartment range selection: the span fixed at GENERATION time.
//
// The range starts at the current surface head (the last checkpoint, or the
// original first message) and ends at the boundary BEFORE the most recent
// `retainRounds` turns — the "recent N rounds kept verbatim" rule from the
// design. Everything inside is summarized by the background summarizer; the
// landing later replaces exactly this span and nothing beyond it.
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from "@deepseek-ai/dsh-compaction";

/** Resolve the turn owning one surface event (user messages look ahead to their step). */
function turnOf(event, events) {
	if (event.data !== undefined && typeof event.data.turn === "number") return event.data.turn;
	if (event.type === "user/message") {
		for (let i = event.seq - 1; i >= 0; i -= 1) {
			const earlier = events[i];
			if (earlier.type === "step/start" || earlier.type === "turn/start") return earlier.data.turn;
			if (earlier.type === "turn/end") return undefined;
		}
	}
	return undefined;
}

/**
 * Select the fixed compactable range: surface head through the last turn
 * before the most recent `retainRounds` turns, snapped to balanced cuts.
 * @param session - session whose surface and log are read (never mutated).
 * @param opts - { retainRounds }.
 * @returns { start, end, startIdx, endIdx, shadowedSeqs } or null when the
 * whole surface must be kept (fewer visible turns than retainRounds).
 */
export function selectCompartmentRange(session, { retainRounds }) {
	const nodes = session.surface.nodes;
	if (nodes.length === 0) return null;
	const events = session.events;
	let keepIdx = nodes.length;
	if (retainRounds > 0) {
		let counted = 0;
		let lastTurn;
		while (keepIdx > 0) {
			const turn = turnOf(events[nodes[keepIdx - 1]], events);
			if (turn !== undefined && turn !== lastTurn) {
				counted += 1;
				lastTurn = turn;
			}
			keepIdx -= 1;
			if (counted >= retainRounds) break;
		}
		// keepIdx now points at the first surface node of the Nth turn (from the
		// tail); walk further back while that same turn continues so whole turns
		// stay verbatim.
		while (keepIdx > 0) {
			const turn = turnOf(events[nodes[keepIdx - 1]], events);
			if (turn !== undefined && turn === lastTurn) keepIdx -= 1;
			else break;
		}
	}
	if (keepIdx === 0) return null; // fewer visible turns than retainRounds
	let endIdx = keepIdx - 1;
	if (!toolPairingBalancedAfter(session, nodes[endIdx])) endIdx -= 1;
	if (endIdx < 0) return null;
	let startIdx = 0;
	if (!toolPairingBalancedBefore(session, nodes[startIdx])) startIdx += 1;
	if (endIdx < startIdx) return null;
	return {
		start: nodes[startIdx],
		end: nodes[endIdx],
		startIdx,
		endIdx,
		shadowedSeqs: nodes.slice(startIdx, endIdx + 1),
	};
}

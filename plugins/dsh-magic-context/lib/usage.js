// Per-session context usage facts shared by the agent-plane engine and the
// process-wide Web usage route. Values describe only material present in the
// current model-visible surface plus the persistent memory-injection prefix.
//
// Two accounting systems meet here and are reported side by side:
//   - `tokens` is the exact figure when the tokenizer priced the material, else
//     the host meter's four-characters-per-token heuristic (kept in
//     `heuristicTokens` for comparison),
//   - `measured` is the host meter's own request-pressure total, which anchors
//     on the provider's exact usage whenever the request envelope is unchanged.
const usageBySession = new Map();

const EMPTY_USAGE = Object.freeze({
	compartments: Object.freeze({ count: 0, tokens: 0, heuristicTokens: 0, exact: false }),
	memories: Object.freeze({ count: 0, tokens: 0, heuristicTokens: 0, exact: false }),
	measured: Object.freeze({ tokens: 0, kind: "none", deltaTokens: 0, window: 0 }),
	totalTokens: 0,
});

function nonNegativeInteger(value) {
	return Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function signedInteger(value) {
	return Number.isFinite(value) ? Math.round(value) : 0;
}

export function setContextUsage(sessionId, { compartments = {}, memories = {}, measured } = {}) {
	if (typeof sessionId !== "string" || sessionId.length === 0) return;
	const current = {
		compartments: {
			count: nonNegativeInteger(compartments.count),
			tokens: nonNegativeInteger(compartments.tokens),
			heuristicTokens: nonNegativeInteger(compartments.heuristicTokens),
			exact: compartments.exact === true,
		},
		// The memory block stays in every request until the next re-selection, so
		// its tokens always occupy the current window.
		memories: {
			count: nonNegativeInteger(memories.count),
			tokens: nonNegativeInteger(memories.tokens),
			heuristicTokens: nonNegativeInteger(memories.heuristicTokens),
			exact: memories.exact === true,
		},
	};
	current.totalTokens = current.compartments.tokens + current.memories.tokens;
	if (measured !== undefined && measured !== null) {
		current.measured = {
			tokens: nonNegativeInteger(measured.tokens),
			kind: typeof measured.kind === "string" ? measured.kind : "estimated",
			deltaTokens: signedInteger(measured.deltaTokens),
			window: nonNegativeInteger(measured.window),
		};
	}
	usageBySession.set(sessionId, current);
}

export function getContextUsage(sessionId) {
	return usageBySession.get(sessionId) ?? EMPTY_USAGE;
}

export function clearContextUsage(sessionId) {
	if (typeof sessionId === "string") usageBySession.delete(sessionId);
}

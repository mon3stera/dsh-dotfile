// Per-session context usage facts shared by the agent-plane engine and the
// process-wide Web usage route. Values describe only material present in the
// current model-visible surface plus the persistent memory-injection prefix.
const usageBySession = new Map();

const EMPTY_USAGE = Object.freeze({
	compartments: Object.freeze({ count: 0, tokens: 0 }),
	memories: Object.freeze({ count: 0, tokens: 0 }),
	totalTokens: 0,
});

function nonNegativeInteger(value) {
	return Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

export function setContextUsage(sessionId, { compartments = {}, memories = {} } = {}) {
	if (typeof sessionId !== "string" || sessionId.length === 0) return;
	const current = {
		compartments: {
			count: nonNegativeInteger(compartments.count),
			tokens: nonNegativeInteger(compartments.tokens),
		},
		// The memory block stays in every request until the next re-selection, so
		// its tokens always occupy the current window.
		memories: {
			count: nonNegativeInteger(memories.count),
			tokens: nonNegativeInteger(memories.tokens),
		},
	};
	current.totalTokens = current.compartments.tokens + current.memories.tokens;
	usageBySession.set(sessionId, current);
}

export function getContextUsage(sessionId) {
	return usageBySession.get(sessionId) ?? EMPTY_USAGE;
}

export function clearContextUsage(sessionId) {
	if (typeof sessionId === "string") usageBySession.delete(sessionId);
}

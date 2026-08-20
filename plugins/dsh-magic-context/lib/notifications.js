// Human-facing context activity rows reuse the harness command lifecycle
// (`command/run` + `command/done`), which is the only channel in this build that
// a plugin may append, that the Web client renders as a conversation row, and
// that the model never sees.
//
// Why not a user/message notice, which is what this file used to build: exactly
// three event types are surface-eligible (`user/message`, `assistant/message`,
// `tool/result`) and `deriveEventMessage` projects each of them unconditionally,
// so anything holding a place in the transcript is necessarily model-visible.
// Worse, `agent.inject()` resolves to `send(message, "next-step", false)`, and
// the agent loop only ends a turn when `inbox.nextStep` is empty
// (dsh-agent-loop: `if (turnEnds && this.inbox.nextStep.length === 0) break`).
// A status notice arriving at a turn boundary therefore forced one extra step,
// i.e. one extra LLM request over the whole context, to react to text written
// for a human.
//
// Why not a plugin-owned event type, which would be the honest vocabulary:
// `Session.append()` accepts only `sourceEventSeqs` and `surfaceOp`, so a plugin
// cannot set the envelope's `ignorable` marker, and `dsh-session-persistence`
// refuses to interpret any log containing an unknown event type without it. One
// such notice would make the whole session unloadable. Upstream states the
// registration surface for out-of-repo events is deferred.
//
// `command/run` / `command/done` are direct log-only appends: no turn wraps
// them, nothing enters the agent inbox, and neither type is surface-eligible.
// The client pairs them by `commandId` into one collapsible card whose title is
// `name`, which stays in a running state until the `done` event arrives and
// turns red for `kind: "error"`.
import { randomUUID } from "node:crypto";
import { boundContextSummary, createUserMessage } from "@deepseek-ai/dsh-llm";

const PLUGIN = "dsh-magic-context";

/** Row bodies are read by humans; a runaway provider string must not fill the log. */
const MAX_ACTIVITY_TEXT_CHARS = 4000;

let activityCounter = 0;

/**
 * Mint one activity pairing id.
 *
 * The command executor mints its own instance-prefixed ids, so this namespace
 * prefix keeps a plugin row from ever colliding with a real command's lifecycle.
 * @returns a fresh activity id.
 */
export function mintActivityId() {
	activityCounter += 1;
	return `${PLUGIN}/${randomUUID().slice(0, 8)}-${activityCounter}`;
}

/** Trim and bound one row body, or drop it when empty. */
function boundActivityText(text) {
	if (typeof text !== "string") return undefined;
	const trimmed = text.trim();
	if (trimmed.length === 0) return undefined;
	if (trimmed.length <= MAX_ACTIVITY_TEXT_CHARS) return trimmed;
	return `${trimmed.slice(0, MAX_ACTIVITY_TEXT_CHARS - 3)}...`;
}

/** Append one lifecycle event, treating a missing session as "no UI available". */
function appendActivityEvent(session, type, data) {
	if (session === undefined || session === null || typeof session.append !== "function") return false;
	session.append(type, data);
	return true;
}

/**
 * Open one activity row, which renders as running until it is settled.
 * @param session - session owning the row.
 * @param title - row title, shown in both the running and settled states.
 * @param activityId - explicit pairing id; minted when omitted.
 * @returns the pairing id, or undefined when no session could take the row.
 */
export function startActivity(session, title, activityId = mintActivityId()) {
	if (typeof title !== "string" || title.trim().length === 0) throw new Error("activity title must be non-empty");
	const appended = appendActivityEvent(session, "command/run", {
		commandId: activityId,
		name: title.trim(),
		source: { kind: "plugin", plugin: PLUGIN },
	});
	return appended ? activityId : undefined;
}

/**
 * Settle one open activity row with its outcome.
 * @param session - session owning the row.
 * @param activityId - pairing id returned by {@link startActivity}.
 * @param kind - "success" or "error"; "error" renders the row as failed.
 * @param text - outcome body; multi-line text becomes the expandable body.
 * @returns true when the lifecycle event was appended.
 */
export function settleActivity(session, activityId, kind, text) {
	if (activityId === undefined) return false;
	if (kind !== "success" && kind !== "error") {
		throw new Error(`activity outcome must be "success" or "error", received "${String(kind)}"`);
	}
	const bounded = boundActivityText(text);
	return appendActivityEvent(session, "command/done", {
		commandId: activityId,
		kind,
		...(bounded === undefined ? {} : { text: bounded }),
	});
}

/**
 * Record one already-finished activity as a single settled row.
 * @param session - session owning the row.
 * @param title - row title.
 * @param text - outcome body.
 * @param kind - "success" (default) or "error".
 * @returns true when both lifecycle events were appended.
 */
export function recordActivity(session, title, text, kind = "success") {
	const activityId = startActivity(session, title);
	if (activityId === undefined) return false;
	return settleActivity(session, activityId, kind, text);
}

/**
 * Build one durable, model-facing context message.
 *
 * This remains the right shape for content the model is meant to read, such as
 * the memory selection `/inject-memory` deliberately puts in front of it. Status
 * reporting must use the activity rows above instead.
 * @param summary - collapsed row summary.
 * @param text - message body.
 * @returns the injectable user message.
 */
export function createContextNotice(summary, text) {
	if (typeof summary !== "string" || summary.trim().length === 0) throw new Error("context notice summary must be non-empty");
	if (typeof text !== "string" || text.trim().length === 0) throw new Error("context notice text must be non-empty");
	return createUserMessage({
		content: [{ type: "text", text }],
		source: {
			kind: "plugin",
			plugin: PLUGIN,
			form: "notice",
			summary: boundContextSummary(summary.trim()),
		},
	});
}

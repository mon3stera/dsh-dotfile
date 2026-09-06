// Dreamer session driver: one real child session per Dreamer pass.
//
// Passes are independent computations — a later pass inherits nothing from an
// earlier one; the only cross-pass state is the context database. The child
// session is therefore the pass's physical carrier AND its full audit trail:
// it mounts the `dream` agent preset (read-only maintenance tools, no
// compaction group, no shell), receives the material brief as its first user
// message, and its native log shows every read and every write action.
//
// Attachment mechanics (verified end to end on an isolated instance):
// - header meta { parentSession, origin: 'subagent' } puts the child in the
//   parent's subagent catalog and out of the top-level sidebar list;
// - one appended `subagent/descriptor` event (version 3, one-shot) is what
//   the catalog's identity projection folds into a visible row;
// - generic session routing refuses origin-subagent sessions, so the driver
//   owns the child outright: create -> followup -> whenIdle -> dispose.
import { randomUUID } from "node:crypto";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

import { buildDreamerBrief } from "./dreamer.js";

/** @module dsh-magic-context/dreamer-session */

export const DREAM_PRESET_ID = "dream";
export const DREAM_SESSION_PREFIX = "session-dream-";

/** Error raised when the `dream` agent preset is not installed. */
export class DreamPresetMissingError extends Error {
	constructor(presetId) {
		super(`dream agent preset "${presetId}" is not installed; run the dsh-magic-context preset installer`);
		this.name = "DreamPresetMissingError";
		this.code = "DREAM_PRESET_MISSING";
	}
}

/** Extract one assistant event's text. */
function assistantText(event) {
	const blocks = event?.data?.message?.content;
	if (!Array.isArray(blocks)) return "";
	return blocks.filter((block) => block?.type === "text").map((block) => block.text).join("\n").trim();
}

/** Pair tool/call with tool/result events into the shared action summary shape. */
function collectActions(events) {
	const pending = new Map();
	const actions = [];
	for (const event of events) {
		if (event.type === "tool/call") {
			pending.set(event.data.callId, event.data.name);
			continue;
		}
		if (event.type === "tool/result") {
			/* The result envelope carries the callId at message.source.callId in
			 * real logs; message.callId covers the scripted shape. */
			const resultCallId = event.data.message?.source?.callId ?? event.data.message?.callId ?? event.data.callId;
			const name = pending.get(resultCallId) ?? "unknown";
			pending.delete(resultCallId);
			actions.push({ name, ok: event.data.error === undefined });
		}
	}
	return actions;
}

/**
 * Run one Dreamer maintenance pass as a child session of `parentAgent`.
 *
 * @param deps - { agents, agentPresets, sessionController, llm, cdb } host
 *   services captured by the engine.
 * @param opts - { parentAgent, provider, model, reasoningEffort?, timeoutMs,
 *   verifyIntervalDays, scopePath, workspaceRoot }.
 * @returns { skipped, rounds, actions, settled, summary, childSessionId,
 *   cancelled, facts, memories, compartments }.
 */
export async function runDreamerSession(deps, opts) {
	const { agents, agentPresets, sessionController, llm, cdb } = deps;
	const { parentAgent, provider, model, reasoningEffort, timeoutMs = 600000, verifyIntervalDays = 30, scopePath, workspaceRoot } = opts;
	const parentSessionId = parentAgent.session.id;
	const material = buildDreamerBrief(cdb, verifyIntervalDays, scopePath);
	const actions = [];
	if (material.facts.length === 0 && material.memories.length === 0 && material.compartments.length === 0) {
		return { skipped: true, rounds: 0, actions, childSessionId: undefined, ...material };
	}

	let resolved;
	try {
		resolved = await agentPresets.resolve(DREAM_PRESET_ID);
	} catch (error) {
		throw new DreamPresetMissingError(DREAM_PRESET_ID);
	}

	const childId = `${DREAM_SESSION_PREFIX}${randomUUID().slice(0, 8)}`;
	const handle = await agents.create({
		sessionId: childId,
		meta: {
			cwd: workspaceRoot,
			parentSession: parentSessionId,
			origin: "subagent",
			agentPreset: resolved.id,
		},
		setup: async (agentCtx) => {
			await agentPresets.mount(agentCtx, resolved.id);
		},
	});
	const child = handle.agent;

	let cancelled = false;
	const timer = setTimeout(() => {
		cancelled = true;
		try {
			child.cancel({ kind: "parent" });
		} catch {
			// an already-settled child needs no cancel
		}
	}, timeoutMs);

	try {
		// Commit the Dreamer's model route on the child only. This mirrors the
		// scheduler's per-task selection: a session-local selection event, never
		// the deployment-global default model. A failed validation keeps the
		// deployment default route rather than aborting the pass.
		if (typeof provider === "string" && provider.length > 0 && typeof model === "string" && model.length > 0) {
			try {
				const resolvedRoute = await llm.resolveCallConfig({ provider, model });
				sessionController.agents.selectForNextRequest(child, resolvedRoute);
			} catch {
				// fall through to the deployment default route
			}
		}

		// The catalog's identity projection folds exactly one descriptor event
		// into a visible row; without it the child is invisible in the catalog.
		child.session.append("subagent/descriptor", {
			version: 3,
			mode: "one-shot",
			provider: "dream",
			label: "Dreamer pass",
		});

		child.followup(createUserMessage({
			content: [{ type: "text", text: material.brief }],
			source: { kind: "user" },
		}));
		await child.whenIdle();

		const events = child.session.snapshotEvents();
		const assistantSteps = events.filter((event) => event.type === "assistant/message");
		for (const action of collectActions(events)) actions.push(action);
		const endData = events.filter((event) => event.type === "turn/end").at(-1)?.data;
		/* The turn end carries the outcome in two observed shapes: a reason
		 * string on success, and either `{kind: "error", error}` or
		 * `{reason: {kind: "error", error}}` on failure. An unsettled pass must
		 * not stamp verified_at. */
		const rawReason = endData?.reason;
		const stopReason = typeof rawReason === "string"
			? rawReason
			: typeof rawReason?.kind === "string"
				? rawReason.kind
				: typeof endData?.kind === "string" ? endData.kind : undefined;
		const stopError = rawReason?.error?.message ?? endData?.error?.message;
		const settled = !cancelled && assistantSteps.length > 0 && stopReason !== "error";
		if (settled && typeof cdb.markMemoriesVerified === "function") {
			cdb.markMemoriesVerified(material.memories.map((memory) => memory.id), Date.now(), scopePath);
		}
		const summary = assistantText(assistantSteps.at(-1));
		return {
			skipped: false,
			rounds: assistantSteps.length,
			actions,
			settled,
			cancelled,
			stopReason,
			...(stopError === undefined ? {} : { error: stopError }),
			summary,
			childSessionId: childId,
			...material,
		};
	} finally {
		clearTimeout(timer);
		await handle.dispose();
	}
}

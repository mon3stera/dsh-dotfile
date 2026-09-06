// dsh-plugin-tool-gate: progressive tool loading for DSH sessions.
//
// Heavy tools are hidden from the model-facing tool list per agent through
// `agent.ctx.tools.restrict({ deny })`; a compact catalog section (injected
// system prompt) lists every gated tool with a one-line summary, and one
// `tool_expand` tool loads requested tools back for the rest of the session.
// Hidden tools stay registered and executable — a restriction only shapes the
// request's `tools` array (assembly reads `view(scope).visible` through
// wireSchemas); a model call to a gated tool is denied as `UNKNOWN_TOOL`,
// the same failure an absent definition produces, so the model recovers by
// expanding first.
//
// Gating hooks three lifecycle events, all idempotent through the
// agent-identity check in gate(): `agent/session-start` is the primary path
// (the agent-loop emits it with the agent object on fresh start and resume,
// before the first request assembly), `session/created` primes fresh
// sessions early, and `session/event` on turn/start / user/message is the
// fallback when neither hook found a live agent. Expansion runs inside the
// tool body through `exec.agent.ctx`, so it is per-agent by construction.
// Every seam fails open: if the agents service or the agent scope is
// unavailable, the session simply keeps all tools.

import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

import { DEFAULT_HIDDEN, catalogText, expandTransition, firstSentence, normalizeHidden, visibleDeny } from "./gate.js";
import { SUMMARIES } from "./summaries.js";

/** @module dsh-plugin-tool-gate */

/** Cordis plugin name used by loader diagnostics. */
const name = "dsh-plugin-tool-gate";

/** Services required at registration time. */
const inject = ["tools", "systemPrompt"];

const Config = z.object({
	// Master switch; the patch row can disable the gate without unloading it.
	enabled: z.boolean().default(true),
	// Names to hide. Defaults to DEFAULT_HIDDEN; unknown names are skipped
	// (logged), never fatal — restriction is pre-filtered against the agent's
	// restrictable set.
	hidden: z.array(z.string()).default(DEFAULT_HIDDEN),
	// Placement of the catalog section among the system prompt sections.
	sectionOrder: z.number().default(1615),
	// Name of the loader tool. Renaming it also renames the references in the
	// catalog text.
	expandToolName: z.string().default("tool_expand"),
});

/** Register the gate: lifecycle hooks, the catalog section, and tool_expand. */
function apply(ctx, config = {}) {
	const resolved = Config(config);
	const hidden = normalizeHidden(resolved.hidden);

	if (!resolved.enabled || hidden.length === 0) return;

	const warn = (...parts) => {
		const message = `[tool-gate] ${parts.join(" ")}`;

		if (typeof ctx.logger?.warn === "function") ctx.logger.warn(message); else console.warn(message);
	};

	// Session id -> { agent, denied:Set, catalogNames:Set, disposer }.
	const gates = new Map();

	// The catalog text is filled by the first successful gate and rendered by
	// every assembly afterwards; empty text renders nothing.
	const state = { catalogText: "" };

	ctx.systemPrompt.section({
		name: "tool-gate:catalog",
		order: resolved.sectionOrder,
		text: () => state.catalogText,
	});

	const disposeEntry = (entry) => {
		try {
			entry.disposer?.();
		} catch {
			/* the owning agent's layer may already be gone (resume race) */
		}
	};

	const liveAgent = (sessionId) => {
		try {
			return ctx.get("agents")?.get(sessionId);
		} catch {
			return undefined;
		}
	};

	// Apply (or refresh) the restriction for one session's agent. `agentHint`
	// comes from agent/session-start and skips the registry lookup. Re-gating
	// a session whose agent object changed (resume) disposes the stale
	// restriction first — a new agent's layer has none anyway, but the old
	// disposer must not leak.
	const gate = (sessionId, agentHint) => {
		const agent = agentHint ?? liveAgent(sessionId);

		if (agent === undefined) return false;

		const existing = gates.get(sessionId);

		if (existing !== undefined && existing.agent === agent) return true;

		if (existing !== undefined) disposeEntry(existing);

		const agentTools = agent.ctx.tools;
		const { deny: names, skipped } = visibleDeny(hidden, agentTools.view(agent).restrictableNames);

		if (skipped.length > 0) warn("not hideable on this agent, skipping:", skipped.join(", "));

		// Catalog first, from the pre-gate view, so summaries can fall back to
		// each tool's own description.
		const entries = names.map((toolName) => {
			const definition = agentTools.view(agent).visible.get(toolName);
			const summary = SUMMARIES[toolName] ?? firstSentence(definition?.description);

			return { name: toolName, summary: summary.length > 0 ? summary : "no summary available" };
		});

		state.catalogText = catalogText(entries, resolved.expandToolName);

		const disposer = names.length > 0 ? agentTools.restrict({ deny: names }) : undefined;

		gates.set(sessionId, { agent, denied: new Set(names), catalogNames: new Set(names), disposer });

		return true;
	};

	// Primary path: the agent object arrives directly, fresh or resumed.
	ctx.on("agent/session-start", ({ agent }) => {
		gate(agent.session?.id, agent);
	});

	// Fresh sessions: the agent may not be composed yet at creation, so this
	// often primes nothing and a later hook completes it.
	ctx.on("session/created", (session) => {
		gate(session.id);
	});

	// Fallback for sessions whose agent only becomes reachable later.
	ctx.on("session/event", (session, event) => {
		if (event?.type === "turn/start" || event?.type === "user/message") gate(session.id);
	});

	ctx.on("session/disposed", (session) => {
		const entry = gates.get(session.id);

		if (entry !== undefined) {
			disposeEntry(entry);

			gates.delete(session.id);
		}
	});

	ctx.tools.register(defineTool({
		name: resolved.expandToolName,
		description: [
			"Load gated tools into the session for the rest of the conversation.",
			"The progressive tool loading system section lists every gated tool with a one-line summary.",
			"Pass the tool names you need and batch related names into one call; they become callable from your next step.",
			"Calling a gated tool before expanding it fails as an unknown tool.",
		].join(" "),
		parameters: {
			tools: {
				type: "array",
				items: { type: "string" },
				description: "Gated tool names to load, e.g. [\"workflow\", \"subagent\"].",
			},
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					result: { type: "string", required: true },
				},
			},
			render: (args, value) => [{ type: "text", text: value.result }],
		},
		timeoutMs: 10_000,
		async execute(args, exec) {
			const agent = exec?.agent;

			if (agent === undefined) throw new Error("tool_expand requires an agent-scoped execution");

			const sessionId = agent.session?.id;

			let entry = sessionId !== undefined ? gates.get(sessionId) : undefined;

			if (entry === undefined || entry.agent !== agent) {
				gate(sessionId);

				entry = sessionId !== undefined ? gates.get(sessionId) : undefined;
			}

			if (entry === undefined) return { result: "Tool gate state is unavailable for this session; every tool should already be declared, no expansion needed." };

			const requested = normalizeHidden(Array.isArray(args?.tools) ? args.tools : []);

			if (requested.length === 0) return { result: "Pass the gated tool names to load, e.g. [\"workflow\", \"subagent\"]." };

			const transition = expandTransition(entry, requested);

			if (transition.freed.length === 0 && transition.alreadyLoaded.length === 0 && transition.unknown.length > 0) {
				return { result: `No gated tools matched: ${transition.unknown.join(", ")}. The gated catalog is in the progressive tool loading section.` };
			}

			const agentTools = agent.ctx.tools;

			// Only a call that actually frees names touches the restriction; an
			// already-loaded or unknown-only answer must not rewrite the
			// request's tool block (it would churn the prompt cache for nothing).
			if (transition.freed.length > 0) {
				disposeEntry(entry);

				entry.denied = transition.nextDenied;
				entry.disposer = transition.nextDenied.size > 0 ? agentTools.restrict({ deny: [...transition.nextDenied] }) : undefined;
			}

			const lines = [];

			if (transition.freed.length > 0) lines.push(`Now available from your next step: ${transition.freed.join(", ")}.`);

			if (transition.alreadyLoaded.length > 0) lines.push(`Already loaded: ${transition.alreadyLoaded.join(", ")}.`);

			if (transition.unknown.length > 0) lines.push(`Not gated tools (ignored): ${transition.unknown.join(", ")}.`);

			lines.push(`${entry.denied.size} tool(s) remain gated.`);

			return { result: lines.join(" ") };
		},
	}));
}

export { Config, apply, inject, name };

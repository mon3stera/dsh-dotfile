// Pure decision core for the tool gate: which configured names are actually
// hideable on a given agent view, how one expand call transitions the deny
// set, and what the catalog section says. No registry access — index.js owns
// the registry seam, this file owns the math, so the smoke test can pin the
// transitions without a live composition.

/** Tools hidden by default: desktop control, docs lookup, orchestration and
* delegation, goals, background jobs. Deliberately excludes the ctx_* tools
* (dsh-magic-context — the model uses them constantly) and the small resident
* set (read/write/edit/bash/glob/grep and friends). */
export const DEFAULT_HIDDEN = [
	// Desktop control (dsh-plugin-computer-use).
	"desktop_windows",
	"desktop_tree",
	"desktop_screenshot",
	"desktop_mouse",
	"desktop_key",

	// Third-party docs lookup (context7 MCP).
	"mcp__context7__resolve-library-id",
	"mcp__context7__query-docs",

	// Orchestration / delegation.
	"workflow",
	"ralph",
	"subagent",
	"subagent_fork",
	"list_agents",
	"send_message",
	"interrupt_agent",

	// Goals.
	"create_goal",
	"update_goal",
	"get_goal",

	// Background jobs.
	"job_list",
	"job_kill",
	"job_output",
];

/** Trim, drop non-strings and empties, dedupe, and preserve order of a
* configured name list. */
export function normalizeHidden(value) {
	const seen = new Set();

	const out = [];

	for (const raw of value ?? []) {
		if (typeof raw !== "string") continue;

		const name = raw.trim();

		if (name.length === 0 || seen.has(name)) continue;

		seen.add(name);

		out.push(name);
	}

	return out;
}

/** First sentence of a tool description, capped, as the fallback catalog
* summary for tools missing from the curated map. */
export function firstSentence(text) {
	const flat = String(text ?? "").replace(/\s+/g, " ").trim();

	if (flat.length === 0) return "";

	const match = flat.match(/^[^.!?]*[.!?]/);

	const sentence = match === null ? flat : match[0];

	return sentence.length > 160 ? `${sentence.slice(0, 157)}...` : sentence;
}

/** Intersect the configured hidden list with the names a scope may actually
* restrict. Registry restrictions are fail-closed about unknown names (they
* throw), so the gate pre-filters: config drift across DSH updates degrades
* to "fewer tools gated" instead of a broken session. */
export function visibleDeny(hidden, restrictableNames) {
	const deny = [];

	const skipped = [];

	for (const name of hidden) {
		if (restrictableNames.has(name)) deny.push(name); else skipped.push(name);
	}

	return { deny, skipped };
}

/** Classify one expand call against the agent's gate state. `freed` leaves
* the deny set this call, `alreadyLoaded` was freed by an earlier call, and
* `unknown` was never gated here (the model may name a tool from its own
* imagination or one this deployment does not gate). */
export function expandTransition(entry, requested) {
	const freed = [];

	const alreadyLoaded = [];

	const unknown = [];

	for (const name of requested) {
		if (entry.denied.has(name)) freed.push(name); else if (entry.catalogNames.has(name)) alreadyLoaded.push(name); else unknown.push(name);
	}

	const nextDenied = new Set(entry.denied);

	for (const name of freed) nextDenied.delete(name);

	return { freed, alreadyLoaded, unknown, nextDenied };
}

/** The catalog section text: one line per gated tool plus the expand
* contract. Renders empty until the first gate fills it. */
export function catalogText(entries, expandToolName) {
	const lines = [
		"## Progressive tool loading",
		"",
		"The tools below are NOT declared in this request. Each line is `name - what it does`:",
		"",
	];

	for (const entry of entries) lines.push(`- ${entry.name} - ${entry.summary}`);

	lines.push("");

	lines.push(`When a task needs one of these, call ${expandToolName} with the tool names (batch related names into one call; every expansion rewrites the prompt cache from the tool block onward, so batching saves cost). Expanded tools become callable from your next step and stay loaded for the rest of the session. Calling a gated tool before expanding it fails as an unknown tool; if that happens, expand first and retry.`);

	return lines.join("\n");
}

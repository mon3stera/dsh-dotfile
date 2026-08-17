import {
	formatSearchResults,
	recordInjectionHit,
	renderInjectionText,
	searchMemories,
	selectInjectionMemories,
} from "./memory.js";
import { createContextNotice } from "./notifications.js";

export const CTX_SEARCH_USAGE = "Usage: /ctx-search <query> [--limit N]";
export const DREAM_USAGE = "Usage: /dream";
export const INJECT_MEMORY_USAGE = "Usage: /inject-memory";

/** Parse the human command input while keeping the query text intact. */
export function parseCtxSearchInput(rawInput) {
	const raw = String(rawInput ?? "").trim();
	if (raw.length === 0) return { error: CTX_SEARCH_USAGE };
	let query = raw;
	let limit = 5;
	const limitMatch = /(?:^|\s)--limit(?:=|\s+)(\d+)\s*$/u.exec(raw);
	if (limitMatch !== null) {
		limit = Number(limitMatch[1]);
		query = raw.slice(0, limitMatch.index).trim();
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
			return { error: `The limit must be an integer from 1 to 10. ${CTX_SEARCH_USAGE}` };
		}
	}
	if (query.length === 0) return { error: CTX_SEARCH_USAGE };
	return { query, limit };
}

/** Execute the user command through the same search function as ctx_search. */
export async function executeCtxSearchCommand(invocation, { cdb, memoryConfig, retrieval, resolveScope }) {
	const parsed = parseCtxSearchInput(invocation.rawInput);
	if (parsed.error !== undefined) return { kind: "error", text: parsed.error };
	try {
		const scopePath = typeof resolveScope === "function" ? resolveScope(invocation.agent?.session) : undefined;
		const rows = await searchMemories(cdb, memoryConfig, retrieval, parsed.query, parsed.limit, scopePath);
		return { kind: "success", text: formatSearchResults(rows) };
	} catch (error) {
		return { kind: "error", text: `ctx-search failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/** Parse the argument-free user Dreamer command. */
export function parseDreamInput(rawInput) {
	return String(rawInput ?? "").trim().length === 0 ? {} : { error: DREAM_USAGE };
}

/** Run one Dreamer maintenance pass for the receiving agent. */
export async function executeDreamCommand(invocation, { runDreamer }) {
	const parsed = parseDreamInput(invocation.rawInput);
	if (parsed.error !== undefined) return { kind: "error", text: parsed.error };
	try {
		const result = await runDreamer(invocation.agent);
		if (result.skipped) {
			if (result.reason === "busy") return { kind: "error", text: "Dreamer is already running for this agent." };
			if (result.reason === "no route") return { kind: "error", text: "Dreamer skipped: no provider/model route is available for this session." };
			return { kind: "success", text: "Dreamer skipped: there are no pending facts, memories, or compartments to integrate." };
		}
		return {
			kind: "success",
			text: [
				`Dreamer completed ${result.rounds} round${result.rounds === 1 ? "" : "s"}.`,
				`Pending facts: ${result.facts.length}; memories to verify: ${result.memories.length}; compartments to distill: ${result.compartments.length}.`,
			].join("\n"),
		};
	} catch (error) {
		return { kind: "error", text: `Dreamer failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/** Parse the argument-free append-only memory injection command. */
export function parseInjectMemoryInput(rawInput) {
	return String(rawInput ?? "").trim().length === 0 ? {} : { error: INJECT_MEMORY_USAGE };
}

/** Append the current memory selection to the next request without changing the derived head. */
export async function executeInjectMemoryCommand(invocation, { cdb, memoryConfig, resolveScope }) {
	const parsed = parseInjectMemoryInput(invocation.rawInput);
	if (parsed.error !== undefined) return { kind: "error", text: parsed.error };
	const agent = invocation.agent;
	if (agent === undefined || typeof agent.inject !== "function") {
		return { kind: "error", text: "inject-memory failed: no active agent is available." };
	}
	try {
		const scopePath = typeof resolveScope === "function" ? resolveScope(agent.session) : undefined;
		const selected = selectInjectionMemories(cdb, memoryConfig, Date.now(), scopePath);
		if (selected.length === 0) return { kind: "success", text: "No injectable project memories are available." };
		for (const memory of selected) recordInjectionHit(cdb, memory, memoryConfig);
		const text = renderInjectionText(selected);
		agent.inject(createContextNotice(
			`Inject Memory: ${selected.length} project memor${selected.length === 1 ? "y" : "ies"}`,
			text,
		));
		return { kind: "success", text: `Queued ${selected.length} project memor${selected.length === 1 ? "y" : "ies"} for the next model request.` };
	} catch (error) {
		return { kind: "error", text: `inject-memory failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/** Register per-agent ContextEngine commands over the current memory database. */
export function installContextCommands(ctx, dependencies) {
	const active = new Set();
	const track = (operation) => {
		active.add(operation);
		const retire = () => active.delete(operation);
		operation.then(retire, retire);
		return operation;
	};
	const searchHandler = (invocation) => track(executeCtxSearchCommand(invocation, dependencies));
	const dreamHandler = (invocation) => track(executeDreamCommand(invocation, {
		runDreamer: (agent) => dependencies.runDreamer(agent),
	}));
	const injectMemoryHandler = (invocation) => track(executeInjectMemoryCommand(invocation, dependencies));
	return ctx.effect(function* () {
		yield async () => Promise.allSettled(active);
		yield ctx.commands.register({
			name: "ctx-search",
			description: "Search project memories",
			input: { hint: "<query> [--limit N]" },
			handler: searchHandler,
		});
		yield ctx.commands.register({
			name: "dream",
			description: "Run Dreamer maintenance for this session",
			input: { hint: "(no arguments)" },
			handler: dreamHandler,
		});
		yield ctx.commands.register({
			name: "inject-memory",
			description: "Append project memories to the next model request",
			input: { hint: "(no arguments)" },
			handler: injectMemoryHandler,
		});
	}, "dsh-magic-context: user commands");
}

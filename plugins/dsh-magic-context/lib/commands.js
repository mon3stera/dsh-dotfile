import {
	distinctiveMemoryTerms,
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
export const ORGANIZE_MEMORIES_USAGE = "Usage: /organize-memories";
const MAX_RELATED_ORGANIZE_MEMORIES = 20;

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

/** Parse the argument-free memory-organization command. */
export function parseOrganizeMemoriesInput(rawInput) {
	return String(rawInput ?? "").trim().length === 0 ? {} : { error: ORGANIZE_MEMORIES_USAGE };
}

function formatOrganizeMemory(memory) {
	const archived = memory.archived === 1 || memory.archived === true ? " archived" : "";
	return `#${memory.id} [${memory.category}]${archived} ${memory.summary}\n${memory.content}`;
}

/** Related rows for the organize notice: FTS neighbors, including archived, excluding the injected set. */
export function collectRelatedMemories(cdb, selected, scopePath, limit = MAX_RELATED_ORGANIZE_MEMORIES) {
	if (typeof cdb?.ftsSearch !== "function" || !Array.isArray(selected) || selected.length === 0) return [];
	const selectedIds = new Set(selected.map((memory) => memory.id));
	const byId = new Map();
	for (const memory of selected) {
		const terms = distinctiveMemoryTerms(memory.summary, 4);
		for (const term of terms.length > 0 ? terms : [memory.summary]) {
			let rows;
			try {
				rows = cdb.ftsSearch(term, 5, scopePath);
			} catch {
				continue;
			}
			for (const row of rows ?? []) {
				if (row?.id === undefined || selectedIds.has(row.id) || byId.has(row.id)) continue;
				const full = typeof cdb.memoryById === "function" ? cdb.memoryById(row.id, scopePath) ?? row : row;
				if (full?.id === undefined) continue;
				byId.set(full.id, full);
				if (byId.size >= limit) return [...byId.values()];
			}
		}
	}
	return [...byId.values()];
}

/** Model-facing body: injected memories plus instructions to dedupe/retire, asking the user when unsure. */
export function renderOrganizeMemoriesText(selected, related = []) {
	const lines = [
		"Organize the currently injected project memories.",
		"Find duplicates and stale or contradicted rows.",
		"Use ctx_search first (archived memories stay searchable).",
		"If a live memory already covers a fact, ctx_memory update the keeper and delete extra ids.",
		"If a memory is stale or wrong, ctx_memory delete it.",
		"If two rows might be the same fact, or a delete is not obvious, ask the user before changing anything.",
		"Do not write a new memory unless the set is missing a durable fact the user confirms.",
		"",
		`CURRENTLY INJECTED (${selected.length}):`,
		selected.map((memory) => formatOrganizeMemory(memory)).join("\n\n") || "(none)",
	];
	if (related.length > 0) {
		lines.push("", `RELATED (${related.length}; not in the injection set, including archived):`, related.map((memory) => formatOrganizeMemory(memory)).join("\n\n"));
	}
	return lines.join("\n");
}

/** Ask the main Agent to review the current injection set for duplicates and stale rows. */
export async function executeOrganizeMemoriesCommand(invocation, { cdb, memoryConfig, resolveScope }) {
	const parsed = parseOrganizeMemoriesInput(invocation.rawInput);
	if (parsed.error !== undefined) return { kind: "error", text: parsed.error };
	const agent = invocation.agent;
	if (agent === undefined || typeof agent.inject !== "function") {
		return { kind: "error", text: "organize-memories failed: no active agent is available." };
	}
	try {
		const scopePath = typeof resolveScope === "function" ? resolveScope(agent.session) : undefined;
		const selected = selectInjectionMemories(cdb, memoryConfig, Date.now(), scopePath);
		if (selected.length === 0) return { kind: "success", text: "No injectable project memories are available to organize." };
		for (const memory of selected) recordInjectionHit(cdb, memory, memoryConfig);
		const related = collectRelatedMemories(cdb, selected, scopePath);
		agent.inject(createContextNotice(
			`Organize Memories: ${selected.length} injected`,
			renderOrganizeMemoriesText(selected, related),
		));
		return {
			kind: "success",
			text: `Queued ${selected.length} injected memor${selected.length === 1 ? "y" : "ies"} for the model to review. It will ask before changing anything uncertain.`,
		};
	} catch (error) {
		return { kind: "error", text: `organize-memories failed: ${error instanceof Error ? error.message : String(error)}` };
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
	const organizeMemoriesHandler = (invocation) => track(executeOrganizeMemoriesCommand(invocation, dependencies));
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
		yield ctx.commands.register({
			name: "organize-memories",
			description: "Ask the model to review injected memories for duplicates and stale rows",
			input: { hint: "(no arguments)" },
			handler: organizeMemoriesHandler,
		});
	}, "dsh-magic-context: user commands");
}

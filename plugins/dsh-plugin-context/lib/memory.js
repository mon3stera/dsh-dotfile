// project_memory: S(t) scoring, injection, and the ctx_memory / ctx_search
// tools (design §4.2–§4.5).
//
// S(t) = I₀ · (1 + α·ln(1+k)) · exp(−(ln2/τ_eff)·Δt), τ_eff = τ/(1+β·k).
// τ is the category half-life in days (null = never decays). Δt counts from
// the last write/hit (LRU-style: used memories do not decay). S is clamped to
// 10; memories scoring below the archive threshold stop being injected but
// stay searchable, and a hit that lifts the score back above the threshold
// un-archives them.
import { defineTool } from "@deepseek-ai/dsh-tools";
import { CATEGORIES } from "./db.js";

export const DEFAULT_MEMORY_CONFIG = {
	alpha: 0.4,
	beta: 0.2,
	injectBudgetTokens: 4000,
	archiveThreshold: 0.15,
	halfLives: {
		ARCHITECTURE: null,
		CONSTRAINTS: null,
		ENVIRONMENT: null,
		CONVENTIONS: 30,
		PREFERENCES: 14,
	},
};

/** Heuristic token estimate (≈4 chars/token) for summary-sized text. */
export function estimateTokens(text) {
	return Math.ceil(text.length / 4);
}

/** One memory's current importance score. */
export function scoreMemory(memory, config, now = Date.now()) {
	let decay = 1;
	const halfLifeDays = config.halfLives[memory.category];
	if (halfLifeDays !== null && halfLifeDays !== undefined) {
		const tauEff = halfLifeDays / (1 + config.beta * memory.hits);
		const dtDays = (now - memory.last_hit_at) / 86400e3;
		if (dtDays > 0) decay = Math.exp(-(Math.LN2 / tauEff) * dtDays);
	}
	const boost = 1 + config.alpha * Math.log(1 + memory.hits);
	return Math.min(10, memory.importance * boost * decay);
}

/** Lazily archive a memory whose score fell below the threshold. */
export function maybeArchive(cdb, memory, config, now = Date.now()) {
	if (memory.archived === 0 && scoreMemory(memory, config, now) < config.archiveThreshold) {
		cdb.updateMemory(memory.id, { archived: 1 });
		return true;
	}
	return false;
}

/** Un-archive a memory whose score recovered (a hit lifted it). */
export function maybeUnarchive(cdb, memory, config, now = Date.now()) {
	if (memory.archived !== 0 && scoreMemory(memory, config, now) >= config.archiveThreshold) {
		cdb.updateMemory(memory.id, { archived: 0 });
		return true;
	}
	return false;
}

/**
 * Select memories for injection: score all non-archived, drop sub-threshold
 * (archiving them lazily), sort by score, and fill the token budget with
 * summaries only. Returns the selected rows (caller records hits).
 */
export function selectInjectionMemories(cdb, config, now = Date.now()) {
	const scored = cdb.allInjectableMemories()
		.map((memory) => ({ memory, score: scoreMemory(memory, config, now) }))
		.filter(({ memory, score }) => {
			if (score < config.archiveThreshold) {
				cdb.updateMemory(memory.id, { archived: 1 });
				return false;
			}
			return true;
		})
		.sort((a, b) => b.score - a.score);
	const selected = [];
	let budget = config.injectBudgetTokens;
	for (const { memory } of scored) {
		const cost = estimateTokens(memory.summary) + 2; // + category tag
		if (cost > budget) break;
		selected.push(memory);
		budget -= cost;
	}
	return selected;
}

/** Build the <project_memory> injection message text for selected memories. */
export function renderInjectionText(selected) {
	if (selected.length === 0) return "";
	const lines = selected.map((memory) => `[${memory.category}] ${memory.summary}`);
	return `<project_memory>\n${lines.join("\n")}\n</project_memory>`;
}

/** Record one injection hit (k+1, last_hit_at refresh, unarchive if recovered). */
export function recordInjectionHit(cdb, memory, config, now = Date.now()) {
	cdb.recordMemoryHit(memory.id, now);
	if (memory.archived !== 0) maybeUnarchive(cdb, memory, config, now);
}

/** Build the registered ctx_memory tool (write / delete). */
export function createMemoryTool(cdb) {
	return defineTool({
		name: "ctx_memory",
		description: [
			"Write a new project memory or delete an existing one.",
			"Write requires category (ARCHITECTURE/CONSTRAINTS/CONVENTIONS/PREFERENCES/ENVIRONMENT), summary (short, injected into future contexts), content (full detail), and importance (0-10, your assessment of long-term value).",
			"Delete requires the numeric id of an existing memory — use ctx_search to find ids.",
		].join(" "),
		parameters: {
			action: { type: "string", enum: ["write", "delete"], required: true, description: "write a new memory, or delete by id" },
			id: { type: "number", description: "memory id (required for delete)" },
			category: { type: "string", enum: [...CATEGORIES], description: "required for write" },
			summary: { type: "string", description: "short summary, required for write" },
			content: { type: "string", description: "full detail, required for write" },
			importance: { type: "number", description: "0-10, required for write" },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					id: { type: "number" },
					message: { type: "string", required: true },
				},
			},
			render: (args, value) => [{ type: "text", text: value.message }],
		},
		execute(args) {
			if (args.action === "delete") {
				if (typeof args.id !== "number") return { ok: false, message: "ctx_memory delete requires a numeric id (use ctx_search to find it)" };
				if (cdb.memoryById(args.id) === undefined) return { ok: false, message: `memory ${args.id} does not exist` };
				cdb.deleteMemory(args.id);
				return { ok: true, id: args.id, message: `deleted memory ${args.id}` };
			}
			if (typeof args.category !== "string" || typeof args.summary !== "string" || typeof args.content !== "string" || typeof args.importance !== "number") {
				return { ok: false, message: "ctx_memory write requires category, summary, content, importance" };
			}
			const id = cdb.writeMemory({ category: args.category, summary: args.summary, content: args.content, importance: args.importance });
			return { ok: true, id, message: `wrote memory ${id} [${args.category}]` };
		},
	});
}

const MAX_CONTENT_CHARS = 4000;

/** Build the registered ctx_search tool (FTS5 today; vec/RRF/rerank in Phase 6). */
export function createSearchTool(cdb, config = DEFAULT_MEMORY_CONFIG) {
	return defineTool({
		name: "ctx_search",
		description: [
			"Recall project memories relevant to a query.",
			"Returns the most relevant memories (id, category, summary, content) and records a hit on the returned ones, which strengthens them for future injection.",
		].join(" "),
		parameters: {
			query: { type: "string", required: true, description: "what to look for in project memories" },
			limit: { type: "number", description: "max results, default 5" },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					results: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								id: { type: "number", required: true },
								category: { type: "string", required: true },
								summary: { type: "string", required: true },
								content: { type: "string", required: true },
							},
						},
					},
				},
			},
			render: (args, value) => {
				if (value.results.length === 0) return [{ type: "text", text: "No memories matched." }];
				const text = value.results.map((r) => `#${r.id} [${r.category}] ${r.summary}\n${r.content}`).join("\n\n");
				return [{ type: "text", text }];
			},
		},
		execute(args) {
			const limit = typeof args.limit === "number" ? Math.max(1, Math.min(10, Math.floor(args.limit))) : 5;
			const rows = cdb.ftsSearch(args.query, limit);
			const now = Date.now();
			for (const row of rows) {
				cdb.recordMemoryHit(row.id, now);
				if (row.archived !== 0) maybeUnarchive(cdb, row, config, now);
			}
			return {
				results: rows.map((row) => ({
					id: row.id,
					category: row.category,
					summary: row.summary,
					content: row.content.slice(0, MAX_CONTENT_CHARS),
				})),
			};
		},
	});
}

/** System-prompt section teaching the memory block and tools. */
export const MEMORY_SECTION = {
	name: "context-project-memory",
	order: 101,
	text: [
		"<project_memory> blocks at the top of the context contain this project's durable memories (summary only, most relevant first).",
		"Ask ctx_search for full details; write durable facts (architecture decisions, constraints, conventions, preferences, environment) with ctx_memory so they survive compaction and future sessions.",
	].join(" "),
};

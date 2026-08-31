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
import { rrfMerge } from "./retrieval.js";
import { currentSessionSource } from "./session-context.js";

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
export function selectInjectionMemories(cdb, config, now = Date.now(), scopePath) {
	const scored = cdb.allInjectableMemories(scopePath)
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

async function embedMemorySummary(cdb, retrieval, id, summary) {
	if (retrieval.embedding === undefined || !cdb.vecEnabled) return;
	try {
		const vector = await retrieval.embedding.embed(summary);
		cdb.setEmbedding(id, vector);
	} catch {
		// embedding is best-effort; the memory stays FTS-searchable
	}
}

/** Build the registered ctx_memory tool (write / update / delete). */
export function createMemoryTool(cdb, retrieval = {}, { resolveScope } = {}) {
	const scopeOf = (exec) => typeof resolveScope === "function" ? resolveScope(exec?.agent?.session) : undefined;
	return defineTool({
		name: "ctx_memory",
		description: [
			"Write a new project memory, update an existing one, or delete by id.",
			"Always ctx_search first. If a live memory already covers the fact, update that id instead of writing a second row. If a memory is stale or contradicted, delete it. Write only when search finds no duplicate and no stale row that should be replaced.",
			"Write requires category (ARCHITECTURE/CONSTRAINTS/CONVENTIONS/PREFERENCES/ENVIRONMENT), summary (short, injected into future contexts), content (full detail), and importance (0-10, your assessment of long-term value).",
			"Update requires id plus at least one of category, summary, content, importance; it replaces those fields on the existing row and re-queues Dreamer verification.",
			"PREFERENCES are global; all other categories bind automatically to the current Git workspace.",
			"Delete requires the numeric id of an existing memory — use ctx_search to find ids. Archived memories stay searchable; delete removes a row entirely.",
		].join(" "),
		parameters: {
			action: { type: "string", enum: ["write", "update", "delete"], required: true, description: "write a new memory, update an existing id, or delete by id" },
			id: { type: "number", description: "memory id (required for update and delete)" },
			category: { type: "string", enum: [...CATEGORIES], description: "required for write; optional for update" },
			summary: { type: "string", description: "short summary, required for write; optional for update" },
			content: { type: "string", description: "full detail, required for write; optional for update" },
			importance: { type: "number", description: "0-10, required for write; optional for update" },
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
		async execute(args, exec) {
			const scopePath = scopeOf(exec);
			if (args.action === "delete") {
				if (typeof args.id !== "number") return { ok: false, message: "ctx_memory delete requires a numeric id (use ctx_search to find it)" };
				if (cdb.memoryById(args.id, scopePath) === undefined) return { ok: false, message: `memory ${args.id} does not exist in this workspace` };
				cdb.deleteMemory(args.id);
				return { ok: true, id: args.id, message: `deleted memory ${args.id}` };
			}
			if (args.action === "update") {
				if (typeof args.id !== "number") return { ok: false, message: "ctx_memory update requires a numeric id (use ctx_search to find it)" };
				if (cdb.memoryById(args.id, scopePath) === undefined) return { ok: false, message: `memory ${args.id} does not exist in this workspace` };
				const fields = {};
				if (typeof args.category === "string") fields.category = args.category;
				if (typeof args.summary === "string") fields.summary = args.summary;
				if (typeof args.content === "string") fields.content = args.content;
				if (typeof args.importance === "number") fields.importance = args.importance;
				if (Object.keys(fields).length === 0) return { ok: false, message: "ctx_memory update requires at least one of category, summary, content, importance" };
				if (fields.category !== undefined && fields.category !== "PREFERENCES" && typeof scopePath !== "string") {
					return { ok: false, message: "project memory update requires a session workspace scope" };
				}
				fields.verified_at = null;
				const changed = cdb.updateMemory(args.id, fields, scopePath);
				if (!changed) return { ok: false, message: `memory ${args.id} does not exist` };
				if (fields.summary !== undefined) await embedMemorySummary(cdb, retrieval, args.id, cdb.memoryById(args.id).summary);
				return { ok: true, id: args.id, message: `updated memory ${args.id}` };
			}
			if (args.action !== "write") return { ok: false, message: "ctx_memory action must be write, update, or delete" };
			if (typeof args.category !== "string" || typeof args.summary !== "string" || typeof args.content !== "string" || typeof args.importance !== "number") {
				return { ok: false, message: "ctx_memory write requires category, summary, content, importance" };
			}
			if (args.category !== "PREFERENCES" && typeof scopePath !== "string") return { ok: false, message: "project memory write requires a session workspace scope" };
			const id = cdb.writeMemory({
				category: args.category,
				scopePath,
				summary: args.summary,
				content: args.content,
				importance: args.importance,
				...currentSessionSource(exec?.agent?.session),
			});
			await embedMemorySummary(cdb, retrieval, id, args.summary);
			return { ok: true, id, message: `wrote memory ${id} [${args.category}]` };
		},
	});
}

/** Render search rows identically for the agent tool and the user command. */
export function formatSearchResults(results) {
	if (results.length === 0) return "No memories matched.";
	return results.map((row) => `#${row.id} [${row.category}] ${row.summary}\n${row.content}`).join("\n\n");
}

/** Retrieval defaults when no embedding/rerank configuration is present. */
export const DEFAULT_RETRIEVAL = {
	ftsTopK: 20,
	vecTopK: 20,
	vecMinScore: 0.35,
	rrfK: 60,
	rerankTopN: 5,
	rerankInputTopK: 20,
	embedding: undefined,
	rerank: undefined,
};

/**
 * Hybrid memory search: FTS5 top-K (+ optional vector top-K fused with RRF),
 * optional rerank to rerankTopN, hits recorded on the returned rows.
 */
export async function searchMemories(cdb, memoryConfig, retrieval = DEFAULT_RETRIEVAL, query, limit = 5, scopePath) {
	const fts = cdb.ftsSearch(query, retrieval.ftsTopK, scopePath);
	let ranked = fts.map((row) => row.id);
	if (retrieval.embedding !== undefined && cdb.vecEnabled) {
		try {
			const vector = await retrieval.embedding.embed(query);
			const vec = cdb.vecSearch(vector, retrieval.vecTopK, { minSimilarity: retrieval.vecMinScore ?? DEFAULT_RETRIEVAL.vecMinScore })
				.map((row) => cdb.memoryById(row.rowid, scopePath))
				.filter((row) => row !== undefined)
				.map((row) => row.id);
			ranked = rrfMerge([ranked, vec], retrieval.rrfK);
		} catch {
			// vector path failed: keep FTS-only ranking
		}
	}
	let rows = ranked.map((id) => cdb.memoryById(id, scopePath)).filter((row) => row !== undefined);
	const maxResults = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 5;
	if (retrieval.rerank !== undefined && rows.length > 0) {
		try {
			const docs = rows.slice(0, retrieval.rerankInputTopK).map((row) => `${row.summary}\n${row.content}`);
			const order = await retrieval.rerank.rerank(query, docs);
			rows = order.slice(0, Math.min(maxResults, retrieval.rerankTopN)).map((entry) => rows[entry.index]).filter((row) => row !== undefined);
		} catch {
			rows = rows.slice(0, Math.min(maxResults, retrieval.rerankTopN));
		}
	} else {
		rows = rows.slice(0, maxResults);
	}
	const now = Date.now();
	for (const row of rows) {
		cdb.recordMemoryHit(row.id, now);
		const updated = cdb.memoryById(row.id, scopePath);
		if (updated?.archived !== 0) maybeUnarchive(cdb, updated, memoryConfig, now);
	}
	return rows;
}

/** Build the registered ctx_search tool (FTS5 + optional vec/RRF/rerank). */
export function createSearchTool(cdb, memoryConfig = DEFAULT_MEMORY_CONFIG, retrieval = DEFAULT_RETRIEVAL, { resolveScope } = {}) {
	const scopeOf = (exec) => typeof resolveScope === "function" ? resolveScope(exec?.agent?.session) : undefined;
	return defineTool({
		name: "ctx_search",
		description: [
			"Recall project memories relevant to a query, including archived rows.",
			"Archival only removes a memory from automatic injection; ctx_search still returns it.",
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
			render: (args, value) => [{ type: "text", text: formatSearchResults(value.results) }],
		},
		async execute(args, exec) {
			const limit = typeof args.limit === "number" ? Math.max(1, Math.min(10, Math.floor(args.limit))) : 5;
			const rows = await searchMemories(cdb, memoryConfig, retrieval, args.query, limit, scopeOf(exec));
			return {
				results: rows.map((row) => ({
					id: row.id,
					category: row.category,
					summary: row.summary,
					content: row.content,
				})),
			};
		},
	});
}

const MEMORY_STOPWORDS = new Set([
	"the", "and", "for", "that", "this", "with", "from", "are", "was", "were",
	"been", "have", "has", "had", "not", "but", "you", "your", "our", "their",
	"its", "into", "over", "after", "before", "about", "when", "then", "than",
	"also", "just", "only", "using", "used", "use", "must", "should", "will",
	"can", "may", "does", "did", "done", "one", "two", "new", "old", "true",
	"false", "into", "onto", "across", "because", "while", "where",
]);

/** Tokenize summary-sized text for duplicate detection. */
export function memoryMatchTokens(text) {
	return new Set(String(text ?? "").toLowerCase().match(/[a-z0-9_\-]{3,}|[\u4e00-\u9fff]{2,}/gu) ?? []);
}

/** Distinctive terms used as FTS probes (first unique non-stopword hits). */
export function distinctiveMemoryTerms(text, limit = 8) {
	const seen = new Set();
	const terms = [];
	for (const token of String(text ?? "").toLowerCase().match(/[a-z0-9_\-]{3,}|[\u4e00-\u9fff]{2,}/gu) ?? []) {
		if (MEMORY_STOPWORDS.has(token) || seen.has(token)) continue;
		seen.add(token);
		terms.push(token);
		if (terms.length >= limit) break;
	}
	return terms;
}

/** True when a candidate fact restates an existing memory's summary/content. */
export function isDuplicateMemoryText(factText, memory, threshold = 0.45) {
	const fact = String(factText ?? "").trim().toLowerCase();
	const summary = String(memory?.summary ?? "").trim().toLowerCase();
	const content = String(memory?.content ?? "").trim().toLowerCase();
	if (fact.length === 0 || summary.length === 0) return false;
	if (fact.length >= 12 && (summary.includes(fact) || fact.includes(summary))) return true;
	const left = memoryMatchTokens(fact);
	const right = memoryMatchTokens(`${summary} ${content}`);
	if (left.size === 0 || right.size === 0) return false;
	let intersection = 0;
	for (const token of left) {
		if (right.has(token)) intersection += 1;
	}
	return intersection / (left.size + right.size - intersection) >= threshold;
}

/** First live memory that already covers this fact text, if any. */
export function findDuplicateMemory(cdb, text, scopePath) {
	if (typeof cdb?.ftsSearch !== "function") return undefined;
	const terms = distinctiveMemoryTerms(text, 6);
	if (terms.length === 0) return undefined;
	for (let n = Math.min(4, terms.length); n >= 1; n -= 1) {
		let rows;
		try {
			rows = cdb.ftsSearch(terms.slice(0, n).join(" "), 8, scopePath);
		} catch {
			continue;
		}
		for (const row of rows ?? []) {
			const memory = row?.summary === undefined && typeof cdb.memoryById === "function"
				? cdb.memoryById(row.id, scopePath)
				: row;
			if (memory === undefined || memory.archived === 1) continue;
			if (typeof cdb.memoryById === "function" && cdb.memoryById(memory.id, scopePath) === undefined) continue;
			if (isDuplicateMemoryText(text, memory)) return memory;
		}
	}
	return undefined;
}

/** Drop organizer/session facts that already exist as live project memories. */
export function filterDuplicateFacts(cdb, facts, scopePath) {
	if (!Array.isArray(facts)) return [];
	return facts.filter((fact) => findDuplicateMemory(cdb, fact?.text, scopePath) === undefined);
}

/**
 * FTS union over distinctive terms in a conversation range.
 * Includes archived rows (search is supposed to see them); does not record hits.
 */
export function searchMemoriesForOrganizer(cdb, queryText, scopePath, limit = 24) {
	if (typeof cdb?.ftsSearch !== "function") return [];
	const terms = distinctiveMemoryTerms(queryText, 8);
	const byId = new Map();
	for (const term of terms) {
		let rows;
		try {
			rows = cdb.ftsSearch(term, 8, scopePath);
		} catch {
			continue;
		}
		for (const row of rows ?? []) {
			if (row?.id === undefined || byId.has(row.id)) continue;
			byId.set(row.id, row);
			if (byId.size >= limit) return [...byId.values()];
		}
	}
	return [...byId.values()];
}

/** System-prompt section teaching the memory block and tools. */
export const MEMORY_SECTION = {
	name: "context-project-memory",
	order: 101,
	text: [
		"<project_memory> blocks at the top of the context contain durable memories for the current Git workspace (summary only, most relevant first).",
		"PREFERENCES are global; ARCHITECTURE, CONSTRAINTS, CONVENTIONS, and ENVIRONMENT memories are bound to the current Git worktree and are never shared across projects.",
		"Ask ctx_search for full details, including archived memories (archival only stops automatic injection).",
		"Before ctx_memory write, ctx_search: update a duplicate in place, delete a stale row, and write only when neither applies.",
	].join(" "),
};

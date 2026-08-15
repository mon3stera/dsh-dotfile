// Dreamer: the background memory maintainer (design §4.7).
//
// A lightweight read-only tool loop (own LLM calls, never the agent loop):
// verifies memories against the codebase, promotes pending session facts,
// merges duplicates, marks compartments for archival, and then the engine's
// code path performs the REAL archival (budget + priority + surface removal).
// Tools are strictly read-only for the filesystem/SQL; every database write
// goes through purpose-built tools.
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { BlockAssembler, createAssistantMessage, createToolResultMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { estimateTokens } from "./memory.js";

export const DREAMER_INSTRUCTION = [
	"You are Dreamer, the background memory maintainer for this AI coding assistant.",
	"Three material lists are provided: PENDING SESSION FACTS (raw facts extracted from compacted conversations), MEMORIES TO VERIFY (project memories that may be outdated), and UNDISTILLED COMPARTMENTS (checkpoint summaries whose facts have not been promoted yet).",
	"",
	"Your jobs, in order:",
	"1. VERIFY memories against the real codebase using the read-only filesystem tools (fs_read/fs_list/fs_grep; workspace root is given). Correct factual drift with memory_update (fix summary/content/importance/category), or memory_archive memories that no longer match reality.",
	"2. PROMOTE pending session facts into project memories with promote_fact (choose category, summary wording, content, importance 0-10). Before promoting, check for duplicates with sql_query against the memories table and merge instead (promote into the existing row is not supported — promote the fact and then memory_update the older row to archived if it is redundant).",
	"3. DISTILL undistilled compartments: their facts may already be pending; verify with sql_query, and mark each processed compartment with compartment_mark (compartmentId, processed=true) once its facts are handled.",
	"4. RECOMMEND ARCHIVAL: mark compartments that should be archived with compartment_mark (compartmentId, archive=true) — prefer compartments already distilled to memory, then low-importance, then old ones. Real archival runs in code afterwards; you only mark.",
	"",
	"Rules:",
	"- Never modify files, never run shell commands, never write SQL other than read-only SELECTs.",
	"- Keep working until every item in the three lists is handled (verified/promoted/distilled/marked).",
	"- Finish with a plain-text summary of what you changed (no tags).",
].join("\n");

const MAX_READ_CHARS = 65536;
const MAX_GREP_MATCHES = 200;
const MAX_SQL_ROWS = 100;
const MAX_TOOL_TEXT = 8000;

/** Ensure a path stays inside the workspace root. */
function insideRoot(root, path) {
	const resolved = resolve(root, path);
	if (resolved !== root && !resolved.startsWith(root + sep)) throw new Error(`path escapes the workspace root: ${path}`);
	return resolved;
}

async function listDir(root, path) {
	const dir = insideRoot(root, path);
	const entries = await readdir(dir, { withFileTypes: true });
	return entries.map((entry) => ({
		name: entry.name,
		type: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other",
		path: join(relative(resolve(root), dir), entry.name).replaceAll("\\", "/"),
	}));
}

async function readText(root, path) {
	const file = insideRoot(root, path);
	const info = await stat(file);
	if (!info.isFile()) throw new Error(`not a file: ${path}`);
	if (info.size > MAX_READ_CHARS * 2) throw new Error(`file too large to read (${info.size} bytes); use fs_grep instead`);
	const text = await readFile(file, "utf8");
	return text.slice(0, MAX_READ_CHARS);
}

async function grepTree(root, pattern, start, maxMatches = MAX_GREP_MATCHES) {
	const base = resolve(root);
	const needle = new RegExp(pattern, "i");
	const matches = [];
	async function walk(dir) {
		if (matches.length >= maxMatches) return;
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (matches.length >= maxMatches) return;
			if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".dsh") continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(full);
			} else if (entry.isFile()) {
				try {
					const info = await stat(full);
					if (info.size > MAX_READ_CHARS * 4) continue;
					const text = await readFile(full, "utf8");
					const lines = text.split("\n");
					for (let i = 0; i < lines.length && matches.length < maxMatches; i += 1) {
						if (needle.test(lines[i])) {
							matches.push(`${relative(base, full).replaceAll("\\", "/")}:${i + 1}: ${lines[i].slice(0, 300)}`);
						}
					}
				} catch {
					// unreadable file: skip
				}
			}
		}
	}
	await walk(insideRoot(root, start));
	return matches;
}

/** Build the Dreamer's internal tool set. */
export function createDreamerTools(cdb, { workspaceRoot, retrieval = {} } = {}) {
	const root = resolve(workspaceRoot ?? process.cwd());
	const byName = new Map();
	const add = (tool) => {
		byName.set(tool.name, tool);
		return tool;
	};
	const tools = [
		add({
			name: "sql_query",
			description: "Run a READ-ONLY SQL SELECT against the context database (tables: memories, session_facts, compartments, paragraphs, skip_marks).",
			parameters: {
				type: "object",
				additionalProperties: false,
				properties: { sql: { type: "string" } },
				required: ["sql"],
			},
			async execute(args) {
				if (typeof args.sql !== "string" || !/^\s*SELECT\b/i.test(args.sql)) throw new Error("sql_query only accepts SELECT statements");
				const rows = cdb.db.prepare(args.sql).all();
				return rows.slice(0, MAX_SQL_ROWS);
			},
		}),
		add({
			name: "fs_list",
			description: "List one directory under the workspace root.",
			parameters: {
				type: "object",
				additionalProperties: false,
				properties: { path: { type: "string" } },
				required: ["path"],
			},
			execute: (args) => listDir(root, args.path ?? "."),
		}),
		add({
			name: "fs_read",
			description: "Read one text file under the workspace root (truncated at 64KB).",
			parameters: {
				type: "object",
				additionalProperties: false,
				properties: { path: { type: "string" } },
				required: ["path"],
			},
			execute: (args) => readText(root, args.path),
		}),
		add({
			name: "fs_grep",
			description: "Case-insensitive regex search across the workspace tree (skips node_modules/.git), returning file:line matches.",
			parameters: {
				type: "object",
				additionalProperties: false,
				properties: {
					pattern: { type: "string" },
					path: { type: "string" },
					maxMatches: { type: "number" },
				},
				required: ["pattern"],
			},
			execute: (args) => grepTree(root, args.pattern, args.path ?? ".", args.maxMatches),
		}),
		add({
			name: "memory_write",
			description: "Write a new project memory (used when merging or when a fact was already promoted separately).",
			parameters: {
				type: "object",
				additionalProperties: false,
				properties: {
					category: { type: "string", enum: ["ARCHITECTURE", "CONSTRAINTS", "CONVENTIONS", "PREFERENCES", "ENVIRONMENT"] },
					summary: { type: "string" },
					content: { type: "string" },
					importance: { type: "number" },
				},
				required: ["category", "summary", "content", "importance"],
			},
			async execute(args) {
				const id = cdb.writeMemory(args);
				if (retrieval.embedding !== undefined && cdb.vecEnabled) {
					try {
						const vector = await retrieval.embedding.embed(`${args.summary}\n${args.content}`);
						cdb.setEmbedding(id, JSON.stringify(vector));
					} catch {
						// best-effort
					}
				}
				return { id };
			},
		}),
		add({
			name: "memory_update",
			description: "Update fields of an existing memory (category/summary/content/importance/archived).",
			parameters: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: { type: "number" },
					category: { type: "string", enum: ["ARCHITECTURE", "CONSTRAINTS", "CONVENTIONS", "PREFERENCES", "ENVIRONMENT"] },
					summary: { type: "string" },
					content: { type: "string" },
					importance: { type: "number" },
					archived: { type: "boolean" },
				},
				required: ["id"],
			},
			execute(args) {
				const fields = { ...args };
				delete fields.id;
				const changed = cdb.updateMemory(args.id, fields);
				if (!changed) throw new Error(`memory ${args.id} does not exist`);
				return { ok: true };
			},
		}),
		add({
			name: "memory_archive",
			description: "Archive (retire) an outdated memory; it stops being injected but stays searchable.",
			parameters: {
				type: "object",
				additionalProperties: false,
				properties: { id: { type: "number" } },
				required: ["id"],
			},
			execute(args) {
				const changed = cdb.updateMemory(args.id, { archived: 1 });
				if (!changed) throw new Error(`memory ${args.id} does not exist`);
				return { ok: true };
			},
		}),
		add({
			name: "promote_fact",
			description: "Promote one pending session fact into a project memory.",
			parameters: {
				type: "object",
				additionalProperties: false,
				properties: {
					factId: { type: "number" },
					category: { type: "string", enum: ["ARCHITECTURE", "CONSTRAINTS", "CONVENTIONS", "PREFERENCES", "ENVIRONMENT"] },
					summary: { type: "string" },
					content: { type: "string" },
					importance: { type: "number" },
				},
				required: ["factId", "category", "summary", "content", "importance"],
			},
			async execute(args) {
				const fact = cdb.db.prepare("SELECT * FROM session_facts WHERE id = ?").get(args.factId);
				if (fact === undefined) throw new Error(`fact ${args.factId} does not exist`);
				if (fact.status !== "pending") throw new Error(`fact ${args.factId} is not pending`);
				const id = cdb.writeMemory({
					category: args.category,
					summary: args.summary,
					content: args.content,
					importance: args.importance,
				});
				if (retrieval.embedding !== undefined && cdb.vecEnabled) {
					try {
						const vector = await retrieval.embedding.embed(`${args.summary}\n${args.content}`);
						cdb.setEmbedding(id, JSON.stringify(vector));
					} catch {
						// best-effort
					}
				}
				cdb.promoteFact(args.factId, id);
				return { id };
			},
		}),
		add({
			name: "compartment_mark",
			description: "Mark a compartment: processed=true after its facts are distilled, and/or archive=true to recommend archival (priority 1 distilled, 2 low importance, 3 old).",
			parameters: {
				type: "object",
				additionalProperties: false,
				properties: {
					compartmentId: { type: "number" },
					processed: { type: "boolean" },
					archive: { type: "boolean" },
					importance: { type: "number" },
				},
				required: ["compartmentId"],
			},
			execute(args) {
				const compartment = cdb.compartmentById(args.compartmentId);
				if (compartment === undefined) throw new Error(`compartment ${args.compartmentId} does not exist`);
				if (args.processed === true) cdb.markCompartmentPromoted(args.compartmentId);
				if (args.archive === true || args.importance !== undefined) {
					cdb.flagCompartmentArchive(args.compartmentId, args.importance);
				}
				return { ok: true };
			},
		}),
	];
	return { tools, byName };
}

/** Material lists handed to the Dreamer as its first user message. */
export function buildDreamerBrief(cdb, verifyIntervalDays) {
	const facts = cdb.pendingFacts();
	const memories = cdb.memoriesNeedingVerification(Date.now(), verifyIntervalDays);
	const compartments = cdb.unpromotedCompartments();
	const brief = [
		`PENDING SESSION FACTS (${facts.length}):`,
		JSON.stringify(facts.map((f) => ({ id: f.id, sessionId: f.session_id, compartmentId: f.compartment_id, fact: f.fact, importance: f.importance })), null, 1),
		`MEMORIES TO VERIFY (${memories.length}):`,
		JSON.stringify(memories.map((m) => ({ id: m.id, category: m.category, summary: m.summary, content: m.content, importance: m.importance, hits: m.hits, created: new Date(m.created_at).toISOString(), lastHit: new Date(m.last_hit_at).toISOString() })), null, 1),
		`UNDISTILLED COMPARTMENTS (${compartments.length}):`,
		JSON.stringify(compartments.map((c) => ({ id: c.id, sessionId: c.session_id, generation: c.generation, summary: c.summary.slice(0, 2000), importance: c.importance })), null, 1),
	].join("\n\n");
	return { facts, memories, compartments, brief };
}

/**
 * Run one Dreamer maintenance pass.
 * @param ctx - host context with llm service.
 * @param cdb - context database.
 * @param opts - { agent?, provider, model, workspaceRoot, maxRounds, timeoutMs,
 *   verifyIntervalDays, retrieval }.
 * @returns { skipped, rounds, facts, memories, compartments }.
 */
export async function runDreamer(ctx, cdb, opts) {
	const {
		agent,
		provider,
		model,
		workspaceRoot,
		maxRounds = 20,
		timeoutMs = 600000,
		verifyIntervalDays = 30,
		retrieval = {},
	} = opts;
	const material = buildDreamerBrief(cdb, verifyIntervalDays);
	if (material.facts.length === 0 && material.memories.length === 0 && material.compartments.length === 0) {
		return { skipped: true, rounds: 0, ...material };
	}
	const { tools, byName } = createDreamerTools(cdb, { workspaceRoot, retrieval });
	const toolSchemas = tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	}));
	const messages = [
		createUserMessage({ content: [{ type: "text", text: material.brief }] }),
	];
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), timeoutMs);
	let rounds = 0;
	try {
		for (; rounds < maxRounds; rounds += 1) {
			const assembler = new BlockAssembler();
			const options = {
				provider,
				model,
				system: DREAMER_INSTRUCTION,
				messages,
				tools: toolSchemas,
				maxTokens: 8192,
				purpose: "compaction",
				signal: abort.signal,
				...(agent === undefined ? {} : { sessionId: agent.session.id }),
			};
			for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk);
			const finish = assembler.finish;
			if (finish.kind === "error" || finish.kind === "aborted") {
				throw new Error(`dreamer stream failed: ${finish.failure.message}`);
			}
			const blocks = assembler.blocks();
			const calls = blocks.filter((block) => block.type === "tool-call");
			messages.push(createAssistantMessage({ content: blocks, source: { provider, model } }));
			if (calls.length === 0) break;
			for (const call of calls) {
				const tool = byName.get(call.name);
				if (tool === undefined) {
					messages.push(createToolResultMessage({
						callId: call.id,
						content: [{ type: "text", text: `unknown tool: ${call.name}` }],
						isError: true,
					}));
					continue;
				}
				let value;
				let isError = false;
				try {
					value = await tool.execute(JSON.parse(call.arguments));
				} catch (error) {
					value = { error: error instanceof Error ? error.message : String(error) };
					isError = true;
				}
				const text = typeof value === "string" ? value : JSON.stringify(value, null, 1);
				messages.push(createToolResultMessage({
					callId: call.id,
					content: [{ type: "text", text: text.slice(0, MAX_TOOL_TEXT) }],
					isError,
				}));
			}
		}
		return { skipped: false, rounds, ...material };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Real archival (code path, after Dreamer only marks): keep active compartment
 * summaries within a token budget by archiving in priority order (promoted >
 * low importance > old). Surface removal happens separately, per session, in
 * the engine (archived checkpoint nodes need a live session to replace).
 * @param cdb - context database.
 * @param opts - { budgetTokens }.
 * @returns { archived: number[], total } archived compartment ids and remaining total.
 */
export function runArchival(cdb, { budgetTokens = 40000 } = {}) {
	const active = cdb.allActiveCompartments();
	let total = active.reduce((sum, compartment) => sum + estimateTokens(compartment.summary), 0);
	if (total <= budgetTokens) return { archived: [], total };
	const archived = [];
	for (const compartment of cdb.archivalCandidates()) {
		if (total <= budgetTokens) break;
		cdb.archiveCompartment(compartment.id);
		total -= estimateTokens(compartment.summary);
		archived.push(compartment.id);
	}
	return { archived, total };
}

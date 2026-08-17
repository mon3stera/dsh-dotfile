// Data layer for dsh-plugin-context: node:sqlite + FTS5 + sqlite-vec.
// One database file at $DSH_HOME/context/context.db (WAL). Owns every table
// from docs/context-management.md §4 and exposes the storage API the engine,
// paragraph injector, memory injector, tools, and Dreamer share.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { load as loadVec } from "sqlite-vec";

export const CATEGORIES = [
	"ARCHITECTURE",
	"CONSTRAINTS",
	"CONVENTIONS",
	"PREFERENCES",
	"ENVIRONMENT",
];
export const DEFAULT_EMBEDDING_DIM = 1024;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  category    TEXT NOT NULL CHECK(category IN ('ARCHITECTURE','CONSTRAINTS','CONVENTIONS','PREFERENCES','ENVIRONMENT')),
  scope_path  TEXT,
  summary     TEXT NOT NULL,
  content     TEXT NOT NULL,
  importance  REAL NOT NULL DEFAULT 5,
  hits        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  last_hit_at INTEGER NOT NULL,
  verified_at INTEGER,
  archived    INTEGER NOT NULL DEFAULT 0,
  source_session_id TEXT,
  source_compartment_id INTEGER,
  source_start_seq INTEGER,
  source_end_seq INTEGER
);
CREATE INDEX IF NOT EXISTS memories_category ON memories(category);
CREATE INDEX IF NOT EXISTS memories_archived ON memories(archived);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
  USING fts5(summary, content, content='memories', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, summary, content) VALUES (new.id, new.summary, new.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, summary, content)
  VALUES ('delete', old.id, old.summary, old.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, summary, content)
  VALUES ('delete', old.id, old.summary, old.content);
  INSERT INTO memories_fts(rowid, summary, content) VALUES (new.id, new.summary, new.content);
END;

CREATE TABLE IF NOT EXISTS paragraphs (
  session_id   TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  paragraph_no INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq),
  UNIQUE (session_id, paragraph_no)
);

CREATE TABLE IF NOT EXISTS skip_marks (
  session_id   TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  paragraph_no INTEGER NOT NULL,
  marked_at    INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS compartments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL,
  scope_path   TEXT,
  generation   INTEGER NOT NULL,
  start_seq    INTEGER NOT NULL,
  end_seq      INTEGER NOT NULL,
  start_para   INTEGER NOT NULL,
  end_para     INTEGER NOT NULL,
  summary      TEXT NOT NULL,
  memory_ids   TEXT,
  status       TEXT NOT NULL DEFAULT 'generating',
  created_at   INTEGER NOT NULL,
  landed_at    INTEGER,
  has_promoted_facts INTEGER NOT NULL DEFAULT 0,
  importance   REAL,
  archive_flagged INTEGER NOT NULL DEFAULT 0,
  archived     INTEGER NOT NULL DEFAULT 0,
  archived_at  INTEGER,
  shadowed_tokens INTEGER,
  provider     TEXT,
  model        TEXT,
  landing_seq  INTEGER,
  removed      INTEGER NOT NULL DEFAULT 0,
  UNIQUE (session_id, generation)
);
CREATE INDEX IF NOT EXISTS compartments_session ON compartments(session_id);
CREATE INDEX IF NOT EXISTS compartments_archived ON compartments(archived, status);

CREATE TABLE IF NOT EXISTS session_facts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL,
  scope_path   TEXT,
  compartment_id INTEGER,
  fact         TEXT NOT NULL,
  importance   REAL NOT NULL DEFAULT 5,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   INTEGER NOT NULL,
  promoted_memory_id INTEGER
);
CREATE INDEX IF NOT EXISTS session_facts_status ON session_facts(status);
`;

const VEC_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec
  USING vec0(embedding float[__EMBEDDING_DIM__]);
`;

function assertImportance(value, label = "importance") {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 10) {
		throw new Error(`${label} must be a finite number between 0 and 10`);
	}
}

function normalizeMemoryScope(category, scopePath) {
	if (category === "PREFERENCES") return null;
	if (scopePath === undefined || scopePath === null) return null;
	if (typeof scopePath !== "string" || scopePath.length === 0) throw new Error("memory scope_path must be a non-empty string or null");
	return scopePath;
}

function normalizeSourceSessionId(value) {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string" || value.length === 0) throw new Error("memory source_session_id must be a non-empty string or null");
	return value;
}

function normalizeSourceInteger(value, label) {
	if (value === undefined || value === null) return null;
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`memory ${label} must be a non-negative safe integer or null`);
	return value;
}

/** Scope predicate: undefined keeps low-level DB callers backward-compatible. */
export function memoryScopeMatches(memory, scopePath) {
	if (scopePath === undefined) return true;
	if (memory?.category === "PREFERENCES") return true;
	return typeof scopePath === "string" && memory?.scope_path === scopePath;
}

function normalizeVector(vector, embeddingDim) {
	const value = typeof vector === "string" ? JSON.parse(vector) : vector;
	if (!Array.isArray(value) || value.length !== embeddingDim || value.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
		throw new Error(`embedding vector must contain exactly ${embeddingDim} finite numbers`);
	}
	const norm = Math.sqrt(value.reduce((sum, item) => sum + item * item, 0));
	if (!Number.isFinite(norm) || norm === 0) throw new Error("embedding vector must have a non-zero norm");
	return JSON.stringify(value.map((item) => item / norm));
}

/** Convert sqlite-vec L2 distance between unit vectors into cosine similarity. */
export function similarityFromDistance(distance) {
	if (typeof distance !== "number" || !Number.isFinite(distance)) return -1;
	return Math.max(-1, Math.min(1, 1 - (distance * distance) / 2));
}

/** One open context database plus the typed storage API. */
export class ContextDb {
	constructor(db, vecEnabled, embeddingDim) {
		this.db = db;
		this.vecEnabled = vecEnabled;
		this.embeddingDim = embeddingDim;
	}

	close() {
		this.db.close();
	}

	// ── paragraphs ──────────────────────────────────────────────────────────

	paragraphFor(sessionId, seq) {
		const row = this.db.prepare("SELECT paragraph_no FROM paragraphs WHERE session_id = ? AND seq = ?").get(sessionId, seq);
		return row === undefined ? undefined : row.paragraph_no;
	}

	seqForParagraph(sessionId, paragraphNo) {
		const row = this.db.prepare("SELECT seq FROM paragraphs WHERE session_id = ? AND paragraph_no = ?").get(sessionId, paragraphNo);
		return row === undefined ? undefined : row.seq;
	}

	nextParagraphNo(sessionId) {
		const row = this.db.prepare("SELECT COALESCE(MAX(paragraph_no), 0) + 1 AS next FROM paragraphs WHERE session_id = ?").get(sessionId);
		return row.next;
	}

	/** Assign the next global paragraph number to (session, seq); idempotent. */
	assignParagraph(sessionId, seq) {
		const existing = this.paragraphFor(sessionId, seq);
		if (existing !== undefined) return existing;
		const no = this.nextParagraphNo(sessionId);
		this.db.prepare("INSERT INTO paragraphs(session_id, seq, paragraph_no) VALUES (?, ?, ?)").run(sessionId, seq, no);
		return no;
	}

	// ── skip marks ──────────────────────────────────────────────────────────

	markSkip(sessionId, seq, paragraphNo) {
		this.db.prepare("INSERT OR IGNORE INTO skip_marks(session_id, seq, paragraph_no, marked_at) VALUES (?, ?, ?, ?)")
			.run(sessionId, seq, paragraphNo, Date.now());
	}

	skippedSeqs(sessionId) {
		const rows = this.db.prepare("SELECT seq FROM skip_marks WHERE session_id = ?").all(sessionId);
		return new Set(rows.map((row) => row.seq));
	}

	clearSkips(sessionId) {
		this.db.prepare("DELETE FROM skip_marks WHERE session_id = ?").run(sessionId);
	}

	// ── compartments ────────────────────────────────────────────────────────

	insertCompartment({ sessionId, scopePath, generation, startSeq, endSeq, startPara, endPara, summary, memoryIds, shadowedTokens, provider, model }) {
		const result = this.db.prepare(
			"INSERT INTO compartments(session_id, scope_path, generation, start_seq, end_seq, start_para, end_para, summary, memory_ids, status, created_at, shadowed_tokens, provider, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'generating', ?, ?, ?, ?)"
		).run(sessionId, scopePath ?? null, generation, startSeq, endSeq, startPara, endPara, summary, memoryIds ?? null, Date.now(), shadowedTokens ?? null, provider ?? null, model ?? null);
		return Number(result.lastInsertRowid);
	}

	setCompartmentSummary(id, { summary, provider, model }) {
		this.db.prepare("UPDATE compartments SET summary = ?, provider = ?, model = ?, status = 'ready' WHERE id = ?")
			.run(summary, provider ?? null, model ?? null, id);
	}

	setCompartmentStatus(id, status) {
		this.db.prepare("UPDATE compartments SET status = ? WHERE id = ?").run(status, id);
	}

	compartmentById(id) {
		return this.db.prepare("SELECT * FROM compartments WHERE id = ?").get(id);
	}

	compartmentByGeneration(sessionId, generation) {
		return this.db.prepare("SELECT * FROM compartments WHERE session_id = ? AND generation = ?").get(sessionId, generation);
	}

	/** Ready (summary produced, not yet landed), per session, by generation. */
	readyCompartments(sessionId) {
		return this.db.prepare(
			"SELECT * FROM compartments WHERE session_id = ? AND status = 'ready' AND archived = 0 ORDER BY generation"
		).all(sessionId);
	}

	/** Landed, non-archived compartments of one session, by generation. */
	activeCompartments(sessionId) {
		return this.db.prepare(
			"SELECT * FROM compartments WHERE session_id = ? AND status = 'landed' AND archived = 0 ORDER BY generation"
		).all(sessionId);
	}

	/** Landed, non-archived compartments across all sessions (budget input). */
	allActiveCompartments() {
		return this.db.prepare("SELECT * FROM compartments WHERE status = 'landed' AND archived = 0 ORDER BY created_at").all();
	}

	/** Landed compartments whose facts Dreamer has not distilled yet. */
	unpromotedCompartments(scopePath) {
		const rows = this.db.prepare(
			"SELECT * FROM compartments WHERE status = 'landed' AND has_promoted_facts = 0 ORDER BY created_at"
		).all();
		return scopePath === undefined ? rows : rows.filter((row) => row.scope_path === scopePath);
	}

	/** Archival candidates ordered by priority: promoted first, then low importance, then old. */
	archivalCandidates() {
		return this.db.prepare(
			"SELECT * FROM compartments WHERE status = 'landed' AND archived = 0 ORDER BY has_promoted_facts DESC, importance ASC, created_at ASC"
		).all();
	}

	markCompartmentLanded(id, landingSeq, landedAt = Date.now()) {
		this.db.prepare("UPDATE compartments SET status = 'landed', landed_at = ?, landing_seq = COALESCE(?, landing_seq) WHERE id = ?")
			.run(landedAt, landingSeq ?? null, id);
	}

	/** Highest generation number recorded for one session (0 when none). */
	maxGeneration(sessionId) {
		const row = this.db.prepare("SELECT COALESCE(MAX(generation), 0) AS n FROM compartments WHERE session_id = ?").get(sessionId);
		return row.n;
	}

	/** One compartment whose landing replaced a specific surface seq (migration lookup). */
	compartmentByLandingSeq(sessionId, seq) {
		return this.db.prepare("SELECT * FROM compartments WHERE session_id = ? AND landing_seq = ?").get(sessionId, seq);
	}

	/** Archived compartments whose checkpoint node is still on the surface. */
	archivedCompartments(sessionId) {
		return this.db.prepare(
			"SELECT * FROM compartments WHERE session_id = ? AND archived = 1 AND removed = 0 ORDER BY landing_seq"
		).all(sessionId);
	}

	markCompartmentRemoved(id) {
		this.db.prepare("UPDATE compartments SET removed = 1 WHERE id = ?").run(id);
	}

	flagCompartmentArchive(id, importance) {
		this.db.prepare("UPDATE compartments SET archive_flagged = 1, importance = COALESCE(?, importance) WHERE id = ?")
			.run(importance ?? null, id);
	}

	archiveCompartment(id, archivedAt = Date.now()) {
		this.db.prepare("UPDATE compartments SET archived = 1, archived_at = ? WHERE id = ?").run(archivedAt, id);
	}

	markCompartmentPromoted(id) {
		this.db.prepare("UPDATE compartments SET has_promoted_facts = 1 WHERE id = ?").run(id);
	}

	// ── memories ────────────────────────────────────────────────────────────

	writeMemory({ category, scopePath, summary, content, importance, sourceSessionId, sourceCompartmentId, sourceStartSeq, sourceEndSeq }) {
		if (!CATEGORIES.includes(category)) throw new Error(`invalid memory category: ${String(category)}`);
		if (typeof summary !== "string" || summary.length === 0) throw new Error("memory summary must be a non-empty string");
		if (typeof content !== "string") throw new Error("memory content must be a string");
		assertImportance(importance);
		const normalizedScope = normalizeMemoryScope(category, scopePath);
		const normalizedSourceSessionId = normalizeSourceSessionId(sourceSessionId);
		const normalizedSourceCompartmentId = normalizeSourceInteger(sourceCompartmentId, "source_compartment_id");
		const normalizedSourceStartSeq = normalizeSourceInteger(sourceStartSeq, "source_start_seq");
		const normalizedSourceEndSeq = normalizeSourceInteger(sourceEndSeq, "source_end_seq");
		const now = Date.now();
		const result = this.db.prepare(
			"INSERT INTO memories(category, scope_path, summary, content, importance, hits, created_at, last_hit_at, verified_at, archived, source_session_id, source_compartment_id, source_start_seq, source_end_seq) VALUES (?, ?, ?, ?, ?, 0, ?, ?, NULL, 0, ?, ?, ?, ?)"
		).run(category, normalizedScope, summary, content, importance, now, now, normalizedSourceSessionId, normalizedSourceCompartmentId, normalizedSourceStartSeq, normalizedSourceEndSeq);
		return Number(result.lastInsertRowid);
	}

	/** Update whitelisted memory fields; an optional scope rejects cross-project mutation. */
	updateMemory(id, fields, scopePath) {
		const current = this.memoryById(id);
		if (current === undefined || !memoryScopeMatches(current, scopePath)) return false;
		const allowed = new Set(["category", "scope_path", "summary", "content", "importance", "archived", "verified_at", "hits", "last_hit_at"]);
		const normalized = Object.fromEntries(Object.entries(fields).filter(([key]) => allowed.has(key)));
		if (Object.keys(normalized).length === 0) return false;
		const nextCategory = normalized.category ?? current.category;
		if (nextCategory === "PREFERENCES" && (normalized.category !== undefined || normalized.scope_path !== undefined)) normalized.scope_path = null;
		else if (normalized.scope_path !== undefined) normalized.scope_path = normalizeMemoryScope(nextCategory, normalized.scope_path);
		const entries = Object.entries(normalized);
		for (const [key, value] of entries) {
			if (key === "category" && !CATEGORIES.includes(value)) throw new Error(`invalid memory category: ${String(value)}`);
			if (key === "scope_path" && value !== null && (typeof value !== "string" || value.length === 0)) throw new Error("memory scope_path must be a non-empty string or null");
			if (key === "summary" && (typeof value !== "string" || value.length === 0)) throw new Error("memory summary must be a non-empty string");
			if (key === "content" && typeof value !== "string") throw new Error("memory content must be a string");
			if (key === "importance") assertImportance(value);
		}
		const sets = entries.map(([key]) => `${key} = ?`).join(", ");
		const result = this.db.prepare(`UPDATE memories SET ${sets} WHERE id = ?`).run(...entries.map(([, value]) => value), id);
		return result.changes > 0;
	}

	memoryById(id, scopePath) {
		const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
		return row !== undefined && memoryScopeMatches(row, scopePath) ? row : undefined;
	}

	memoryVisibleToScope(memory, scopePath) {
		return memoryScopeMatches(memory, scopePath);
	}

	/** Physically delete one memory (ctx_memory delete; FTS trigger cleans up). */
	deleteMemory(id) {
		this.removeEmbedding(id);
		this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
	}

	/** Memories needing Dreamer verification: never verified, or older than the cycle. */
	memoriesNeedingVerification(now, verifyIntervalDays, scopePath) {
		const cutoff = now - verifyIntervalDays * 86400e3;
		const rows = this.db.prepare(
			"SELECT * FROM memories WHERE archived = 0 AND (verified_at IS NULL OR verified_at < ?) ORDER BY created_at"
		).all(cutoff);
		return scopePath === undefined ? rows : rows.filter((row) => memoryScopeMatches(row, scopePath));
	}

	recordMemoryHit(id, at = Date.now()) {
		this.db.prepare("UPDATE memories SET hits = hits + 1, last_hit_at = ? WHERE id = ?").run(at, id);
	}

	/** Injection candidates: non-archived, filtered to the current project/global scope. */
	allInjectableMemories(scopePath) {
		const rows = this.db.prepare("SELECT * FROM memories WHERE archived = 0 ORDER BY last_hit_at DESC").all();
		return scopePath === undefined ? rows : rows.filter((row) => memoryScopeMatches(row, scopePath));
	}

	// ── session facts ───────────────────────────────────────────────────────

	insertFact({ sessionId, scopePath, compartmentId, fact, importance }) {
		if (typeof fact !== "string" || fact.length === 0) throw new Error("session fact must be a non-empty string");
		assertImportance(importance);
		const result = this.db.prepare(
			"INSERT INTO session_facts(session_id, scope_path, compartment_id, fact, importance, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)"
		).run(sessionId, scopePath ?? null, compartmentId ?? null, fact, importance, Date.now());
		return Number(result.lastInsertRowid);
	}

	pendingFacts(scopePath) {
		const rows = this.db.prepare("SELECT * FROM session_facts WHERE status = 'pending' ORDER BY created_at").all();
		return scopePath === undefined ? rows : rows.filter((row) => row.scope_path === scopePath);
	}

	promoteFact(id, memoryId) {
		this.db.prepare("UPDATE session_facts SET status = 'promoted', promoted_memory_id = ? WHERE id = ?").run(memoryId, id);
	}

	/** Atomically create a memory and mark one pending fact as promoted. */
	promoteFactToMemory({ factId, scopePath, category, summary, content, importance }) {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const fact = this.db.prepare("SELECT status, scope_path, session_id, compartment_id FROM session_facts WHERE id = ?").get(factId);
			if (fact === undefined) throw new Error(`fact ${factId} does not exist`);
			if (scopePath !== undefined && fact.scope_path !== scopePath) throw new Error(`fact ${factId} does not belong to this workspace`);
			if (fact.status !== "pending") throw new Error(`fact ${factId} is not pending`);
			const compartment = fact.compartment_id === null ? undefined : this.compartmentById(fact.compartment_id);
			const memoryId = this.writeMemory({
				category,
				scopePath: fact.scope_path,
				summary,
				content,
				importance,
				sourceSessionId: fact.session_id,
				sourceCompartmentId: fact.compartment_id,
				sourceStartSeq: compartment?.start_seq,
				sourceEndSeq: compartment?.end_seq,
			});
			this.promoteFact(factId, memoryId);
			this.db.exec("COMMIT");
			return memoryId;
		} catch (error) {
			try { this.db.exec("ROLLBACK"); } catch {}
			throw error;
		}
	}

	discardFact(id) {
		this.db.prepare("UPDATE session_facts SET status = 'discarded' WHERE id = ?").run(id);
	}

	// ── retrieval ───────────────────────────────────────────────────────────

	/** FTS5-tokenized AND search over memories visible to the current scope. */
	ftsSearch(query, limit, scopePath) {
		const fragments = typeof query === "string" ? query.match(/\S+/gu) ?? [] : [];
		if (fragments.length === 0) return [];
		// Quote each user fragment so FTS5's tokenizer still handles hyphens,
		// CJK text, and punctuation without allowing query operators through.
		const matchQuery = fragments
			.map((fragment) => `"${fragment.replaceAll('"', '""')}"`)
			.join(" AND ");
		const params = [matchQuery];
		let scopeClause = "";
		if (scopePath !== undefined) {
			if (typeof scopePath === "string") {
				scopeClause = " AND (m.category = 'PREFERENCES' OR m.scope_path = ?)";
				params.push(scopePath);
			} else {
				scopeClause = " AND m.category = 'PREFERENCES'";
			}
		}
		params.push(limit);
		return this.db.prepare(
			`SELECT m.id, m.category, m.scope_path, m.summary, m.content, m.importance, m.hits,
			        bm25(memories_fts) AS rank
			 FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
			 WHERE memories_fts MATCH ?${scopeClause}
			 ORDER BY rank LIMIT ?`
		).all(...params);
	}

	/** Store one memory embedding (rowid = memory id) via validated numeric SQL. */
	setEmbedding(memoryId, vector) {
		if (!this.vecEnabled) return false;
		if (!Number.isSafeInteger(Number(memoryId))) throw new Error("memory id must be a safe integer");
		const vectorJson = normalizeVector(vector, this.embeddingDim);
		// vec0 is a virtual table: no INSERT OR REPLACE, so delete-then-insert.
		this.db.exec(`DELETE FROM memories_vec WHERE rowid = ${Number(memoryId)}`);
		this.db.exec(`INSERT INTO memories_vec(rowid, embedding) VALUES (${Number(memoryId)}, '${vectorJson}')`);
		return true;
	}

	removeEmbedding(memoryId) {
		if (!this.vecEnabled) return;
		if (!Number.isSafeInteger(Number(memoryId))) throw new Error("memory id must be a safe integer");
		this.db.exec(`DELETE FROM memories_vec WHERE rowid = ${Number(memoryId)}`);
	}

	/** KNN over normalized memory embeddings; optionally filters by cosine similarity. */
	vecSearch(embedding, k, { minSimilarity } = {}) {
		if (!this.vecEnabled) return [];
		if (minSimilarity !== undefined && (typeof minSimilarity !== "number" || !Number.isFinite(minSimilarity) || minSimilarity < -1 || minSimilarity > 1)) {
			throw new Error("minSimilarity must be a finite number between -1 and 1");
		}
		const embeddingJson = normalizeVector(embedding, this.embeddingDim);
		const rows = this.db.prepare(
			"SELECT rowid, distance FROM memories_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance"
		).all(embeddingJson, k);
		return rows
			.map((row) => ({ ...row, similarity: similarityFromDistance(row.distance) }))
			.filter((row) => minSimilarity === undefined || row.similarity >= minSimilarity);
	}
}

/**
 * Open (or create) the context database under a DSH home directory.
 * @param homeDir - DSH home (defaults to $DSH_HOME or ~/.dsh).
 * @param opts - { embeddingDim } for the vec0 table (fixed at creation).
 */
export function openDatabase(homeDir, opts = {}) {
	const embeddingDim = opts.embeddingDim ?? DEFAULT_EMBEDDING_DIM;
	const dir = join(homeDir, "context");
	mkdirSync(dir, { recursive: true });
	const db = new DatabaseSync(join(dir, "context.db"), { allowExtension: true });
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = NORMAL");
	let vecEnabled = false;
	try {
		loadVec(db);
		vecEnabled = true;
	} catch {
		// Vector path degrades to FTS5-only retrieval.
	}
	db.exec(SCHEMA);
	if (vecEnabled) {
		try {
			db.exec(VEC_SCHEMA.replaceAll("__EMBEDDING_DIM__", String(embeddingDim)));
		} catch {
			// A broken or incompatible vec table must not disable FTS5 storage.
			vecEnabled = false;
		}
	}
	migrate(db);
	return new ContextDb(db, vecEnabled, embeddingDim);
}

/** Additive column migrations for databases created before a field existed. */
function migrate(db) {
	const memoryCols = new Set(db.prepare("PRAGMA table_info(memories)").all().map((row) => row.name));
	for (const [name, ddl] of [
		["scope_path", "ALTER TABLE memories ADD COLUMN scope_path TEXT"],
		["source_session_id", "ALTER TABLE memories ADD COLUMN source_session_id TEXT"],
		["source_compartment_id", "ALTER TABLE memories ADD COLUMN source_compartment_id INTEGER"],
		["source_start_seq", "ALTER TABLE memories ADD COLUMN source_start_seq INTEGER"],
		["source_end_seq", "ALTER TABLE memories ADD COLUMN source_end_seq INTEGER"],
	]) {
		if (!memoryCols.has(name)) db.exec(ddl);
	}
	db.exec("CREATE INDEX IF NOT EXISTS memories_scope ON memories(category, scope_path, archived)");
	const factCols = new Set(db.prepare("PRAGMA table_info(session_facts)").all().map((row) => row.name));
	if (!factCols.has("scope_path")) db.exec("ALTER TABLE session_facts ADD COLUMN scope_path TEXT");
	const compartmentCols = new Set(
		db.prepare("PRAGMA table_info(compartments)").all().map((row) => row.name)
	);
	for (const [name, ddl] of [
		["scope_path", "ALTER TABLE compartments ADD COLUMN scope_path TEXT"],
		["shadowed_tokens", "ALTER TABLE compartments ADD COLUMN shadowed_tokens INTEGER"],
		["provider", "ALTER TABLE compartments ADD COLUMN provider TEXT"],
		["model", "ALTER TABLE compartments ADD COLUMN model TEXT"],
		["landing_seq", "ALTER TABLE compartments ADD COLUMN landing_seq INTEGER"],
		["removed", "ALTER TABLE compartments ADD COLUMN removed INTEGER NOT NULL DEFAULT 0"],
	]) {
		if (!compartmentCols.has(name)) db.exec(ddl);
	}
	const memoryCount = db.prepare("SELECT COUNT(*) AS count FROM memories").get().count;
	const ftsCount = db.prepare("SELECT COUNT(*) AS count FROM memories_fts_docsize").get().count;
	if (memoryCount !== ftsCount) db.exec("INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')");
}

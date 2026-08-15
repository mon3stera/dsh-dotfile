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
  summary     TEXT NOT NULL,
  content     TEXT NOT NULL,
  importance  REAL NOT NULL DEFAULT 5,
  hits        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  last_hit_at INTEGER NOT NULL,
  verified_at INTEGER,
  archived    INTEGER NOT NULL DEFAULT 0
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

CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec
  USING vec0(embedding float[__EMBEDDING_DIM__]);

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
  compartment_id INTEGER,
  fact         TEXT NOT NULL,
  importance   REAL NOT NULL DEFAULT 5,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   INTEGER NOT NULL,
  promoted_memory_id INTEGER
);
CREATE INDEX IF NOT EXISTS session_facts_status ON session_facts(status);
`;

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

	insertCompartment({ sessionId, generation, startSeq, endSeq, startPara, endPara, summary, memoryIds, shadowedTokens, provider, model }) {
		const result = this.db.prepare(
			"INSERT INTO compartments(session_id, generation, start_seq, end_seq, start_para, end_para, summary, memory_ids, status, created_at, shadowed_tokens, provider, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'generating', ?, ?, ?, ?)"
		).run(sessionId, generation, startSeq, endSeq, startPara, endPara, summary, memoryIds ?? null, Date.now(), shadowedTokens ?? null, provider ?? null, model ?? null);
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
	unpromotedCompartments() {
		return this.db.prepare(
			"SELECT * FROM compartments WHERE status = 'landed' AND has_promoted_facts = 0 ORDER BY created_at"
		).all();
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

	writeMemory({ category, summary, content, importance }) {
		const now = Date.now();
		const result = this.db.prepare(
			"INSERT INTO memories(category, summary, content, importance, hits, created_at, last_hit_at, verified_at, archived) VALUES (?, ?, ?, ?, 0, ?, ?, NULL, 0)"
		).run(category, summary, content, importance, now, now);
		return Number(result.lastInsertRowid);
	}

	/** Update whitelisted memory fields; returns true when the row exists. */
	updateMemory(id, fields) {
		const allowed = new Set(["category", "summary", "content", "importance", "archived", "verified_at", "hits", "last_hit_at"]);
		const entries = Object.entries(fields).filter(([key]) => allowed.has(key));
		if (entries.length === 0) return false;
		const sets = entries.map(([key]) => `${key} = ?`).join(", ");
		const result = this.db.prepare(`UPDATE memories SET ${sets} WHERE id = ?`).run(...entries.map(([, value]) => value), id);
		return result.changes > 0;
	}

	memoryById(id) {
		return this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
	}

	/** Physically delete one memory (ctx_memory delete; FTS trigger cleans up). */
	deleteMemory(id) {
		this.removeEmbedding(id);
		this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
	}

	/** Memories needing Dreamer verification: never verified, or older than the cycle. */
	memoriesNeedingVerification(now, verifyIntervalDays) {
		const cutoff = now - verifyIntervalDays * 86400e3;
		return this.db.prepare(
			"SELECT * FROM memories WHERE archived = 0 AND (verified_at IS NULL OR verified_at < ?) ORDER BY created_at"
		).all(cutoff);
	}

	recordMemoryHit(id, at = Date.now()) {
		this.db.prepare("UPDATE memories SET hits = hits + 1, last_hit_at = ? WHERE id = ?").run(at, id);
	}

	/** Injection candidates: non-archived, with S(t) computed by the caller. */
	allInjectableMemories() {
		return this.db.prepare("SELECT * FROM memories WHERE archived = 0 ORDER BY last_hit_at DESC").all();
	}

	// ── session facts ───────────────────────────────────────────────────────

	insertFact({ sessionId, compartmentId, fact, importance }) {
		const result = this.db.prepare(
			"INSERT INTO session_facts(session_id, compartment_id, fact, importance, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)"
		).run(sessionId, compartmentId ?? null, fact, importance, Date.now());
		return Number(result.lastInsertRowid);
	}

	pendingFacts() {
		return this.db.prepare("SELECT * FROM session_facts WHERE status = 'pending' ORDER BY created_at").all();
	}

	promoteFact(id, memoryId) {
		this.db.prepare("UPDATE session_facts SET status = 'promoted', promoted_memory_id = ? WHERE id = ?").run(memoryId, id);
	}

	discardFact(id) {
		this.db.prepare("UPDATE session_facts SET status = 'discarded' WHERE id = ?").run(id);
	}

	// ── retrieval ───────────────────────────────────────────────────────────

	/** FTS5 phrase search over non-archived memories, BM25-ranked. */
	ftsSearch(query, limit) {
		const quoted = `"${query.replace(/"/g, '""')}"`;
		return this.db.prepare(
			`SELECT m.id, m.category, m.summary, m.content, m.importance, m.hits,
			        bm25(memories_fts) AS rank
			 FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
			 WHERE memories_fts MATCH ? AND m.archived = 0
			 ORDER BY rank LIMIT ?`
		).all(quoted, limit);
	}

	/** Store one memory embedding (rowid = memory id) via raw SQL (vec0 rowid binding quirk). */
	setEmbedding(memoryId, vectorJson) {
		if (!this.vecEnabled) return false;
		// vec0 is a virtual table: no INSERT OR REPLACE, so delete-then-insert.
		this.db.exec(`DELETE FROM memories_vec WHERE rowid = ${Number(memoryId)}`);
		this.db.exec(`INSERT INTO memories_vec(rowid, embedding) VALUES (${Number(memoryId)}, '${vectorJson}')`);
		return true;
	}

	removeEmbedding(memoryId) {
		if (!this.vecEnabled) return;
		this.db.exec(`DELETE FROM memories_vec WHERE rowid = ${Number(memoryId)}`);
	}

	/** KNN over memory embeddings; returns [{rowid, distance}]. */
	vecSearch(embeddingJson, k) {
		if (!this.vecEnabled) return [];
		return this.db.prepare(
			"SELECT rowid, distance FROM memories_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance"
		).all(embeddingJson, k);
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
	db.exec(SCHEMA.replaceAll("__EMBEDDING_DIM__", String(embeddingDim)));
	migrate(db);
	return new ContextDb(db, vecEnabled, embeddingDim);
}

/** Additive column migrations for databases created before a field existed. */
function migrate(db) {
	const compartmentCols = new Set(
		db.prepare("PRAGMA table_info(compartments)").all().map((row) => row.name)
	);
	for (const [name, ddl] of [
		["shadowed_tokens", "ALTER TABLE compartments ADD COLUMN shadowed_tokens INTEGER"],
		["provider", "ALTER TABLE compartments ADD COLUMN provider TEXT"],
		["model", "ALTER TABLE compartments ADD COLUMN model TEXT"],
		["landing_seq", "ALTER TABLE compartments ADD COLUMN landing_seq INTEGER"],
		["removed", "ALTER TABLE compartments ADD COLUMN removed INTEGER NOT NULL DEFAULT 0"],
	]) {
		if (!compartmentCols.has(name)) db.exec(ddl);
	}
}

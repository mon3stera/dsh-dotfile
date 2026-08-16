// dsh-plugin-context data layer smoke test.
// Imports the installed copy (sqlite-vec resolves from the profile's shared
// node_modules): /home/mon3tr/.dsh/profiles/node_modules/dsh-plugin-context
import { openDatabase, CATEGORIES } from "/home/mon3tr/.dsh/profiles/node_modules/dsh-plugin-context/lib/db.js";
import { mkdtempSync, rmSync } from "node:fs";

const home = mkdtempSync("/home/mon3tr/ctx-db-smoke-");
let failed = 0;
const check = (label, ok) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
	if (!ok) failed += 1;
};
try {
	const cdb = openDatabase(home, {});
	check("vec0 enabled", cdb.vecEnabled === true);
	check("categories", CATEGORIES.join(",") === "ARCHITECTURE,CONSTRAINTS,CONVENTIONS,PREFERENCES,ENVIRONMENT");
	check("scope columns", ["scope_path"].every((name) => cdb.db.prepare("PRAGMA table_info(memories)").all().some((row) => row.name === name)) && ["scope_path"].every((name) => cdb.db.prepare("PRAGMA table_info(session_facts)").all().some((row) => row.name === name)) && ["scope_path"].every((name) => cdb.db.prepare("PRAGMA table_info(compartments)").all().some((row) => row.name === name)));

	// paragraphs: global monotonic, per-session, idempotent assign
	const p1 = cdb.assignParagraph("s1", 1);
	const p2 = cdb.assignParagraph("s1", 2);
	const p3 = cdb.assignParagraph("s2", 5);
	check("paragraph numbering", p1 === 1 && p2 === 2 && p3 === 1);
	check("assign idempotent", cdb.assignParagraph("s1", 1) === p1);
	check("seqForParagraph", cdb.seqForParagraph("s1", p2) === 2);

	// skip marks
	cdb.markSkip("s1", 2, p2);
	check("skip mark", [...cdb.skippedSeqs("s1")].join(",") === "2");
	cdb.clearSkips("s1");
	check("clear skips", cdb.skippedSeqs("s1").size === 0);

	// memories + FTS5
	const m1 = cdb.writeMemory({ category: "ARCHITECTURE", summary: "JWT auth design", content: "JWT with 30 day expiry and refresh rotation", importance: 8 });
	const m2 = cdb.writeMemory({ category: "PREFERENCES", summary: "Use spaces", content: "The project uses two-space indentation everywhere", importance: 3 });
	check("fts auth finds m1", JSON.stringify(cdb.ftsSearch("auth", 5).map((r) => r.id)) === JSON.stringify([m1]));
	check("fts spaces finds m2", JSON.stringify(cdb.ftsSearch("spaces", 5).map((r) => r.id)) === JSON.stringify([m2]));
	cdb.updateMemory(m2, { archived: 1 });
	check("fts includes archived memories", cdb.ftsSearch("spaces", 5).some((r) => r.id === m2));
	cdb.updateMemory(m2, { archived: 0 });
	check("importance validation", (() => { try { cdb.writeMemory({ category: "ARCHITECTURE", summary: "bad", content: "bad", importance: 11 }); return false; } catch { return true; } })());

	// vec path (delete-then-insert update)
	const near = Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : 0);
	const far = Array.from({ length: 1024 }, (_, index) => index === 1 ? 1 : 0);
	const close = Array.from({ length: 1024 }, (_, index) => index === 0 ? 0.8 : index === 1 ? 0.6 : 0);
	const farther = Array.from({ length: 1024 }, (_, index) => index === 0 ? 0.7 : index === 1 ? Math.sqrt(0.51) : 0);
	cdb.setEmbedding(m1, near);
	cdb.setEmbedding(m2, far);
	const thresholded = cdb.vecSearch(near, 2, { minSimilarity: 0.9 });
	check("vec similarity threshold", thresholded.length === 1 && thresholded[0].rowid === m1 && thresholded[0].similarity >= 0.9);
	cdb.setEmbedding(m1, near);
	cdb.setEmbedding(m2, close);
	const q = near;
	check("vec knn", JSON.stringify(cdb.vecSearch(q, 2).map((r) => r.rowid)) === JSON.stringify([m1, m2]));
	cdb.setEmbedding(m2, farther);
	check("vec update", JSON.stringify(cdb.vecSearch(q, 2).map((r) => r.rowid)) === JSON.stringify([m1, m2]));
	cdb.removeEmbedding(m1);
	check("vec remove", JSON.stringify(cdb.vecSearch(q, 2).map((r) => r.rowid)) === JSON.stringify([m2]));

	// compartments lifecycle + archival priority (promoted > low importance/NULL > old)
	const c1 = cdb.insertCompartment({ sessionId: "s", generation: 1, startSeq: 1, endSeq: 2, startPara: 1, endPara: 2, summary: "a" });
	const c2 = cdb.insertCompartment({ sessionId: "s", generation: 2, startSeq: 3, endSeq: 4, startPara: 3, endPara: 4, summary: "b" });
	const c3 = cdb.insertCompartment({ sessionId: "s", generation: 3, startSeq: 5, endSeq: 6, startPara: 5, endPara: 6, summary: "c" });
	check("generating status", cdb.readyCompartments("s").length === 0);
	for (const id of [c1, c2, c3]) {
		cdb.setCompartmentStatus(id, "ready");
		cdb.markCompartmentLanded(id);
	}
	check("ready+landed", cdb.readyCompartments("s").length === 0 && cdb.activeCompartments("s").length === 3);
	check("max generation survives active filtering", cdb.maxGeneration("s") === 3);
	cdb.markCompartmentPromoted(c1);
	cdb.flagCompartmentArchive(c2, 2);
	check("archival order promoted-first", cdb.archivalCandidates().map((x) => x.id).join(",") === `${c1},${c3},${c2}`);
	cdb.archiveCompartment(c3);
	check("archival after archive", cdb.archivalCandidates().map((x) => x.id).join(",") === `${c1},${c2}`);
	check("active excludes archived", cdb.activeCompartments("s").length === 2);

	// session facts
	const f1 = cdb.insertFact({ sessionId: "s", compartmentId: c1, fact: "project uses pnpm workspaces", importance: 6 });
	check("pending facts", cdb.pendingFacts().length === 1);
	cdb.promoteFact(f1, m1);
	check("promote fact", cdb.pendingFacts().length === 0);
	cdb.insertFact({ sessionId: "s", compartmentId: c1, fact: "deploy via rsync", importance: 4 });
	cdb.discardFact(cdb.pendingFacts()[0].id);
	check("discard fact", cdb.pendingFacts().length === 0);

	// verification cycle
	check("needs verification (fresh)", cdb.memoriesNeedingVerification(Date.now(), 30).length === 2);
	cdb.updateMemory(m1, { verified_at: Date.now() });
	check("needs verification after verify", cdb.memoriesNeedingVerification(Date.now(), 30).length === 1);
	check("updateMemory unknown field rejected", cdb.updateMemory(m2, { nope: 1 }) === false);
	cdb.db.exec("DELETE FROM memories_fts");
	cdb.close();
	const reopened = openDatabase(home, {});
	check("fts rebuilds missing index rows", reopened.ftsSearch("auth", 5).some((row) => row.id === m1));
	reopened.close();
} finally {
	rmSync(home, { recursive: true, force: true });
}
if (failed > 0) {
	console.error(`${failed} assertion(s) failed`);
	process.exit(1);
}
console.log("dsh-context db smoke: OK");

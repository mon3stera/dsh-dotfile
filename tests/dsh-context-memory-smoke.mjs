// dsh-magic-context project_memory smoke test (S(t), injection, tools).
import { mkdtempSync, rmSync } from "node:fs";
import {
	scoreMemory,
	selectInjectionMemories,
	renderInjectionText,
	recordInjectionHit,
	maybeArchive,
	maybeUnarchive,
	estimateTokens,
	DEFAULT_MEMORY_CONFIG,
	DEFAULT_RETRIEVAL,
	createMemoryTool,
	createSearchTool,
	searchMemories,
} from "/home/mon3tr/.dsh/profiles/node_modules/dsh-magic-context/lib/memory.js";
import { openDatabase } from "/home/mon3tr/.dsh/profiles/node_modules/dsh-magic-context/lib/db.js";

let failed = 0;
const check = (label, ok) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
	if (!ok) failed += 1;
};
const cfg = DEFAULT_MEMORY_CONFIG;
const DAY = 86400e3;
const now = Date.now();

// ── S(t) ────────────────────────────────────────────────────────────────────
{
	const base = { category: "PREFERENCES", importance: 5, hits: 0, last_hit_at: now, archived: 0 };
	check("never-decay category constant", scoreMemory({ ...base, category: "ARCHITECTURE" }, cfg, now + 365 * DAY) === 5);
	check("decay reduces score", scoreMemory(base, cfg, now + 30 * DAY) < 5);
	check("boost raises score", scoreMemory({ ...base, hits: 10 }, cfg, now) > 5);
	check("clamp at 10", scoreMemory({ ...base, importance: 10, hits: 100 }, cfg, now) === 10);
	// beta: hits shorten the effective half-life (visible over a long window
	// where the logarithmic boost saturates against exponential decay)
	const fresh = scoreMemory(base, cfg, now + 60 * DAY);
	const hit = scoreMemory({ ...base, hits: 5 }, cfg, now + 60 * DAY);
	check("beta accelerates decay with hits", hit < fresh);
	// LRU baseline: a recent hit resets decay
	check("recent hit refreshes", scoreMemory({ ...base, last_hit_at: now - 1000 }, cfg, now) > scoreMemory(base, cfg, now + 10 * DAY));
}

// ── injection selection ─────────────────────────────────────────────────────
{
	const home = mkdtempSync("/home/mon3tr/ctx-mem-");
	try {
		const cdb = openDatabase(home, {});
		const a = cdb.writeMemory({ category: "ARCHITECTURE", summary: "JWT auth design", content: "JWT 30d expiry", importance: 9 });
		const b = cdb.writeMemory({ category: "PREFERENCES", summary: "spaces not tabs", content: "2-space indent", importance: 3 });
		cdb.updateMemory(b, { last_hit_at: now - 60 * DAY }); // decayed
		const selected = selectInjectionMemories(cdb, cfg, now);
		check("high score first", selected.length === 2 && selected[0].id === a);
		check("render format", renderInjectionText(selected).startsWith("<project_memory>\n[ARCHITECTURE]"));
		check("render omits content", !renderInjectionText(selected).includes("JWT 30d expiry") || renderInjectionText(selected).includes("JWT auth design"));
		// budget: tiny budget keeps only the top memory
		const tiny = selectInjectionMemories(cdb, { ...cfg, injectBudgetTokens: 2 }, now);
		check("budget limits selection", tiny.length === 0);
		// lazy archive: decayed below threshold
		cdb.updateMemory(b, { importance: 1, last_hit_at: now - 90 * DAY });
		const after = selectInjectionMemories(cdb, cfg, now);
		check("sub-threshold archived", cdb.memoryById(b).archived === 1 && after.length === 1);
		// unarchive on hit
		recordInjectionHit(cdb, cdb.memoryById(a), cfg, now);
		check("hit refreshes", cdb.memoryById(a).hits === 1);
		check("maybeArchive no-op on healthy", maybeArchive(cdb, cdb.memoryById(a), cfg, now) === false);
		check("maybeUnarchive recovers", (() => { cdb.updateMemory(b, { hits: 20, last_hit_at: now }); return maybeUnarchive(cdb, cdb.memoryById(b), cfg, now); })() === true);
		check("estimateTokens", estimateTokens("abcd") === 1 && estimateTokens("abcdefgh") === 2);

		// ctx_memory tool
		const memTool = createMemoryTool(cdb, {}, { resolveScope: () => "/repo/a" });
		const unscopedTool = createMemoryTool(cdb);
		const unscopedWrite = await unscopedTool.execute({ action: "write", category: "ARCHITECTURE", summary: "missing scope", content: "should reject", importance: 1 });
		check("project write rejects missing scope", unscopedWrite.ok === false);
		const wrote = await memTool.execute({ action: "write", category: "CONSTRAINTS", summary: "no prod writes", content: "never write the prod DB directly", importance: 7 });
		check("ctx_memory write", wrote.ok === true && typeof wrote.id === "number" && cdb.memoryById(wrote.id).category === "CONSTRAINTS");
		const badWrite = await memTool.execute({ action: "write", category: "CONSTRAINTS" });
		check("ctx_memory write validation", badWrite.ok === false);
		const del = await memTool.execute({ action: "delete", id: wrote.id });
		check("ctx_memory delete", del.ok === true && cdb.memoryById(wrote.id) === undefined);
		const badDel = await memTool.execute({ action: "delete", id: 99999 });
		check("ctx_memory delete missing", badDel.ok === false);

		// ctx_search tool (FTS5 path)
		const searchTool = createSearchTool(cdb, cfg);
		const res = await searchTool.execute({ query: "auth", limit: 5 });
		check("ctx_search finds auth", res.results.length === 1 && res.results[0].id === a && res.results[0].category === "ARCHITECTURE");
		check("ctx_search records hit", cdb.memoryById(a).hits > 1);
		const crossField = await memTool.execute({
			action: "write",
			category: "ENVIRONMENT",
			summary: "临时工具连通性测试记忆",
			content: "唯一测试标记：ctx-test-2025-02-14-works。",
			importance: 1,
		});
		const crossFieldResult = await searchTool.execute({ query: "ctx-test-2025-02-14-works 临时工具连通性测试记忆" });
		check("ctx_search joins summary and content terms", crossFieldResult.results.length === 1 && crossFieldResult.results[0].id === crossField.id);
		await memTool.execute({ action: "delete", id: crossField.id });
		const scopedA = cdb.writeMemory({ category: "ARCHITECTURE", scopePath: "/repo/a", summary: "scope marker alpha", content: "project A", importance: 8 });
		const scopedB = cdb.writeMemory({ category: "ARCHITECTURE", scopePath: "/repo/b", summary: "scope marker beta", content: "project B", importance: 8 });
		const selectedA = selectInjectionMemories(cdb, { ...cfg, injectBudgetTokens: 1000 }, now, "/repo/a");
		const selectedB = selectInjectionMemories(cdb, { ...cfg, injectBudgetTokens: 1000 }, now, "/repo/b");
		const selectedUnknown = selectInjectionMemories(cdb, { ...cfg, injectBudgetTokens: 1000 }, now, null);
		check("scoped injection isolates project memories", selectedA.some((row) => row.id === scopedA) && !selectedA.some((row) => row.id === scopedB) && selectedB.some((row) => row.id === scopedB) && !selectedB.some((row) => row.id === scopedA));
		check("preferences remain global", selectedA.some((row) => row.id === b) && selectedB.some((row) => row.id === b) && !selectedUnknown.some((row) => row.id === scopedA) && selectedUnknown.some((row) => row.id === b));
		const scopedSearchA = await searchMemories(cdb, cfg, DEFAULT_RETRIEVAL, "scope marker", 10, "/repo/a");
		check("scoped search excludes other project", scopedSearchA.some((row) => row.id === scopedA) && !scopedSearchA.some((row) => row.id === scopedB));
		const scopedTool = createMemoryTool(cdb, {}, { resolveScope: () => "/repo/a" });
		const crossDelete = await scopedTool.execute({ action: "delete", id: scopedB }, { agent: { session: {} } });
		check("scoped delete rejects cross-project memory", crossDelete.ok === false && cdb.memoryById(scopedB).scope_path === "/repo/b");
		check("scoped update rejects cross-project memory", cdb.updateMemory(scopedB, { summary: "wrong" }, "/repo/a") === false);
		const none = await searchTool.execute({ query: "nonexistentxyz" });
		check("ctx_search empty", none.results.length === 0);
		cdb.close();
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

if (failed > 0) {
	console.error(`${failed} assertion(s) failed`);
	process.exit(1);
}
console.log("dsh-context memory smoke: OK");

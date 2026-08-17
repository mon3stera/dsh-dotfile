// dsh-magic-context retrieval smoke test (RRF, embedding/rerank clients,
// hybrid ctx_search).
import { mkdtempSync, rmSync } from "node:fs";
import { rrfMerge, EmbeddingClient, RerankClient, LocalEmbeddingClient, TRANSFORMERS_INSTALL_COMMAND, _setTransformersLoaderForTest, startMockRetrievalServer } from "/home/mon3tr/.dsh/profiles/node_modules/dsh-magic-context/lib/retrieval.js";
import { searchMemories, createMemoryTool, createSearchTool, DEFAULT_MEMORY_CONFIG } from "/home/mon3tr/.dsh/profiles/node_modules/dsh-magic-context/lib/memory.js";
import { openDatabase } from "/home/mon3tr/.dsh/profiles/node_modules/dsh-magic-context/lib/db.js";

let failed = 0;
const check = (label, ok) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
	if (!ok) failed += 1;
};

// ── RRF ─────────────────────────────────────────────────────────────────────
{
	check("rrf interleaves", JSON.stringify(rrfMerge([[1, 2, 3], [2, 4]], 60)) === "[2,1,4,3]");
	check("rrf k=1 dominates ranks", JSON.stringify(rrfMerge([[1, 2], [1, 3]], 1)) === "[1,2,3]");
	check("rrf single list", JSON.stringify(rrfMerge([[5, 6]], 60)) === "[5,6]");
}

// ── clients against a mock server ───────────────────────────────────────────
{
	const mock = await startMockRetrievalServer({
		vectors: (text) => (text.includes("jwt") ? [1, 1, 1, 1] : text.includes("spaces") ? [0, 0, 0, 0] : [0.5, 0.5, 0.5, 0.5]),
		rerankOrder: (query, docs) => docs.map((_, i) => i).sort((a, b) => b - a), // reverse input order
	});
	try {
		const embed = new EmbeddingClient({ baseUrl: mock.url, model: "test-embed", apiKey: "k" });
		check("embedding client", JSON.stringify(await embed.embed("jwt design")) === "[1,1,1,1]");
		const rerank = new RerankClient({ baseUrl: mock.url, model: "test-rerank", apiKey: "k" });
		const order = await rerank.rerank("q", ["doc0", "doc1", "doc2"]);
		check("rerank client reverses", JSON.stringify(order.map((o) => o.index)) === "[2,1,0]");
		check("rerank client scores", order[0].score >= order[1].score);
	} finally {
		await mock.close();
	}
}

// ── optional Transformers.js diagnostics ────────────────────────────────────
{
	const missing = Object.assign(new Error("Cannot find package '@huggingface/transformers' imported from retrieval.js"), { code: "ERR_MODULE_NOT_FOUND" });
	_setTransformersLoaderForTest(Promise.reject(missing));
	try {
		await new LocalEmbeddingClient().embed("missing optional dependency");
		check("missing Transformers.js rejects", false);
	} catch (error) {
		check("missing Transformers.js explains installation", error instanceof Error && error.message.includes("@huggingface/transformers is not installed") && error.message.includes(TRANSFORMERS_INSTALL_COMMAND));
	} finally {
		_setTransformersLoaderForTest(null);
	}
}

// ── hybrid search ───────────────────────────────────────────────────────────
{
	const home = mkdtempSync("/home/mon3tr/ctx-retr-");
	const embeddingInputs = [];
	const mock = await startMockRetrievalServer({
		vectors: (text) => { embeddingInputs.push(text); return [0.5, 0.5, 0.5, 0.5]; },
		rerankOrder: (query, docs) => docs.map((_, i) => i).reverse(),
	});
	try {
		const cdb = openDatabase(home, { embeddingDim: 4 });
		const retrieval = {
			ftsTopK: 20,
			vecTopK: 20,
			rrfK: 60,
			rerankTopN: 2,
			rerankInputTopK: 20,
			embedding: new EmbeddingClient({ baseUrl: mock.url, model: "e" }),
			rerank: new RerankClient({ baseUrl: mock.url, model: "r" }),
		};
		// seed memories with vectors
		const memTool = createMemoryTool(cdb, retrieval, { resolveScope: () => "/repo/a" });
		const a = await memTool.execute({ action: "write", category: "ARCHITECTURE", summary: "jwt auth", content: "30 day expiry", importance: 8 });
		const longContent = `2-space indent\n${"full detail ".repeat(500)}`;
		const b = await memTool.execute({ action: "write", category: "PREFERENCES", summary: "spaces", content: longContent, importance: 5 });
		check("write embeds", cdb.vecSearch("[0.5,0.5,0.5,0.5]", 5).length === 2);
		check("write embeds summary only", embeddingInputs[0] === "jwt auth" && embeddingInputs[1] === "spaces");

		// pure FTS search (no embedding, no rerank)
		const rows = await searchMemories(cdb, DEFAULT_MEMORY_CONFIG, { ...retrieval, embedding: undefined, rerank: undefined }, "jwt", 5);
		check("hybrid fts-only finds jwt", rows.length === 1 && rows[0].id === a.id);
		check("hybrid records hit", cdb.memoryById(a.id).hits === 1);

		// with rerank: reversed order → second memory first
		const reranked = await searchMemories(cdb, DEFAULT_MEMORY_CONFIG, retrieval, "jwt", 5);
		check("rerank reorders", reranked.length === 2 && reranked[0].id === b.id);
		const limited = await searchMemories(cdb, DEFAULT_MEMORY_CONFIG, retrieval, "jwt", 1);
		check("rerank respects limit", limited.length === 1);
		const searchTool = createSearchTool(cdb, DEFAULT_MEMORY_CONFIG, { ...retrieval, embedding: undefined, rerank: undefined });
		const fullContent = await searchTool.execute({ query: "spaces", limit: 5 });
		check("ctx_search returns full content", fullContent.results.find((row) => row.id === b.id)?.content.length === longContent.length);
		cdb.updateMemory(b.id, { archived: 1 });
		const archived = await searchMemories(cdb, DEFAULT_MEMORY_CONFIG, { ...retrieval, embedding: undefined, rerank: undefined }, "spaces", 5);
		check("archived memory remains searchable", archived.length === 1 && archived[0].id === b.id && cdb.memoryById(b.id).archived === 0);

		// degradation: embedding server down → FTS still works
		await mock.close();
		const degraded = await searchMemories(cdb, DEFAULT_MEMORY_CONFIG, { ...retrieval, embedding: new EmbeddingClient({ baseUrl: "http://127.0.0.1:1", model: "e" }) }, "jwt", 5);
		check("degraded search survives", degraded.length === 1 && degraded[0].id === a.id);
		cdb.close();
	} finally {
		await mock.close().catch(() => {});
		rmSync(home, { recursive: true, force: true });
	}
}

if (failed > 0) {
	console.error(`${failed} assertion(s) failed`);
	process.exit(1);
}
console.log("dsh-context retrieval smoke: OK");

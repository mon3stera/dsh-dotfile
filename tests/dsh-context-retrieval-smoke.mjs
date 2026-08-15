// dsh-plugin-context retrieval smoke test (RRF, embedding/rerank clients,
// hybrid ctx_search).
import { mkdtempSync, rmSync } from "node:fs";
import { rrfMerge, EmbeddingClient, RerankClient, startMockRetrievalServer } from "/home/mon3tr/.dsh/profiles/node_modules/dsh-plugin-context/lib/retrieval.js";
import { searchMemories, createMemoryTool, DEFAULT_MEMORY_CONFIG } from "/home/mon3tr/.dsh/profiles/node_modules/dsh-plugin-context/lib/memory.js";
import { openDatabase } from "/home/mon3tr/.dsh/profiles/node_modules/dsh-plugin-context/lib/db.js";

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

// ── hybrid search ───────────────────────────────────────────────────────────
{
	const home = mkdtempSync("/home/mon3tr/ctx-retr-");
	const mock = await startMockRetrievalServer({
		vectors: () => [0.5, 0.5, 0.5, 0.5],
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
		const memTool = createMemoryTool(cdb, retrieval);
		const a = await memTool.execute({ action: "write", category: "ARCHITECTURE", summary: "jwt auth", content: "30 day expiry", importance: 8 });
		const b = await memTool.execute({ action: "write", category: "PREFERENCES", summary: "spaces", content: "2-space indent", importance: 5 });
		check("write embeds", cdb.vecSearch("[0.5,0.5,0.5,0.5]", 5).length === 2);

		// pure FTS search (no embedding, no rerank)
		const rows = await searchMemories(cdb, DEFAULT_MEMORY_CONFIG, { ...retrieval, embedding: undefined, rerank: undefined }, "jwt", 5);
		check("hybrid fts-only finds jwt", rows.length === 1 && rows[0].id === a.id);
		check("hybrid records hit", cdb.memoryById(a.id).hits === 1);

		// with rerank: reversed order → second memory first
		const reranked = await searchMemories(cdb, DEFAULT_MEMORY_CONFIG, retrieval, "jwt", 5);
		check("rerank reorders", reranked.length === 2 && reranked[0].id === b.id);

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

// Optional retrieval backends for ctx_search: OpenAI-compatible embeddings,
// RRF fusion, and an OpenAI-compatible rerank endpoint (design §4.4).
//
// Everything here is OPTIONAL: with no embedding/rerank configuration the
// search path degrades to pure FTS5.
import { createServer } from "node:http";

/** Reciprocal-rank fusion over several ranked id lists. */
export function rrfMerge(lists, k = 60) {
	const scores = new Map();
	for (const list of lists) {
		for (let i = 0; i < list.length; i += 1) {
			const id = list[i];
			scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
		}
	}
	return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/** OpenAI-compatible /embeddings client (fetch injectable for tests). */
export class EmbeddingClient {
	constructor({ baseUrl, model, apiKey, fetchImpl = fetch }) {
		this.baseUrl = baseUrl.replace(/\/$/, "");
		this.model = model;
		this.apiKey = apiKey;
		this.fetchImpl = fetchImpl;
	}

	async embed(text) {
		const response = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(this.apiKey === undefined ? {} : { authorization: `Bearer ${this.apiKey}` }),
			},
			body: JSON.stringify({ model: this.model, input: text }),
		});
		if (!response.ok) throw new Error(`embedding request failed: HTTP ${response.status}`);
		const payload = await response.json();
		const vector = payload.data?.[0]?.embedding;
		if (!Array.isArray(vector) || vector.length === 0) throw new Error("embedding response carried no vector");
		return vector;
	}
}

/** OpenAI-compatible /rerank client (fetch injectable for tests). */
export class RerankClient {
	constructor({ baseUrl, model, apiKey, fetchImpl = fetch }) {
		this.baseUrl = baseUrl.replace(/\/$/, "");
		this.model = model;
		this.apiKey = apiKey;
		this.fetchImpl = fetchImpl;
	}

	/** @returns sorted [{index, score}] for documents, best first. */
	async rerank(query, documents) {
		const response = await this.fetchImpl(`${this.baseUrl}/rerank`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(this.apiKey === undefined ? {} : { authorization: `Bearer ${this.apiKey}` }),
			},
			body: JSON.stringify({ model: this.model, query, documents }),
		});
		if (!response.ok) throw new Error(`rerank request failed: HTTP ${response.status}`);
		const payload = await response.json();
		const results = payload.results ?? [];
		return results
			.map((entry) => ({ index: entry.index, score: entry.relevance_score ?? 0 }))
			.sort((a, b) => b.score - a.score);
	}
}

/** Start a tiny mock OpenAI-compatible server for tests; returns {url, close}. */
export function startMockRetrievalServer({ vectors, rerankOrder }) {
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => { body += chunk; });
		req.on("end", () => {
			res.setHeader("content-type", "application/json");
			if (req.url === "/embeddings") {
				const parsed = JSON.parse(body);
				const text = Array.isArray(parsed.input) ? parsed.input[0] : parsed.input;
				const vector = typeof vectors === "function" ? vectors(text) : vectors;
				res.end(JSON.stringify({ data: [{ embedding: vector }] }));
				return;
			}
			if (req.url === "/rerank") {
				const parsed = JSON.parse(body);
				const order = rerankOrder(parsed.query, parsed.documents);
				res.end(JSON.stringify({
					results: order.map((index, rank) => ({ index, relevance_score: 1 - rank / 10 })),
				}));
				return;
			}
			res.statusCode = 404;
			res.end("{}");
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			resolve({
				url: `http://127.0.0.1:${port}`,
				close: () => new Promise((done) => server.close(done)),
			});
		});
	});
}

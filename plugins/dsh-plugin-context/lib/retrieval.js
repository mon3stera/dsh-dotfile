// Optional retrieval backends for ctx_search: OpenAI-compatible embeddings,
// local Transformers.js BGE models, RRF fusion, and OpenAI-compatible rerank.
//
// Everything here is OPTIONAL: with no embedding/rerank configuration the
// search path degrades to pure FTS5.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";

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

/** Separate local preset registries: embedding and rerank can be enabled independently. */
export const LOCAL_EMBEDDING_PRESETS = Object.freeze({
	"bge-m3": Object.freeze({
		id: "bge-m3",
		label: "BGE-M3",
		model: "Xenova/bge-m3",
		embeddingDim: 1024,
		dtype: "q8",
	}),
});

export const LOCAL_RERANK_PRESETS = Object.freeze({
	"bge-reranker-v2-m3": Object.freeze({
		id: "bge-reranker-v2-m3",
		label: "bge-reranker-v2-m3",
		model: "onnx-community/bge-reranker-v2-m3-ONNX",
		dtype: "q8",
	}),
});

const PRESET_MAPS = Object.freeze({ embedding: LOCAL_EMBEDDING_PRESETS, rerank: LOCAL_RERANK_PRESETS });
let transformersLoader = null;
const localPipelines = new Map();
const localStatuses = new Map();

function localCacheDir() {
	const directory = join(resolveDshHome(), "context", ".cache");
	mkdirSync(directory, { recursive: true });
	return directory;
}

function presetOrThrow(kind, id) {
	const map = PRESET_MAPS[kind];
	const preset = map?.[id];
	if (preset === undefined) throw new Error(`unknown local ${kind} preset: ${id}`);
	return preset;
}

function statusKey(kind, id) {
	return `${kind}:${id}`;
}

async function loadTransformers() {
	if (transformersLoader === null) transformersLoader = import("@huggingface/transformers");
	const module = await transformersLoader;
	const cacheDir = localCacheDir();
	if (module.env !== undefined) {
		module.env.cacheDir = cacheDir;
		module.env.allowRemoteModels = true;
	}
	return { module, cacheDir };
}

function progressFor(kind, presetId) {
	const key = statusKey(kind, presetId);
	return (info) => {
		const previous = localStatuses.get(key) ?? { kind, id: presetId, status: "downloading" };
		localStatuses.set(key, {
			...previous,
			status: "downloading",
			file: typeof info?.file === "string" ? info.file : previous.file,
			progress: typeof info?.progress === "number" ? info.progress : previous.progress,
		});
	};
}

async function loadLocalEmbeddingPipeline(presetId) {
	const preset = presetOrThrow("embedding", presetId);
	const key = statusKey("embedding", presetId);
	if (!localPipelines.has(key)) {
		const promise = (async () => {
			const { module, cacheDir } = await loadTransformers();
			return module.pipeline("feature-extraction", preset.model, {
				dtype: preset.dtype,
				cache_dir: cacheDir,
				progress_callback: progressFor("embedding", presetId),
			});
		})();
		localPipelines.set(key, promise.catch((error) => {
			localPipelines.delete(key);
			throw error;
		}));
	}
	return localPipelines.get(key);
}

async function loadLocalRerankRuntime(presetId) {
	const preset = presetOrThrow("rerank", presetId);
	const key = statusKey("rerank", presetId);
	if (!localPipelines.has(key)) {
		const promise = (async () => {
			const { module, cacheDir } = await loadTransformers();
			const progress_callback = progressFor("rerank", presetId);
			const options = { dtype: preset.dtype, cache_dir: cacheDir, progress_callback };
			const [tokenizer, model] = await Promise.all([
				module.AutoTokenizer.from_pretrained(preset.model, options),
				module.AutoModelForSequenceClassification.from_pretrained(preset.model, options),
			]);
			return { tokenizer, model };
		})();
		localPipelines.set(key, promise.catch((error) => {
			localPipelines.delete(key);
			throw error;
		}));
	}
	return localPipelines.get(key);
}

/** Local BGE embedding client with a lazy, cache-backed Transformers.js pipeline. */
export class LocalEmbeddingClient {
	constructor({ preset = "bge-m3" } = {}) {
		this.preset = preset;
	}

	async embed(text) {
		const extractor = await loadLocalEmbeddingPipeline(this.preset);
		const output = await extractor(text, { pooling: "cls", normalize: true });
		return Array.from(output.data ?? output.tolist()?.[0] ?? []);
	}
}

/** Local BGE cross-encoder reranker with a lazy, cache-backed ONNX model. */
export class LocalRerankClient {
	constructor({ preset = "bge-reranker-v2-m3" } = {}) {
		this.preset = preset;
	}

	async rerank(query, documents) {
		if (documents.length === 0) return [];
		const { tokenizer, model } = await loadLocalRerankRuntime(this.preset);
		const inputs = tokenizer(query, { text_pair: documents, padding: true, truncation: true });
		const outputs = await model(inputs);
		const logits = outputs.logits;
		const width = logits.dims?.at(-1) ?? 1;
		const values = Array.from(logits.data ?? []);
		return documents.map((_, index) => {
			const raw = values[index * width] ?? 0;
			return { index, score: 1 / (1 + Math.exp(-raw)) };
		}).sort((a, b) => b.score - a.score);
	}
}

/** Start or join a background download/load for one local preset. */
export function ensureLocalPreset(kind, presetId) {
	presetOrThrow(kind, presetId);
	const key = statusKey(kind, presetId);
	const existing = localStatuses.get(key);
	if (existing?.status === "ready") return Promise.resolve(existing);
	if (existing?.promise !== undefined) return existing.promise;
	const status = { kind, id: presetId, status: "downloading", progress: 0 };
	const promise = (async () => {
		if (kind === "embedding") await loadLocalEmbeddingPipeline(presetId);
		else await loadLocalRerankRuntime(presetId);
		const ready = { kind, id: presetId, status: "ready", progress: 100 };
		localStatuses.set(key, ready);
		return ready;
	})().catch((error) => {
		const failed = { kind, id: presetId, status: "error", error: error instanceof Error ? error.message : String(error) };
		localStatuses.set(key, failed);
		throw error;
	});
	localStatuses.set(key, { ...status, promise });
	return promise;
}

export function localPresetStatus(kind, presetId) {
	presetOrThrow(kind, presetId);
	const status = localStatuses.get(statusKey(kind, presetId));
	if (status === undefined) return { kind, id: presetId, status: "idle", cacheDir: localCacheDir() };
	const { promise: _promise, ...publicStatus } = status;
	return { ...publicStatus, cacheDir: localCacheDir() };
}

/** Test seam for local model lifecycle without downloading multi-GB weights. */
export function _setTransformersLoaderForTest(loader) {
	transformersLoader = loader;
	localPipelines.clear();
	localStatuses.clear();
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

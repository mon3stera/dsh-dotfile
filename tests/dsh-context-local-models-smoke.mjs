// Local retrieval preset lifecycle smoke test without downloading model weights.
import {
	LOCAL_EMBEDDING_PRESETS,
	LOCAL_RERANK_PRESETS,
	LocalEmbeddingClient,
	LocalRerankClient,
	_setTransformersLoaderForTest,
	ensureLocalPreset,
	localPresetStatus,
} from "/home/mon3tr/.dsh/profiles/node_modules/dsh-magic-context/lib/retrieval.js";

let failed = 0;
const check = (label, ok) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
	if (!ok) failed += 1;
};

const calls = [];
_setTransformersLoaderForTest(Promise.resolve({
	env: {},
	pipeline: async (task, model, options) => {
		calls.push({ task, model, options });
		return async () => ({ data: new Float32Array([0.1, 0.2, 0.3]), dims: [1, 3] });
	},
	AutoTokenizer: {
		from_pretrained: async (_model, _options) => (query, options) => ({ query, documents: options.text_pair }),
	},
	AutoModelForSequenceClassification: {
		from_pretrained: async (_model, _options) => async (inputs) => ({
			logits: {
				dims: [inputs.documents.length, 1],
				data: new Float32Array(inputs.documents.map((_, index) => index === 1 ? 2 : -1)),
			},
		}),
	},
}));
try {
	check("separate preset metadata", LOCAL_EMBEDDING_PRESETS["bge-m3"].embeddingDim === 1024 && LOCAL_RERANK_PRESETS["bge-reranker-v2-m3"].dtype === "q8");
	const embedding = await new LocalEmbeddingClient({ preset: "bge-m3" }).embed("query");
	check("local embedding client", embedding.length === 3 && Math.abs(embedding[0] - 0.1) < 1e-6 && Math.abs(embedding[2] - 0.3) < 1e-6);
	const reranked = await new LocalRerankClient({ preset: "bge-reranker-v2-m3" }).rerank("query", ["first", "best"]);
	check("local rerank client", reranked[0].index === 1 && reranked.length === 2);
	const embeddingReady = await ensureLocalPreset("embedding", "bge-m3");
	const rerankReady = await ensureLocalPreset("rerank", "bge-reranker-v2-m3");
	check("separate preset ensure ready", embeddingReady.status === "ready" && rerankReady.status === "ready" && localPresetStatus("embedding", "bge-m3").status === "ready" && localPresetStatus("rerank", "bge-reranker-v2-m3").status === "ready");
	check("preset uses expected repositories", calls.some((call) => call.model === LOCAL_EMBEDDING_PRESETS["bge-m3"].model));
} finally {
	_setTransformersLoaderForTest(null);
}

if (failed > 0) {
	console.error(`${failed} assertion(s) failed`);
	process.exit(1);
}
console.log("dsh-context local models smoke: OK");

// File-backed Context Compact settings route and engine-override smoke test.
import { mkdtempSync, rmSync } from "node:fs";
import { Readable } from "node:stream";

let failed = 0;
const check = (label, ok) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
	if (!ok) failed += 1;
};

const home = mkdtempSync("/home/mon3tr/ctx-settings-");
const savedHome = process.env.DSH_HOME;
process.env.DSH_HOME = home;
try {
	const settings = await import("/home/mon3tr/.dsh/profiles/node_modules/dsh-magic-context/lib/settings.js");
	const { ContextSettingsSchema, CONTEXT_SETTINGS_DEFAULTS, buildModelCatalog, configPath, createModelCatalogHandler, handleContextConfig, handleContextModels, handleContextUsage, mergeContextConfig, apply } = settings;
	// The catalog route rides an inner inject on the host llm registry, so the
	// stub context must resolve nested injections the way cordis does.
	const fakeHostContext = (services) => ({
		...services,
		effect(factory) { return factory(); },
		inject(dependencies, callback) {
			if (dependencies.some((dependency) => services[dependency] === undefined)) return;
			callback(fakeHostContext(services));
		},
	});
	const registeredRoutes = [];
	const webServer = { register(route) { registeredRoutes.push(route); } };
	const catalogLlm = {
		listProviders: () => [{ id: "anthropic", name: "Anthropic" }, { id: "codelink", name: "Code Link" }, { id: "broken", name: "Broken" }, { id: "empty", name: "Empty" }],
		listModels: async (provider) => {
			if (provider === "broken") throw new Error("listing failed: 401");
			if (provider === "empty") return [];
			if (provider === "anthropic") return [{ id: "claude-opus-5", name: "Claude Opus 5" }];
			return [{ id: "gpt-5.6-luna", name: "GPT-5.6 Luna" }];
		},
		resolveModelInfo: async (provider, model) => (model === "claude-opus-5"
			? { reasoning: { efforts: [{ id: "low", name: "Low" }, { id: "max", name: "Max" }], defaultEffort: "low" } }
			: {}),
	};
	apply(fakeHostContext({ webServer, llm: catalogLlm }));
	check("settings uses Magic Context directory", configPath().endsWith("/magic-context/settings.json"));
	check("HTTP routes use Magic Context namespace", registeredRoutes.map((route) => route.path).join(",") === "/magic-context/config,/magic-context/usage,/magic-context/models/status,/magic-context/models/ensure,/magic-context/models/catalog");
	const withoutLlm = [];
	apply(fakeHostContext({ webServer: { register: (route) => withoutLlm.push(route.path) } }));
	check("catalog route needs the llm registry", !withoutLlm.includes("/magic-context/models/catalog") && withoutLlm.length === 4);

	// --- provider catalog over the host registry ------------------------------
	const catalog = await buildModelCatalog(catalogLlm);
	check("catalog lists routable providers", catalog.groups.map((group) => group.id).join(",") === "anthropic,codelink");
	check("catalog drops providers advertising nothing", !catalog.groups.some((group) => group.id === "empty"));
	check("catalog reports listing failures", catalog.failures.length === 1 && catalog.failures[0].id === "broken" && catalog.failures[0].message.includes("401"));
	const opus = catalog.groups[0].models[0];
	check("catalog carries model identity", opus.id === "claude-opus-5" && opus.name === "Claude Opus 5");
	check("catalog carries reasoning efforts", opus.reasoning.efforts.map((effort) => effort.id).join(",") === "low,max" && opus.reasoning.defaultEffort === "low");
	check("catalog omits reasoning when absent", catalog.groups[1].models[0].reasoning === undefined);
	const { setContextUsage, clearContextUsage } = await import("/home/mon3tr/.dsh/profiles/node_modules/dsh-magic-context/lib/usage.js");
	const result = ContextSettingsSchema["~standard"].validate({});
	check("schema supplies defaults", result.issues === undefined && result.value.generateThreshold === CONTEXT_SETTINGS_DEFAULTS.generateThreshold && result.value.embeddingPreset === "" && result.value.rerankPreset === "" && result.value.vecMinScore === 0.35);
	check("effort settings default to the adapter default", result.value.summarizationReasoningEffort === "" && result.value.dreamerReasoningEffort === "");
	const efforts = ContextSettingsSchema["~standard"].validate({ summarizationProvider: "codelink", summarizationModel: "gpt-5.6-luna", summarizationReasoningEffort: "low", dreamerProvider: "anthropic", dreamerModel: "claude-haiku-4-5", dreamerReasoningEffort: "minimal" });
	check("schema accepts separate organizer and dreamer targets", efforts.issues === undefined && efforts.value.summarizationModel === "gpt-5.6-luna" && efforts.value.summarizationReasoningEffort === "low" && efforts.value.dreamerModel === "claude-haiku-4-5" && efforts.value.dreamerReasoningEffort === "minimal");
	const zeroHalfLives = ContextSettingsSchema["~standard"].validate({ halfLives: { ARCHITECTURE: 0, CONSTRAINTS: 0, ENVIRONMENT: 0, CONVENTIONS: 30, PREFERENCES: 14 } });
	check("schema accepts zero half-life", zeroHalfLives.issues === undefined && zeroHalfLives.value.halfLives.ARCHITECTURE === 0 && zeroHalfLives.value.halfLives.ENVIRONMENT === 0);

	const request = (method, body) => {
		const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))], { objectMode: false });
		stream.method = method;
		return stream;
	};
	const response = () => {
		const state = { status: 0, headers: {}, body: "" };
		return {
			state,
			writeHead(status, headers) { state.status = status; state.headers = headers; },
			end(body = "") { state.body += body; },
		};
	};

	const catalogResponse = response();
	await createModelCatalogHandler(catalogLlm)({ method: "GET" }, catalogResponse);
	const catalogPayload = JSON.parse(catalogResponse.state.body);
	check("catalog route answers", catalogResponse.state.status === 200 && catalogPayload.ok === true && catalogPayload.groups.length === 2);
	const catalogRejected = response();
	await createModelCatalogHandler(catalogLlm)({ method: "POST" }, catalogRejected);
	check("catalog route is read-only", catalogRejected.state.status === 405);
	const catalogBroken = response();
	await createModelCatalogHandler({ listProviders: () => { throw new Error("registry gone"); } })({ method: "GET" }, catalogBroken);
	const brokenPayload = JSON.parse(catalogBroken.state.body);
	check("catalog failure degrades to manual entry", catalogBroken.state.status === 200 && brokenPayload.ok === false && brokenPayload.groups.length === 0);

	const initialResponse = response();
	await handleContextConfig(request("GET"), initialResponse);
	const initial = JSON.parse(initialResponse.state.body);
	check("GET returns defaults", initialResponse.state.status === 200 && initial.ok === true && initial.config.retainRounds === 20);
	setContextUsage("usage-session", { compartments: { count: 2, tokens: 1234 }, memories: { count: 6, tokens: 456 } });
	const usageResponse = response();
	await handleContextUsage({ method: "GET", url: "/magic-context/usage?sessionId=usage-session" }, usageResponse);
	const usage = JSON.parse(usageResponse.state.body);
	check("usage route returns current components", usageResponse.state.status === 200 && usage.ok === true && usage.compartments.count === 2 && usage.compartments.tokens === 1234 && usage.memories.count === 6 && usage.memories.tokens === 456 && usage.totalTokens === 1690);
	clearContextUsage("usage-session");
	const modelStatusResponse = response();
	await handleContextModels({ method: "GET", url: "/magic-context/models/status?kind=embedding&preset=bge-m3" }, modelStatusResponse);
	const modelStatus = JSON.parse(modelStatusResponse.state.body);
	check("embedding model status route", modelStatusResponse.state.status === 200 && modelStatus.ok === true && modelStatus.kind === "embedding" && modelStatus.id === "bge-m3");
	const rerankStatusResponse = response();
	await handleContextModels({ method: "GET", url: "/magic-context/models/status?kind=rerank&preset=bge-reranker-v2-m3" }, rerankStatusResponse);
	const rerankStatus = JSON.parse(rerankStatusResponse.state.body);
	check("rerank model status route", rerankStatusResponse.state.status === 200 && rerankStatus.ok === true && rerankStatus.kind === "rerank" && rerankStatus.id === "bge-reranker-v2-m3");
	const zeroResponse = response();
	await handleContextConfig(request("POST", { ...initial.config, halfLives: { ...initial.config.halfLives, ARCHITECTURE: 0, ENVIRONMENT: 0 } }), zeroResponse);
	const zeroPayload = JSON.parse(zeroResponse.state.body);
	check("POST normalizes zero half-lives", zeroResponse.state.status === 200 && zeroPayload.config.halfLives.ARCHITECTURE === null && zeroPayload.config.halfLives.ENVIRONMENT === null);

	const postResponse = response();
	await handleContextConfig(request("POST", {
		...initial.config,
		generateThreshold: 0.55,
		retainRounds: 8,
		vecMinScore: 0.6,
		embeddingPreset: "bge-m3",
		rerankPreset: "bge-reranker-v2-m3",
		halfLives: { ...initial.config.halfLives, CONVENTIONS: 45 },
		summarizationProvider: "codelink",
		summarizationModel: "gpt-5.6-luna",
		summarizationReasoningEffort: "low",
		dreamerProvider: "anthropic",
		dreamerModel: "claude-haiku-4-5",
		dreamerReasoningEffort: "minimal",
	}), postResponse);
	const posted = JSON.parse(postResponse.state.body);
	check("POST accepts valid settings", postResponse.state.status === 200 && posted.ok === true && posted.config.retainRounds === 8 && posted.config.vecMinScore === 0.6 && posted.config.embeddingPreset === "bge-m3" && posted.config.rerankPreset === "bge-reranker-v2-m3");

	const afterResponse = response();
	await handleContextConfig(request("GET"), afterResponse);
	const after = JSON.parse(afterResponse.state.body);
	check("GET reads persisted settings", after.config.generateThreshold === 0.55 && after.config.halfLives.CONVENTIONS === 45);
	const merged = mergeContextConfig({ generateThreshold: 0.9, retainRounds: 20 });
	check("GET reads persisted model targets", after.config.summarizationModel === "gpt-5.6-luna" && after.config.summarizationReasoningEffort === "low" && after.config.dreamerModel === "claude-haiku-4-5");
	check("engine merge uses UI override", merged.generateThreshold === 0.55 && merged.retainRounds === 8 && merged.vecMinScore === 0.6 && merged.embeddingPreset === "bge-m3" && merged.rerankPreset === "bge-reranker-v2-m3");
	check("engine merge carries model targets", merged.summarizationProvider === "codelink" && merged.summarizationReasoningEffort === "low" && merged.dreamerProvider === "anthropic" && merged.dreamerReasoningEffort === "minimal");

	const invalidResponse = response();
	await handleContextConfig(request("POST", { ...after.config, retainRounds: 0 }), invalidResponse);
	check("POST rejects invalid settings", invalidResponse.state.status === 400 && JSON.parse(invalidResponse.state.body).ok === false);
} finally {
	if (savedHome === undefined) delete process.env.DSH_HOME;
	else process.env.DSH_HOME = savedHome;
	rmSync(home, { recursive: true, force: true });
}

if (failed > 0) {
	console.error(`${failed} assertion(s) failed`);
	process.exit(1);
}
console.log("dsh-context settings smoke: OK");

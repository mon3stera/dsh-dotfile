// Host-side Context Compact settings bridge.
// The engine remains agent-plane scoped; this companion owns one process-wide
// file-backed config route for the Web settings panel and future sessions.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import z from "@deepseek-ai/schemastery";
import { getContextUsage } from "./usage.js";
import {
	ensureLocalPreset,
	localPresetStatus,
	LOCAL_EMBEDDING_PRESETS,
	LOCAL_RERANK_PRESETS,
} from "./retrieval.js";

export const name = "dsh-magic-context-settings";

export const CONTEXT_SETTINGS_DEFAULTS = {
	thresholdRatio: 0.8,
	generateThreshold: 0.65,
	retainRounds: 20,
	waitReadyTimeoutMs: 60000,
	summarizationProvider: "",
	summarizationModel: "",
	alpha: 0.4,
	beta: 0.2,
	injectBudgetTokens: 4000,
	archiveThreshold: 0.15,
	halfLives: {
		ARCHITECTURE: null,
		CONSTRAINTS: null,
		ENVIRONMENT: null,
		CONVENTIONS: 30,
		PREFERENCES: 14,
	},
	embeddingPreset: "",
	rerankPreset: "",
	embeddingModel: "",
	embeddingBaseUrl: "",
	embeddingApiKeyEnv: "",
	embeddingDim: 1024,
	rerankModel: "",
	rerankBaseUrl: "",
	rerankApiKeyEnv: "",
	rerankTopN: 5,
	rerankInputTopK: 20,
	ftsTopK: 20,
	vecTopK: 20,
	vecMinScore: 0.35,
	rrfK: 60,
	dreamerIdleMinutes: 15,
	dreamerMaxRounds: 20,
	dreamerTimeoutMs: 600000,
	verifyIntervalDays: 30,
	compartmentBudgetTokens: 40000,
	dreamerProvider: "",
	dreamerModel: "",
};

const nullableDays = () => z.union([z.number().min(1), z.const(0), z.const(null)]).default(null);

export const ContextSettingsSchema = z.object({
	thresholdRatio: z.number().min(0.1).max(1).default(CONTEXT_SETTINGS_DEFAULTS.thresholdRatio),
	generateThreshold: z.number().min(0.1).max(1).default(CONTEXT_SETTINGS_DEFAULTS.generateThreshold),
	retainRounds: z.number().step(1).min(1).max(100).default(CONTEXT_SETTINGS_DEFAULTS.retainRounds),
	waitReadyTimeoutMs: z.number().step(1).min(0).max(600000).default(CONTEXT_SETTINGS_DEFAULTS.waitReadyTimeoutMs),
	summarizationProvider: z.string().default(""),
	summarizationModel: z.string().default(""),
	alpha: z.number().min(0).max(10).default(CONTEXT_SETTINGS_DEFAULTS.alpha),
	beta: z.number().min(0).max(10).default(CONTEXT_SETTINGS_DEFAULTS.beta),
	injectBudgetTokens: z.number().step(1).min(1).max(100000).default(CONTEXT_SETTINGS_DEFAULTS.injectBudgetTokens),
	archiveThreshold: z.number().min(0).max(10).default(CONTEXT_SETTINGS_DEFAULTS.archiveThreshold),
	halfLives: z.object({
		ARCHITECTURE: nullableDays(),
		CONSTRAINTS: nullableDays(),
		ENVIRONMENT: nullableDays(),
		CONVENTIONS: nullableDays().default(CONTEXT_SETTINGS_DEFAULTS.halfLives.CONVENTIONS),
		PREFERENCES: nullableDays().default(CONTEXT_SETTINGS_DEFAULTS.halfLives.PREFERENCES),
	}),
	embeddingPreset: z.union([z.const(""), z.const("bge-m3")]).default(CONTEXT_SETTINGS_DEFAULTS.embeddingPreset),
	rerankPreset: z.union([z.const(""), z.const("bge-reranker-v2-m3")]).default(CONTEXT_SETTINGS_DEFAULTS.rerankPreset),
	embeddingModel: z.string().default(""),
	embeddingBaseUrl: z.string().default(""),
	embeddingApiKeyEnv: z.string().default(""),
	embeddingDim: z.number().step(1).min(1).max(4096).default(CONTEXT_SETTINGS_DEFAULTS.embeddingDim),
	rerankModel: z.string().default(""),
	rerankBaseUrl: z.string().default(""),
	rerankApiKeyEnv: z.string().default(""),
	rerankTopN: z.number().step(1).min(1).max(100).default(CONTEXT_SETTINGS_DEFAULTS.rerankTopN),
	rerankInputTopK: z.number().step(1).min(1).max(1000).default(CONTEXT_SETTINGS_DEFAULTS.rerankInputTopK),
	ftsTopK: z.number().step(1).min(1).max(1000).default(CONTEXT_SETTINGS_DEFAULTS.ftsTopK),
	vecTopK: z.number().step(1).min(1).max(1000).default(CONTEXT_SETTINGS_DEFAULTS.vecTopK),
	vecMinScore: z.number().min(0).max(1).default(CONTEXT_SETTINGS_DEFAULTS.vecMinScore),
	rrfK: z.number().step(1).min(1).max(10000).default(CONTEXT_SETTINGS_DEFAULTS.rrfK),
	dreamerIdleMinutes: z.number().step(1).min(1).max(10080).default(CONTEXT_SETTINGS_DEFAULTS.dreamerIdleMinutes),
	dreamerMaxRounds: z.number().step(1).min(1).max(100).default(CONTEXT_SETTINGS_DEFAULTS.dreamerMaxRounds),
	dreamerTimeoutMs: z.number().step(1).min(1000).max(3600000).default(CONTEXT_SETTINGS_DEFAULTS.dreamerTimeoutMs),
	verifyIntervalDays: z.number().step(1).min(1).max(3650).default(CONTEXT_SETTINGS_DEFAULTS.verifyIntervalDays),
	compartmentBudgetTokens: z.number().step(1).min(1).max(1000000).default(CONTEXT_SETTINGS_DEFAULTS.compartmentBudgetTokens),
	dreamerProvider: z.string().default(""),
	dreamerModel: z.string().default(""),
});

export function configPath() {
	return join(resolveDshHome(), "magic-context", "settings.json");
}

function validate(value) {
	const result = ContextSettingsSchema["~standard"].validate(value);
	if (result.issues !== undefined) return undefined;
	const normalized = {
		...result.value,
		halfLives: { ...result.value.halfLives },
	};
	for (const category of ["ARCHITECTURE", "CONSTRAINTS", "ENVIRONMENT"]) {
		if (normalized.halfLives[category] === 0) normalized.halfLives[category] = null;
	}
	return normalized;
}

/** Read valid UI overrides; invalid or absent files fall back to composition config. */
export function readContextSettings() {
	try {
		const value = JSON.parse(readFileSync(configPath(), "utf8"));
		return validate(value) ?? {};
	} catch {
		return {};
	}
}

/** Merge file overrides over the preset composition before ContextEngine validates it. */
export function mergeContextConfig(config) {
	const overrides = readContextSettings();
	return {
		...config,
		...overrides,
		halfLives: {
			...(config.halfLives ?? {}),
			...(overrides.halfLives ?? {}),
		},
	};
}

function json(res, status, payload) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" });
	res.end(JSON.stringify(payload));
}

async function readBody(req, maxBytes) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > maxBytes) return null;
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

/** GET/POST /magic-context/config for the Web settings panel. */
export async function handleContextConfig(req, res) {
	if (req.method === "GET" || req.method === "HEAD") {
		const overrides = readContextSettings();
		json(res, 200, { ok: true, config: { ...CONTEXT_SETTINGS_DEFAULTS, ...overrides, halfLives: { ...CONTEXT_SETTINGS_DEFAULTS.halfLives, ...(overrides.halfLives ?? {}) } } });
		return;
	}
	if (req.method !== "POST") {
		res.writeHead(405);
		res.end();
		return;
	}
	const body = await readBody(req, 64 * 1024);
	if (body === null) {
		json(res, 413, { ok: false, error: "context settings too large" });
		return;
	}
	let candidate;
	try {
		candidate = JSON.parse(body.toString("utf8"));
	} catch {
		json(res, 400, { ok: false, error: "invalid JSON" });
		return;
	}
	const value = validate(candidate);
	if (value === undefined) {
		json(res, 400, { ok: false, error: "invalid context settings" });
		return;
	}
	const directory = join(resolveDshHome(), "magic-context");
	mkdirSync(directory, { recursive: true });
	const target = configPath();
	const temporary = `${target}.tmp`;
	writeFileSync(temporary, JSON.stringify(value, null, 2));
	renameSync(temporary, target);
	json(res, 200, { ok: true, config: value });
}

/** GET /magic-context/usage?sessionId=... for the composer context detail row. */
export async function handleContextUsage(req, res) {
	if (req.method !== "GET" && req.method !== "HEAD") {
		res.writeHead(405);
		res.end();
		return;
	}
	const url = new URL(req.url ?? "/magic-context/usage", "http://127.0.0.1");
	const sessionId = url.searchParams.get("sessionId");
	if (typeof sessionId !== "string" || sessionId.length === 0) {
		json(res, 400, { ok: false, error: "sessionId is required" });
		return;
	}
	const usage = getContextUsage(sessionId);
	json(res, 200, { ok: true, sessionId, ...usage });
}

/** GET /magic-context/models/status and POST /magic-context/models/ensure for local presets. */
export async function handleContextModels(req, res) {
	const url = new URL(req.url ?? "/magic-context/models/status", "http://127.0.0.1");
	const kind = url.searchParams.get("kind") ?? "embedding";
	const preset = url.searchParams.get("preset") ?? (kind === "rerank" ? "bge-reranker-v2-m3" : "bge-m3");
	const presets = kind === "embedding" ? LOCAL_EMBEDDING_PRESETS : kind === "rerank" ? LOCAL_RERANK_PRESETS : undefined;
	if (presets?.[preset] === undefined) {
		json(res, 400, { ok: false, error: `unknown local ${kind} preset: ${preset}` });
		return;
	}
	if (req.method === "GET" || req.method === "HEAD") {
		json(res, 200, { ok: true, ...localPresetStatus(kind, preset) });
		return;
	}
	if (req.method !== "POST") {
		res.writeHead(405);
		res.end();
		return;
	}
	void ensureLocalPreset(kind, preset).catch(() => {});
	json(res, 202, { ok: true, ...localPresetStatus(kind, preset) });
}

export function apply(ctx) {
	ctx.inject(["webServer"], (httpCtx) => {
		httpCtx.effect(() => httpCtx.webServer.register({ kind: "exact", path: "/magic-context/config", handler: handleContextConfig }), "dsh-magic-context-settings: config route");
		httpCtx.effect(() => httpCtx.webServer.register({ kind: "exact", path: "/magic-context/usage", handler: handleContextUsage }), "dsh-magic-context-settings: usage route");
		httpCtx.effect(() => httpCtx.webServer.register({ kind: "exact", path: "/magic-context/models/status", handler: handleContextModels }), "dsh-magic-context-settings: model status route");
		httpCtx.effect(() => httpCtx.webServer.register({ kind: "exact", path: "/magic-context/models/ensure", handler: handleContextModels }), "dsh-magic-context-settings: model ensure route");
	});
}

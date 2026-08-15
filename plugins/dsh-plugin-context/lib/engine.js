// ContextEngine: the async compartment compaction backend.
//
// Subclasses BasicCompactionEngine for the token meter, /compact integration,
// and overflow recovery plumbing, but replaces the trigger policy entirely
// (auto: false) and the landing path (fixed generation-time spans with
// selected-span stability instead of whole-surface freezes).
import z from "@deepseek-ai/schemastery";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import { ManualCompactionError } from "@deepseek-ai/dsh-compaction";
import { CONTEXT_WINDOW_EXCEEDED_CODE } from "@deepseek-ai/dsh-llm";
import { openDatabase } from "./db.js";
import { selectCompartmentRange } from "./range.js";
import { landCompartment } from "./landing.js";
import { summarizeCompartment } from "./summarizer.js";
import { createParagraphAssigner, installParagraphInjector, PARAGRAPH_SECTION } from "./paragraphs.js";
import { createReduceTool } from "./tools.js";
import {
	DEFAULT_MEMORY_CONFIG,
	MEMORY_SECTION,
	createMemoryTool,
	createSearchTool,
	recordInjectionHit,
	renderInjectionText,
	selectInjectionMemories,
} from "./memory.js";
import { EmbeddingClient, RerankClient } from "./retrieval.js";

const DEFAULT_GENERATE_THRESHOLD = 0.65;
const DEFAULT_RETAIN_ROUNDS = 20;
const DEFAULT_WAIT_READY_TIMEOUT_MS = 60000;

/** Keys ContextEngine owns; everything else goes to the basic engine config. */
const OWN_KEYS = new Set([
	"generateThreshold",
	"retainRounds",
	"waitReadyTimeoutMs",
	"alpha",
	"beta",
	"injectBudgetTokens",
	"archiveThreshold",
	"halfLives",
	"embeddingModel",
	"embeddingBaseUrl",
	"embeddingApiKeyEnv",
	"embeddingDim",
	"rerankModel",
	"rerankBaseUrl",
	"rerankApiKeyEnv",
	"rerankTopN",
	"rerankInputTopK",
	"ftsTopK",
	"vecTopK",
	"rrfK",
]);

/** Resolve the exact provider/model durably routed for the latest request. */
function routedTarget(session) {
	const config = session.requestHeader()?.config;
	if (config === undefined || config.provider.length === 0 || config.model.length === 0) return undefined;
	return { provider: config.provider, model: config.model };
}

function delay(ms, signal) {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		if (signal !== undefined) signal.addEventListener("abort", () => {
			clearTimeout(timer);
			resolve();
		}, { once: true });
	});
}

export class ContextEngine extends BasicCompactionEngine {
	static inject = ["llm", "tokenMeter", "sessions", "systemPrompt", "tools"];
	static Config = z.object({
		thresholdRatio: z.number(),
		retainRatio: z.number(),
		retainTokens: z.number().step(1).min(0),
		summarizationProvider: z.string(),
		summarizationModel: z.string(),
		maxTokens: z.number().step(1).min(1),
		compactionRetries: z.number().step(1).min(0),
		maxOverflowRetries: z.number().step(1).min(0),
		modelPolicies: z.array(z.object({
			provider: z.string().required(),
			model: z.string().required(),
			thresholdRatio: z.number(),
			retainRatio: z.number(),
			retainTokens: z.number().step(1).min(0),
			summarizationProvider: z.string(),
			summarizationModel: z.string(),
			maxTokens: z.number().step(1).min(1),
			compactionRetries: z.number().step(1).min(0),
			maxOverflowRetries: z.number().step(1).min(0),
		})),
		auto: z.boolean(),
		generateThreshold: z.number(),
		retainRounds: z.number().step(1).min(1),
		waitReadyTimeoutMs: z.number().step(1).min(0),
		alpha: z.number(),
		beta: z.number(),
		injectBudgetTokens: z.number().step(1).min(1),
		archiveThreshold: z.number(),
		halfLives: z.object({
			ARCHITECTURE: z.number(),
			CONSTRAINTS: z.number(),
			ENVIRONMENT: z.number(),
			CONVENTIONS: z.number(),
			PREFERENCES: z.number(),
		}),
		embeddingModel: z.string(),
		embeddingBaseUrl: z.string(),
		embeddingApiKeyEnv: z.string(),
		embeddingDim: z.number().step(1).min(1),
		rerankModel: z.string(),
		rerankBaseUrl: z.string(),
		rerankApiKeyEnv: z.string(),
		rerankTopN: z.number().step(1).min(1),
		rerankInputTopK: z.number().step(1).min(1),
		ftsTopK: z.number().step(1).min(1),
		vecTopK: z.number().step(1).min(1),
		rrfK: z.number().step(1).min(1),
	});

	cdb;
	ownConfig;
	agentBySession = new WeakMap();
	inFlight = new Map(); // sessionId -> Promise
	overflowRetries = new WeakMap();
	injection = new WeakMap(); // session -> { text }

	constructor(ctx, config = {}) {
		const own = {};
		for (const key of OWN_KEYS) {
			if (config[key] !== undefined) own[key] = config[key];
		}
		const basicConfig = { ...config };
		for (const key of OWN_KEYS) delete basicConfig[key];
		super(ctx, { ...basicConfig, auto: false });
		this.ownConfig = {
			generateThreshold: own.generateThreshold ?? DEFAULT_GENERATE_THRESHOLD,
			retainRounds: own.retainRounds ?? DEFAULT_RETAIN_ROUNDS,
			waitReadyTimeoutMs: own.waitReadyTimeoutMs ?? DEFAULT_WAIT_READY_TIMEOUT_MS,
			memoryConfig: {
				alpha: own.alpha ?? DEFAULT_MEMORY_CONFIG.alpha,
				beta: own.beta ?? DEFAULT_MEMORY_CONFIG.beta,
				injectBudgetTokens: own.injectBudgetTokens ?? DEFAULT_MEMORY_CONFIG.injectBudgetTokens,
				archiveThreshold: own.archiveThreshold ?? DEFAULT_MEMORY_CONFIG.archiveThreshold,
				halfLives: { ...DEFAULT_MEMORY_CONFIG.halfLives, ...(own.halfLives ?? {}) },
			},
			retrievalConfig: {
				ftsTopK: own.ftsTopK ?? 20,
				vecTopK: own.vecTopK ?? 20,
				rrfK: own.rrfK ?? 60,
				rerankTopN: own.rerankTopN ?? 5,
				rerankInputTopK: own.rerankInputTopK ?? 20,
				embedding: typeof own.embeddingModel === "string" && own.embeddingModel.length > 0 && typeof own.embeddingBaseUrl === "string" && own.embeddingBaseUrl.length > 0
					? new EmbeddingClient({
						baseUrl: own.embeddingBaseUrl,
						model: own.embeddingModel,
						...(typeof own.embeddingApiKeyEnv === "string" && own.embeddingApiKeyEnv.length > 0
							? { apiKey: process.env[own.embeddingApiKeyEnv] }
							: {}),
					})
					: undefined,
				rerank: typeof own.rerankModel === "string" && own.rerankModel.length > 0 && typeof own.rerankBaseUrl === "string" && own.rerankBaseUrl.length > 0
					? new RerankClient({
						baseUrl: own.rerankBaseUrl,
						model: own.rerankModel,
						...(typeof own.rerankApiKeyEnv === "string" && own.rerankApiKeyEnv.length > 0
							? { apiKey: process.env[own.rerankApiKeyEnv] }
							: {}),
					})
					: undefined,
			},
		};
		this.cdb = openDatabase(resolveDshHome());
		ctx.effect(() => () => this.cdb.close(), "dsh-plugin-context db");
		this._installParagraphSystem(ctx);
		this._installMemorySystem(ctx);
		this._registerTriggers(ctx);
	}

	/** Paragraph numbering (Phase 2) mounts on the engine's context. */
	_installParagraphSystem(ctx) {
		ctx.on("session/event", createParagraphAssigner(this.cdb));
		const wrapped = new WeakSet();
		ctx.on("agent/session-start", ({ agent }) => {
			this.agentBySession.set(agent.session, agent);
			const session = agent.session;
			if (wrapped.has(session)) return;
			wrapped.add(session);
			this.refreshInjection(session); // new conversation: inject memories
			installParagraphInjector(session, this.cdb, {
				extraMessage: () => {
					const inj = this.injection.get(session);
					if (inj === undefined || inj.text.length === 0) return null;
					return { role: "user", content: [{ type: "text", text: inj.text }] };
				},
			});
		});
		ctx.systemPrompt.section(PARAGRAPH_SECTION);
		ctx.tools.register(createReduceTool(this.cdb));
	}

	/** project_memory (Phase 5): tools, prompt section, injection refresh. */
	_installMemorySystem(ctx) {
		ctx.tools.register(createMemoryTool(this.cdb, this.ownConfig.retrievalConfig));
		ctx.tools.register(createSearchTool(this.cdb, this.ownConfig.memoryConfig, this.ownConfig.retrievalConfig));
		ctx.systemPrompt.section(MEMORY_SECTION);
	}

	/** Re-select and cache the <project_memory> injection block for one session. */
	refreshInjection(session) {
		const selected = selectInjectionMemories(this.cdb, this.ownConfig.memoryConfig);
		const text = renderInjectionText(selected);
		for (const memory of selected) recordInjectionHit(this.cdb, memory, this.ownConfig.memoryConfig);
		this.injection.set(session, { text });
		return text;
	}

	_registerTriggers(ctx) {
		// 65%: kick off the background organizer at step/turn boundaries.
		ctx.on("session/event", (session, event) => {
			if (event.type !== "step/end" && event.type !== "turn/end") return;
			const agent = this.agentBySession.get(session);
			if (agent === undefined) return;
			this.maybeGenerate(agent).catch((error) => {
				ctx.logger.warn(`compartment generation failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		});
		// 80%: land a ready compartment before the next step.
		ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
			if (!signal.aborted) {
				try {
					await this.maybeLand(agent, signal);
				} catch (error) {
					ctx.logger.warn(`compartment landing failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			return next();
		});
		// Overflow recovery: provider-confirmed context overflow forces a landing.
		ctx.on("agent/status", ({ agent, status }) => {
			if (status === "idle") this.overflowRetries.delete(agent);
		});
		ctx.on("agent/request-error", async ({ agent, failure, signal }, next) => {
			if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next();
			const target = routedTarget(agent.session);
			if (target === undefined) return next();
			const retries = this.overflowRetries.get(agent) ?? 0;
			if (retries >= this.config.maxOverflowRetries) return next();
			const generation = agent.session.surface.replaceGeneration;
			try {
				await this.forceCompact(agent, signal);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (!signal.aborted && agent.session.surface.replaceGeneration > generation) {
					ctx.logger.warn(`context-overflow landing failed after durable surface progress: ${message}; retrying from the replacement surface`);
					this.overflowRetries.set(agent, retries + 1);
					return { kind: "retry" };
				}
				ctx.logger.warn(`context-overflow landing failed: ${message}; preserving the original request error`);
				return next();
			}
			if (signal.aborted || agent.session.surface.replaceGeneration <= generation) return next();
			this.overflowRetries.set(agent, retries + 1);
			return { kind: "retry" };
		});
	}

	/** Resolve the routed context window, or undefined when unknowable. */
	async _contextWindow(agent) {
		const target = routedTarget(agent.session);
		if (target === undefined) return undefined;
		const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model);
		return info.context?.contextWindow;
	}

	/** 65% trigger: start the background organizer for a new generation. */
	async maybeGenerate(agent) {
		const session = agent.session;
		const id = session.id;
		if (this.inFlight.has(id)) return;
		if (this.cdb.readyCompartments(id).length > 0) return;
		const contextWindow = await this._contextWindow(agent);
		if (contextWindow === undefined) return;
		const measurement = this.ctx.tokenMeter.measure(session);
		if (measurement.totalTokens < this.ownConfig.generateThreshold * contextWindow) return;
		const range = selectCompartmentRange(session, { retainRounds: this.ownConfig.retainRounds });
		if (range === null) return;
		const shadowedTokens = measurement.nodes.slice(range.startIdx, range.endIdx + 1)
			.reduce((total, node) => total + node.tokens, 0);
		const generation = this.cdb.activeCompartments(id).length + 1;
		const compartmentId = this.cdb.insertCompartment({
			sessionId: id,
			generation,
			startSeq: range.start,
			endSeq: range.end,
			startPara: this.cdb.paragraphFor(id, range.start),
			endPara: this.cdb.paragraphFor(id, range.end),
			summary: "",
			shadowedTokens,
		});
		const promise = summarizeCompartment(this.ctx, this.cdb, {
			session,
			compartment: this.cdb.compartmentById(compartmentId),
			range,
		})
			.catch((error) => {
				this.cdb.setCompartmentStatus(compartmentId, "failed");
				throw error;
			})
			.finally(() => {
				this.inFlight.delete(id);
			});
		this.inFlight.set(id, promise);
	}

	/** 80% trigger: land the oldest ready compartment (wait briefly if generating). */
	async maybeLand(agent, signal) {
		const session = agent.session;
		const contextWindow = await this._contextWindow(agent);
		if (contextWindow === undefined) return;
		const measurement = this.ctx.tokenMeter.measure(session);
		if (measurement.totalTokens < this.config.thresholdRatio * contextWindow) return;
		let ready = this.cdb.readyCompartments(session.id);
		if (ready.length === 0) {
			const inFlight = this.inFlight.get(session.id);
			if (inFlight === undefined) return;
			await Promise.race([inFlight, delay(this.ownConfig.waitReadyTimeoutMs, signal)]);
			ready = this.cdb.readyCompartments(session.id);
			if (ready.length === 0) return; // still not ready: skip this landing round
		}
		await this.land(agent, ready[0], signal);
	}

	/** One landing (automatic owner). */
	async land(agent, compartment, signal) {
		await landCompartment(
			{ session: agent.session, cdb: this.cdb, meter: this.ctx.tokenMeter, agent },
			compartment,
			{ owner: "current-turn", signal },
		);
		this.refreshInjection(agent.session); // landing: re-select memories
	}

	/** Overflow / manual fallback: land a ready compartment or generate synchronously. */
	async forceCompact(agent, signal) {
		const session = agent.session;
		let ready = this.cdb.readyCompartments(session.id);
		if (ready.length === 0) {
			const range = selectCompartmentRange(session, { retainRounds: this.ownConfig.retainRounds });
			if (range === null) return null;
			const measurement = this.ctx.tokenMeter.measure(session);
			const shadowedTokens = measurement.nodes.slice(range.startIdx, range.endIdx + 1)
				.reduce((total, node) => total + node.tokens, 0);
			const generation = this.cdb.activeCompartments(session.id).length + 1;
			const compartmentId = this.cdb.insertCompartment({
				sessionId: session.id,
				generation,
				startSeq: range.start,
				endSeq: range.end,
				startPara: this.cdb.paragraphFor(session.id, range.start),
				endPara: this.cdb.paragraphFor(session.id, range.end),
				summary: "",
				shadowedTokens,
			});
			await summarizeCompartment(this.ctx, this.cdb, {
				session,
				compartment: this.cdb.compartmentById(compartmentId),
				range,
			});
			ready = this.cdb.readyCompartments(session.id);
			if (ready.length === 0) return null;
		}
		return this.land(agent, ready[0], signal);
	}

	/** Manual `/compact`: land a ready compartment, or generate synchronously. */
	async compactNow(agent, signal, sourceCommandId) {
		signal.throwIfAborted();
		try {
			return await agent.runMaintenance(async (agentSignal) => {
				const operationSignal = AbortSignal.any([agentSignal, signal]);
				operationSignal.throwIfAborted();
				let ready = this.cdb.readyCompartments(agent.session.id);
				let compartment;
				if (ready.length > 0) {
					compartment = ready[0];
				} else {
					const range = selectCompartmentRange(agent.session, { retainRounds: this.ownConfig.retainRounds });
					if (range === null) return null;
					const measurement = this.ctx.tokenMeter.measure(agent.session);
					const shadowedTokens = measurement.nodes.slice(range.startIdx, range.endIdx + 1)
						.reduce((total, node) => total + node.tokens, 0);
					const generation = this.cdb.activeCompartments(agent.session.id).length + 1;
					const compartmentId = this.cdb.insertCompartment({
						sessionId: agent.session.id,
						generation,
						startSeq: range.start,
						endSeq: range.end,
						startPara: this.cdb.paragraphFor(agent.session.id, range.start),
						endPara: this.cdb.paragraphFor(agent.session.id, range.end),
						summary: "",
						shadowedTokens,
					});
					await summarizeCompartment(this.ctx, this.cdb, {
						session: agent.session,
						compartment: this.cdb.compartmentById(compartmentId),
						range,
					});
					ready = this.cdb.readyCompartments(agent.session.id);
					if (ready.length === 0) return null;
					compartment = ready[0];
				}
				return await landCompartment(
					{ session: agent.session, cdb: this.cdb, meter: this.ctx.tokenMeter, agent },
					compartment,
					{
						owner: null,
						sourceCommandId,
						signal: operationSignal,
						flush: async () => {
							await this.ctx.sessions.flush(agent.session);
						},
					},
				);
			});
		} catch (error) {
			if (error instanceof ManualCompactionError) throw error;
			throw new ManualCompactionError("busy", "manual compaction requires an idle agent with no waking queued work", { cause: error });
		}
	}
}

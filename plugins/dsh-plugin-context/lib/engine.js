// ContextEngine: the async compartment compaction backend.
//
// Subclasses BasicCompactionEngine for the token meter, /compact integration,
// and overflow recovery plumbing, but replaces the trigger policy entirely
// (auto: false) and the landing path (fixed generation-time spans with
// selected-span stability instead of whole-surface freezes).
import z from "@deepseek-ai/schemastery";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import { isCompactCheckpointSource, ManualCompactionError } from "@deepseek-ai/dsh-compaction";
import { CONTEXT_WINDOW_EXCEEDED_CODE, createUserMessage } from "@deepseek-ai/dsh-llm";
import { openDatabase } from "./db.js";
import { selectCompartmentRange, selectManualCompartmentRange } from "./range.js";
import { estimateFramedSummaryTokens, landCompartment } from "./landing.js";
import { summarizeCompartment } from "./summarizer.js";
import { createParagraphAssigner, installParagraphInjector, PARAGRAPH_SECTION } from "./paragraphs.js";
import { createExpandTool, createReduceTool } from "./tools.js";
import { CONTEXT_TOOL_GUIDANCE } from "./context-tool-guidance.js";
import {
	DEFAULT_MEMORY_CONFIG,
	MEMORY_SECTION,
	createMemoryTool,
	createSearchTool,
	estimateTokens,
	recordInjectionHit,
	renderInjectionText,
	selectInjectionMemories,
} from "./memory.js";
import {
	EmbeddingClient,
	LocalEmbeddingClient,
	LocalRerankClient,
	LOCAL_EMBEDDING_PRESETS,
	LOCAL_RERANK_PRESETS,
	RerankClient,
} from "./retrieval.js";
import { buildDreamerBrief, runArchival, runDreamer, summarizeDreamerActions } from "./dreamer.js";
import { injectContextNotice } from "./notifications.js";
import { mergeContextConfig } from "./settings.js";
import { clearContextUsage, setContextUsage } from "./usage.js";
import { sessionMemoryScope } from "./scope.js";
import { installContextCommands } from "./commands.js";

const DEFAULT_GENERATE_THRESHOLD = 0.65;
const DEFAULT_RETAIN_ROUNDS = 20;
const DEFAULT_WAIT_READY_TIMEOUT_MS = 60000;
const DEFAULT_DREAMER_IDLE_MINUTES = 15;
const DEFAULT_DREAMER_MAX_ROUNDS = 20;
const DEFAULT_DREAMER_TIMEOUT_MS = 600000;
const DEFAULT_VERIFY_INTERVAL_DAYS = 30;
const DEFAULT_COMPARTMENT_BUDGET_TOKENS = 40000;

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
	"embeddingPreset",
	"rerankPreset",
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
	"vecMinScore",
	"rrfK",
	"dreamerIdleMinutes",
	"dreamerMaxRounds",
	"dreamerTimeoutMs",
	"verifyIntervalDays",
	"compartmentBudgetTokens",
	"dreamerProvider",
	"dreamerModel",
]);

/** Resolve the exact provider/model durably routed for the latest request. */
function routedTarget(session) {
	const config = session.requestHeader()?.config;
	if (typeof config?.provider !== "string" || config.provider.length === 0
		|| typeof config.model !== "string" || config.model.length === 0) return undefined;
	return { provider: config.provider, model: config.model };
}

function delay(ms, signal) {	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		if (signal !== undefined) signal.addEventListener("abort", () => {
			clearTimeout(timer);
			resolve();
		}, { once: true });
	});
}

function waitForSignal(promise, signal) {
	if (signal === undefined) return promise;
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		const onAbort = () => {
			cleanup();
			reject(signal.reason ?? new Error("operation aborted"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then((value) => {
			cleanup();
			resolve(value);
		}, (error) => {
			cleanup();
			reject(error);
		});
	});
}

/** Join the text blocks of one message content value. */
function extractText(content) {
	if (!Array.isArray(content)) return "";
	return content.filter((block) => block?.type === "text").map((block) => block.text ?? "").join("\n");
}

export class ContextEngine extends BasicCompactionEngine {
	static inject = ["llm", "tokenMeter", "sessions", "systemPrompt", "tools", "commands"];
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
		embeddingPreset: z.string(),
		rerankPreset: z.string(),
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
		vecMinScore: z.number().min(0).max(1),
		rrfK: z.number().step(1).min(1),
		dreamerIdleMinutes: z.number().step(1).min(1),
		dreamerMaxRounds: z.number().step(1).min(1),
		dreamerTimeoutMs: z.number().step(1).min(1000),
		verifyIntervalDays: z.number().step(1).min(1),
		compartmentBudgetTokens: z.number().step(1).min(1),
		dreamerProvider: z.string(),
		dreamerModel: z.string(),
	});

	cdb;
	ownConfig;
	agentBySession = new WeakMap();
	inFlight = new Map(); // sessionId -> Promise
	overflowRetries = new WeakMap();
	injection = new WeakMap(); // session -> { text, consumed }
	idleTimers = new Map(); // session -> timer
	dreamerBusy = false;
	dreamerRounds = new WeakMap(); // session -> { interactionRound, triggeredRound }

	constructor(ctx, config = {}) {
		const configured = mergeContextConfig(config);
		const own = {};
		for (const key of OWN_KEYS) {
			if (configured[key] !== undefined) own[key] = configured[key];
		}
		const basicConfig = { ...configured };
		for (const key of OWN_KEYS) delete basicConfig[key];
		super(ctx, { ...basicConfig, auto: false });
		const embeddingPreset = LOCAL_EMBEDDING_PRESETS[configured.embeddingPreset];
		const rerankPreset = LOCAL_RERANK_PRESETS[configured.rerankPreset];
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
				vecMinScore: own.vecMinScore ?? 0.35,
				rrfK: own.rrfK ?? 60,
				rerankTopN: own.rerankTopN ?? 5,
				rerankInputTopK: own.rerankInputTopK ?? 20,
				embedding: embeddingPreset !== undefined
					? new LocalEmbeddingClient({ preset: embeddingPreset.id })
					: typeof own.embeddingModel === "string" && own.embeddingModel.length > 0 && typeof own.embeddingBaseUrl === "string" && own.embeddingBaseUrl.length > 0
						? new EmbeddingClient({
							baseUrl: own.embeddingBaseUrl,
							model: own.embeddingModel,
							...(typeof own.embeddingApiKeyEnv === "string" && own.embeddingApiKeyEnv.length > 0
								? { apiKey: process.env[own.embeddingApiKeyEnv] }
								: {}),
						})
						: undefined,
				rerank: rerankPreset !== undefined
					? new LocalRerankClient({ preset: rerankPreset.id })
					: typeof own.rerankModel === "string" && own.rerankModel.length > 0 && typeof own.rerankBaseUrl === "string" && own.rerankBaseUrl.length > 0
						? new RerankClient({
							baseUrl: own.rerankBaseUrl,
							model: own.rerankModel,
							...(typeof own.rerankApiKeyEnv === "string" && own.rerankApiKeyEnv.length > 0
								? { apiKey: process.env[own.rerankApiKeyEnv] }
								: {}),
						})
						: undefined,
			},
			dreamerConfig: {
				idleMinutes: own.dreamerIdleMinutes ?? DEFAULT_DREAMER_IDLE_MINUTES,
				maxRounds: own.dreamerMaxRounds ?? DEFAULT_DREAMER_MAX_ROUNDS,
				timeoutMs: own.dreamerTimeoutMs ?? DEFAULT_DREAMER_TIMEOUT_MS,
				verifyIntervalDays: own.verifyIntervalDays ?? DEFAULT_VERIFY_INTERVAL_DAYS,
				compartmentBudgetTokens: own.compartmentBudgetTokens ?? DEFAULT_COMPARTMENT_BUDGET_TOKENS,
				provider: own.dreamerProvider ?? "",
				model: own.dreamerModel ?? "",
			},
		};
		this.cdb = openDatabase(resolveDshHome(), { embeddingDim: embeddingPreset?.embeddingDim ?? own.embeddingDim });
		ctx.effect(() => () => {
			for (const timer of this.idleTimers.values()) clearTimeout(timer);
			this.idleTimers.clear();
			this.cdb.close();
		}, "dsh-plugin-context db");
		installContextCommands(ctx, {
			cdb: this.cdb,
			memoryConfig: this.ownConfig.memoryConfig,
			retrieval: this.ownConfig.retrievalConfig,
			resolveScope: (session) => sessionMemoryScope(session),
			runDreamer: (agent) => this._runDreamerForAgent(agent),
		});
		this._installParagraphSystem(ctx);
		this._installMemorySystem(ctx);
		this._registerTriggers(ctx);
	}

	/** Paragraph numbering (Phase 2) mounts on the engine's context. */
	_installParagraphSystem(ctx) {
		const assignParagraph = createParagraphAssigner(this.cdb);
		ctx.on("session/event", assignParagraph);
		const wrapped = new WeakSet();
		ctx.on("session/event", (session, event) => {
			if (event.type !== "step/end") return;
			const injection = this.injection.get(session);
			if (injection !== undefined) injection.consumed = true;
			this._refreshContextUsage(session);
		});
		ctx.on("session/event", (session, event) => {
			if (event.surfaceOp !== undefined) this._refreshContextUsage(session);
		});
		ctx.on("agent/session-start", ({ agent }) => {
			this.agentBySession.set(agent.session, agent);
			const session = agent.session;
			if (wrapped.has(session)) return;
			wrapped.add(session);
			for (const event of session.events) assignParagraph(session, event);
			const resumed = session.events.some((event) => event.type === "step/end");
			this.refreshInjection(session, { consumed: resumed });
			this._refreshContextUsage(session);
			installParagraphInjector(session, this.cdb, {
				extraMessage: () => {
					const inj = this.injection.get(session);
					if (inj === undefined || inj.consumed || inj.text.length === 0) return null;
					return { role: "user", content: [{ type: "text", text: inj.text }] };
				},
			});
		});
		ctx.systemPrompt.section(PARAGRAPH_SECTION);
		ctx.tools.register(createReduceTool(this.cdb));
		ctx.tools.register(createExpandTool(this.cdb));
	}

	/** project_memory (Phase 5): tools, prompt section, injection refresh. */
	_installMemorySystem(ctx) {
		const resolveScope = (session) => sessionMemoryScope(session);
		ctx.tools.register(createMemoryTool(this.cdb, this.ownConfig.retrievalConfig, { resolveScope }));
		ctx.tools.register(createSearchTool(this.cdb, this.ownConfig.memoryConfig, this.ownConfig.retrievalConfig, { resolveScope }));
		ctx.systemPrompt.section(MEMORY_SECTION);
		ctx.systemPrompt.section(CONTEXT_TOOL_GUIDANCE);
	}

	/** Re-select and cache the <project_memory> injection block for one session. */
	refreshInjection(session, { consumed = false } = {}) {
		const selected = selectInjectionMemories(this.cdb, this.ownConfig.memoryConfig, Date.now(), sessionMemoryScope(session));
		const text = renderInjectionText(selected);
		for (const memory of selected) recordInjectionHit(this.cdb, memory, this.ownConfig.memoryConfig);
		const memoryTokens = text.length === 0
			? 0
			: typeof this.ctx.tokenMeter.estimateMessage === "function"
				? this.ctx.tokenMeter.estimateMessage(createUserMessage({ content: [{ type: "text", text }] }))
				: estimateTokens(text);
		this.injection.set(session, { text, consumed, memoryCount: selected.length, memoryTokens });
		this._refreshContextUsage(session);
		if (selected.length > 0) {
			this._notify(
				this.agentBySession.get(session),
				`Inject Memory: ${selected.length} project memor${selected.length === 1 ? "y" : "ies"}`,
				`Injected ${selected.length} project memor${selected.length === 1 ? "y" : "ies"} into the next model request.`,
			);
		}
		return text;
	}

	/** Publish only checkpoint and initial-injection tokens present in the current window. */
	_refreshContextUsage(session) {
		const injection = this.injection.get(session);
		if (typeof this.ctx.tokenMeter.measure !== "function" || !Array.isArray(session?.surface?.nodes)) {
			setContextUsage(session?.id, { memories: { count: injection?.memoryCount ?? 0, tokens: injection?.memoryTokens ?? 0, consumed: injection?.consumed !== false } });
			return;
		}
		const measurement = this.ctx.tokenMeter.measure(session);
		const tokensBySeq = new Map((measurement.nodes ?? []).map((node) => [node.seq, node.tokens]));
		let compartmentCount = 0;
		let compartmentTokens = 0;
		for (const [index, seq] of session.surface.nodes.entries()) {
			const event = session.events[seq];
			if (event?.type !== "user/message" || event.data?.source === undefined || !isCompactCheckpointSource(event.data.source)) continue;
			compartmentCount += 1;
			compartmentTokens += tokensBySeq.get(seq) ?? measurement.nodes?.[index]?.tokens ?? 0;
		}
		setContextUsage(session.id, {
			compartments: { count: compartmentCount, tokens: compartmentTokens },
			memories: { count: injection?.memoryCount ?? 0, tokens: injection?.memoryTokens ?? 0, consumed: injection?.consumed !== false },
		});
	}

	/** Keep secondary UI notices from changing the compaction outcome. */
	_notify(agent, summary, text) {
		try {
			injectContextNotice(agent, summary, text);
		} catch (error) {
			this.ctx.logger.warn(`context UI notice failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** Announce one checkpoint entering the model-visible surface. */
	_announceCompartment(agent, compartment, result) {
		this._notify(
			agent,
			`Inject Compartments: generation ${compartment.generation}`,
			[
				`Injected compartment generation ${compartment.generation} into the conversation surface.`,
				`Covered paragraphs: ${compartment.start_para}-${compartment.end_para}.`,
				`Replaced ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens).`,
			].join("\n"),
		);
	}

	_clearIdleTimer(session) {
		const timer = this.idleTimers.get(session);
		if (timer === undefined) return;
		clearTimeout(timer);
		this.idleTimers.delete(session);
	}

	_dreamerRoundState(session) {
		let state = this.dreamerRounds.get(session);
		if (state === undefined) {
			state = { interactionRound: 0, triggeredRound: -1 };
			this.dreamerRounds.set(session, state);
		}
		return state;
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
		// Dreamer idle trigger: reset the timer for activity, but only allow one
		// run per interaction round. Dreamer notices and other background events
		// must not create a fresh idle run without a new turn/start.
		ctx.on("session/event", (session, event) => {
			const state = this._dreamerRoundState(session);
			if (event?.type === "turn/start") state.interactionRound += 1;
			else if (state.interactionRound === 0) state.interactionRound = 1;
			this._clearIdleTimer(session);
			if (state.triggeredRound >= state.interactionRound) return;
			const interactionRound = state.interactionRound;
			const timer = setTimeout(() => {
				this.idleTimers.delete(session);
				const current = this.dreamerRounds.get(session);
				if (current === undefined || current.interactionRound !== interactionRound || current.triggeredRound >= interactionRound) return;
				const agent = this.agentBySession.get(session);
				if (agent === undefined) return;
				current.triggeredRound = interactionRound;
				this._runDreamerForAgent(agent).catch((error) => {
					ctx.logger.warn(`dreamer run failed: ${error instanceof Error ? error.message : String(error)}`);
				});
			}, this.ownConfig.dreamerConfig.idleMinutes * 60 * 1000);
			this.idleTimers.set(session, timer);
		});
		ctx.on("session/disposed", (session) => {
			this._clearIdleTimer(session);
			this.dreamerRounds.delete(session);
			clearContextUsage(session?.id);
		});
		// 80%: land a ready compartment before the next step.
		ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
			if (!signal.aborted) {
				try {
					await this._removeArchivedCheckpoints(agent);
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

	/** Remove ready rows whose stored checkpoint can never shrink its source span. */
	_readyCompartments(sessionId) {
		const ready = this.cdb.readyCompartments(sessionId);
		return ready.filter((compartment) => {
			const shadowedTokens = Number(compartment.shadowed_tokens);
			if (!Number.isFinite(shadowedTokens) || shadowedTokens <= 0) return true;
			const framedTokens = estimateFramedSummaryTokens(this.ctx.tokenMeter, compartment.summary);
			if (framedTokens < shadowedTokens) return true;
			this.cdb.setCompartmentStatus(compartment.id, "failed");
			this.ctx.logger.warn(`compartment ${compartment.id} is not shrinkable: ${framedTokens} framed tokens >= ${shadowedTokens} source tokens`);
			return false;
		});
	}

	/** Create one fixed-range compartment and finish its summary lifecycle. */
	async _createAndSummarize(agent, range, shadowedTokens) {
		const session = agent.session;
		const id = session.id;
		const minimumFramedTokens = estimateFramedSummaryTokens(this.ctx.tokenMeter, "");
		if (shadowedTokens <= minimumFramedTokens) {
			this.ctx.logger.warn(`compartment generation skipped: ${shadowedTokens} source tokens cannot fit the ${minimumFramedTokens}-token checkpoint framing`);
			return null;
		}
		const generation = this.cdb.maxGeneration(id) + 1;
		const compartmentId = this.cdb.insertCompartment({
			sessionId: id,
			scopePath: sessionMemoryScope(session),
			generation,
			startSeq: range.start,
			endSeq: range.end,
			startPara: this.cdb.paragraphFor(id, range.start) ?? 0,
			endPara: this.cdb.paragraphFor(id, range.end) ?? 0,
			summary: "",
			shadowedTokens,
		});
		this._notify(
			agent,
			`Compartment generation started: generation ${generation}`,
			`Started background summary generation for compartment generation ${generation}.`,
		);
		try {
			const target = this.config.summarizationProvider.length > 0 && this.config.summarizationModel.length > 0
				? { provider: this.config.summarizationProvider, model: this.config.summarizationModel }
				: routedTarget(session);
			const parsed = await summarizeCompartment(this.ctx, this.cdb, {
				session,
				compartment: this.cdb.compartmentById(compartmentId),
				range,
				scopePath: sessionMemoryScope(session),
				target,
			});
			this._notify(
				agent,
				`Compartment summary ready: #${compartmentId}`,
				[
					`Compartment ${compartmentId} summary completed.`,
					`Captured range: ${range.start}-${range.end}.`,
					`Extracted ${parsed.facts.length} project fact${parsed.facts.length === 1 ? "" : "s"}.`,
				].join("\n"),
			);
		} catch (error) {
			this.cdb.setCompartmentStatus(compartmentId, "failed");
			throw error;
		}
		return compartmentId;
	}

	/** 65% trigger: reserve the session before any asynchronous work. */
	maybeGenerate(agent) {
		const id = agent.session.id;
		const existing = this.inFlight.get(id);
		if (existing !== undefined) return existing;
		const task = this._maybeGenerate(agent);
		this.inFlight.set(id, task);
		const clear = () => {
			if (this.inFlight.get(id) === task) this.inFlight.delete(id);
		};
		task.then(clear, clear);
		return task;
	}

	async _maybeGenerate(agent) {
		const session = agent.session;
		const id = session.id;
		this._registerUnownedCheckpoints(agent); // migrate legacy checkpoints once
		if (this._readyCompartments(id).length > 0) return;
		const contextWindow = await this._contextWindow(agent);
		if (contextWindow === undefined) return;
		const measurement = this.ctx.tokenMeter.measure(session);
		if (measurement.totalTokens < this.ownConfig.generateThreshold * contextWindow) return;
		const paragraphFor = (sessionId, seq) => this.cdb.paragraphFor(sessionId, seq);
		const range = selectCompartmentRange(session, { retainRounds: this.ownConfig.retainRounds, paragraphFor })
			?? selectManualCompartmentRange(session, { retainRounds: this.ownConfig.retainRounds, paragraphFor });
		if (range === null) return;
		const shadowedTokens = measurement.nodes.slice(range.startIdx, range.endIdx + 1)
			.reduce((total, node) => total + node.tokens, 0);
		await this._createAndSummarize(agent, range, shadowedTokens);
	}

	/**
	 * Migration: register checkpoint nodes produced by the LEGACY engine
	 * (or by this engine before the compartments table existed) as landed
	 * compartments, so they join the chain lifecycle (range selection skips
	 * them, Dreamer can distill/mark them, archival can retire them).
	 * Idempotent: already-registered seqs are left alone.
	 */
	_registerUnownedCheckpoints(agent) {
		const session = agent.session;
		const nodes = session.surface.nodes;
		let seq = 0;
		for (const node of nodes) {
			const event = session.events[node];
			if (event?.type !== "user/message" || event.data?.source === undefined || !isCompactCheckpointSource(event.data.source)) break;
			seq = node;
			if (this.cdb.compartmentByLandingSeq(session.id, seq) !== undefined) continue;
			const text = extractText(event.data.content);
			const id = this.cdb.insertCompartment({
				sessionId: session.id,
				scopePath: sessionMemoryScope(session),
				generation: this.cdb.maxGeneration(session.id) + 1,
				startSeq: seq,
				endSeq: seq,
				startPara: this.cdb.paragraphFor(session.id, seq) ?? 0,
				endPara: this.cdb.paragraphFor(session.id, seq) ?? 0,
				summary: text,
				shadowedTokens: estimateTokens(JSON.stringify(event.data.content)),
			});
			this.cdb.markCompartmentLanded(id, seq);
		}
		return seq;
	}

	/** 80% trigger: land the oldest ready compartment (wait briefly if generating). */
	async maybeLand(agent, signal) {
		const session = agent.session;
		const contextWindow = await this._contextWindow(agent);
		if (contextWindow === undefined) return;
		const measurement = this.ctx.tokenMeter.measure(session);
		if (measurement.totalTokens < this.config.thresholdRatio * contextWindow) return;
		let ready = this._readyCompartments(session.id);
		if (ready.length === 0) {
			const inFlight = this.inFlight.get(session.id);
			if (inFlight === undefined) return;
			await Promise.race([inFlight, delay(this.ownConfig.waitReadyTimeoutMs, signal)]);
			ready = this._readyCompartments(session.id);
			if (ready.length === 0) return; // still not ready: skip this landing round
		}
		signal?.throwIfAborted();
		await this.land(agent, ready[0], signal);
	}

	/** One landing (automatic owner). */
	async land(agent, compartment, signal) {
		const result = await landCompartment(
			{ session: agent.session, cdb: this.cdb, meter: this.ctx.tokenMeter, agent },
			compartment,
			{ owner: "current-turn", signal },
		);
		this._announceCompartment(agent, compartment, result);
		return result;
	}

	/** Remove archived checkpoint nodes from the surface (compaction/prune protocol). */
	async _removeArchivedCheckpoints(agent) {
		const session = agent.session;
		const archived = this.cdb.archivedCompartments(session.id);
		if (archived.length === 0) return;
		const nodes = session.surface.nodes;
		for (const compartment of archived) {
			const seq = compartment.landing_seq;
			if (seq === undefined || !nodes.includes(seq)) {
				this.cdb.markCompartmentRemoved(compartment.id);
				continue;
			}
			const event = session.events[seq];
			const tokenCount = event?.data?.content === undefined ? 0 : estimateTokens(JSON.stringify(event.data.content));
			session.append("compaction/prune", {
				shadowedRange: { start: seq, end: seq },
				shadowedSeqs: [seq],
				shadowedTokenCount: tokenCount,
			});
			session.append("user/message", createUserMessage({ content: [{ type: "text", text: "" }] }), {
				surfaceOp: { op: "replace", start: seq, end: seq },
				sourceEventSeqs: [seq],
			});
			this.cdb.markCompartmentRemoved(compartment.id);
		}
	}

	/** Run one Dreamer pass for a session's agent (single-flight). */
	async _runDreamerForAgent(agent) {
		const dreamer = this.ownConfig.dreamerConfig;
		const target = dreamer.provider.length > 0 && dreamer.model.length > 0
			? { provider: dreamer.provider, model: dreamer.model }
			: routedTarget(agent.session);
		if (target === undefined) return { skipped: true, reason: "no route" };
		if (this.dreamerBusy) return { skipped: true, reason: "busy" };
		const scopePath = sessionMemoryScope(agent.session);
		const material = buildDreamerBrief(this.cdb, dreamer.verifyIntervalDays, scopePath);
		if (material.facts.length === 0 && material.memories.length === 0 && material.compartments.length === 0) {
			return { skipped: true, rounds: 0, ...material };
		}
		this.dreamerBusy = true;
		this._notify(
			agent,
			"Dreamer started",
			[
				"Dreamer started its background memory-maintenance pass.",
				`Pending facts: ${material.facts.length}; memories to verify: ${material.memories.length}; compartments to distill: ${material.compartments.length}.`,
			].join("\n"),
		);
		try {
			const workspaceRoot = agent.session.header?.cwd;
			const result = await runDreamer(this.ctx, this.cdb, {
				agent,
				provider: target.provider,
				model: target.model,
				sessions: this.ctx.sessions,
				workspaceRoot,
				scopePath,
				maxRounds: dreamer.maxRounds,
				timeoutMs: dreamer.timeoutMs,
				verifyIntervalDays: dreamer.verifyIntervalDays,
				retrieval: this.ownConfig.retrievalConfig,
			});
			const archival = runArchival(this.cdb, { budgetTokens: dreamer.compartmentBudgetTokens });
			this._notify(
				agent,
				"Dreamer completed",
				[
					"Dreamer completed its background memory-maintenance pass.",
					`Completed ${result.rounds} round${result.rounds === 1 ? "" : "s"}.`,
					`Summary: ${summarizeDreamerActions(result.actions)}.`,
					`Archived compartments: ${archival.archived.length}.`,
				].join("\n"),
			);
			return { ...result, archival };
		} catch (error) {
			this._notify(
				agent,
				"Dreamer failed",
				`Dreamer failed during its background memory-maintenance pass: ${error instanceof Error ? error.message : String(error)}`,
			);
			throw error;
		} finally {
			this.dreamerBusy = false;
		}
	}

	/** Overflow / manual fallback: land a ready compartment or generate synchronously. */
	async forceCompact(agent, signal) {
		signal?.throwIfAborted();
		const session = agent.session;
		let ready = this._readyCompartments(session.id);
		if (ready.length === 0) {
			const inFlight = this.inFlight.get(session.id);
			if (inFlight !== undefined) {
				await waitForSignal(inFlight.catch(() => {}), signal);
				ready = this._readyCompartments(session.id);
			}
			if (ready.length === 0) {
				const paragraphFor = (sessionId, seq) => this.cdb.paragraphFor(sessionId, seq);
				const range = selectManualCompartmentRange(session, { retainRounds: this.ownConfig.retainRounds, paragraphFor });
				if (range === null) return null;
				const measurement = this.ctx.tokenMeter.measure(session);
				const shadowedTokens = measurement.nodes.slice(range.startIdx, range.endIdx + 1)
					.reduce((total, node) => total + node.tokens, 0);
				await this._createAndSummarize(agent, range, shadowedTokens);
				ready = this._readyCompartments(session.id);
				if (ready.length === 0) return null;
			}
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
				let ready = this._readyCompartments(agent.session.id);
				let compartment;
				if (ready.length > 0) {
					compartment = ready[0];
				} else {
					const inFlight = this.inFlight.get(agent.session.id);
					if (inFlight !== undefined) await waitForSignal(inFlight.catch(() => {}), operationSignal);
					ready = this._readyCompartments(agent.session.id);
					if (ready.length === 0) {
						const paragraphFor = (sessionId, seq) => this.cdb.paragraphFor(sessionId, seq);
						const range = selectManualCompartmentRange(agent.session, { retainRounds: this.ownConfig.retainRounds, paragraphFor });
						if (range === null) return null;
						const measurement = this.ctx.tokenMeter.measure(agent.session);
						const shadowedTokens = measurement.nodes.slice(range.startIdx, range.endIdx + 1)
							.reduce((total, node) => total + node.tokens, 0);
						await this._createAndSummarize(agent, range, shadowedTokens);
						ready = this._readyCompartments(agent.session.id);
						if (ready.length === 0) return null;
					}
					compartment = ready[0];
				}
				const result = await landCompartment(
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
				this._announceCompartment(agent, compartment, result);
				return result;
			});
		} catch (error) {
			if (error instanceof ManualCompactionError) throw error;
			throw new ManualCompactionError("busy", "manual compaction requires an idle agent with no waking queued work", { cause: error });
		}
	}
}

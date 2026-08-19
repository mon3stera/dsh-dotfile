// Browser half of dsh-magic-context: a file-backed settings panel.
// It follows the existing dsh-plugin-font settings-row contract so it works
// without registering the agent-plane ContextEngine as a global namespace.
window.__ModuleLoader__.load({
	id: "dsh-magic-context",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const { jsx } = require("react/jsx-runtime");
		const { defineStore } = require("@deepseek-ai/dsh-client-runtime/client");
		const name = "dsh-magic-context";
		const inject = ["slots", "locale"];
		const LOCALE_NS = "dsh-magic-context-settings";

		const DEFAULTS = {
			thresholdRatio: 0.8,
			generateThreshold: 0.65,
			retainRounds: 20,
			waitReadyTimeoutMs: 60000,
			summarizationProvider: "",
			summarizationModel: "",
			summarizationReasoningEffort: "",
			summarizationMaxTokens: 32768,
			alpha: 0.4,
			beta: 0.2,
			injectBudgetTokens: 4000,
			archiveThreshold: 0.15,
			halfLives: { ARCHITECTURE: null, CONSTRAINTS: null, ENVIRONMENT: null, CONVENTIONS: 30, PREFERENCES: 14 },
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
			dreamerReasoningEffort: "",
			dreamerMaxTokens: 16384,
		};

		const GROUPS = [
			{
				key: "compaction",
				fields: [
					["thresholdRatio", "number", 0.1, 1, 0.05],
					["generateThreshold", "number", 0.1, 1, 0.05],
					["retainRounds", "number", 1, 100, 1],
					["waitReadyTimeoutMs", "number", 0, 600000, 1000],
					["summarization", "modelTarget"],
					["summarizationMaxTokens", "number", 1024, 262144, 1024],
				],
			},
			{
				key: "memory",
				fields: [
					["alpha", "number", 0, 10, 0.1],
					["beta", "number", 0, 10, 0.1],
					["injectBudgetTokens", "number", 1, 100000, 100],
					["archiveThreshold", "number", 0, 10, 0.01],
					["halfLives.ARCHITECTURE", "nullableNumber", 1, 3650, 1],
					["halfLives.CONSTRAINTS", "nullableNumber", 1, 3650, 1],
					["halfLives.ENVIRONMENT", "nullableNumber", 1, 3650, 1],
					["halfLives.CONVENTIONS", "nullableNumber", 1, 3650, 1],
					["halfLives.PREFERENCES", "nullableNumber", 1, 3650, 1],
				],
			},
			{
				key: "retrieval",
				fields: [
					["embeddingPreset", "select", "embedding"],
					["rerankPreset", "select", "rerank"],
					["embeddingModel", "text"],
					["embeddingBaseUrl", "text"],
					["embeddingApiKeyEnv", "text"],
					["embeddingDim", "number", 1, 4096, 1],
					["rerankModel", "text"],
					["rerankBaseUrl", "text"],
					["rerankApiKeyEnv", "text"],
					["rerankTopN", "number", 1, 100, 1],
					["rerankInputTopK", "number", 1, 1000, 1],
					["ftsTopK", "number", 1, 1000, 1],
					["vecTopK", "number", 1, 1000, 1],
					["vecMinScore", "number", 0, 1, 0.01],
					["rrfK", "number", 1, 10000, 1],
				],
			},
			{
				key: "dreamer",
				fields: [
					["dreamerIdleMinutes", "number", 1, 10080, 1],
					["dreamerMaxRounds", "number", 1, 100, 1],
					["dreamerTimeoutMs", "number", 1000, 3600000, 1000],
					["verifyIntervalDays", "number", 1, 3650, 1],
					["compartmentBudgetTokens", "number", 1, 1000000, 100],
					["dreamer", "modelTarget"],
					["dreamerMaxTokens", "number", 1024, 262144, 1024],
				],
			},
		];

		const FIELD_LABELS = {
			thresholdRatio: ["context threshold", "自动落地阈值，占模型 context window 的比例"],
			generateThreshold: ["generation threshold", "后台开始生成 compartment 的 context 比例"],
			retainRounds: ["retained paragraphs", "自动压缩时原样保留的最近 N 个有段落号消息"],
			waitReadyTimeoutMs: ["ready wait timeout (ms)", "落地前等待异步 summary ready 的最长时间"],
			summarization: ["整理者模型", "生成 Compartment 摘要的模型；留空表示沿用当前 session route"],
			summarizationMaxTokens: ["整理者输出上限", "单次整理调用的输出预算；推理模型的思考也占用它，会自动收敛到模型上限"],
			alpha: ["memory hit boost (alpha)", "memory 命中次数对分数的提升系数"],
			beta: ["memory decay speed (beta)", "命中次数对衰减半衰期的影响系数"],
			injectBudgetTokens: ["memory injection budget", "每次请求注入 memory summary 的 token 预算"],
			archiveThreshold: ["memory archive threshold", "低于此分数的 memory 不再自动注入"],
			"halfLives.ARCHITECTURE": ["ARCHITECTURE half-life (days)", "留空表示永不衰减"],
			"halfLives.CONSTRAINTS": ["CONSTRAINTS half-life (days)", "留空表示永不衰减"],
			"halfLives.ENVIRONMENT": ["ENVIRONMENT half-life (days)", "留空表示永不衰减"],
			"halfLives.CONVENTIONS": ["CONVENTIONS half-life (days)", "留空表示永不衰减"],
			"halfLives.PREFERENCES": ["PREFERENCES half-life (days)", "留空表示永不衰减"],
			embeddingPreset: ["embedding preset", "单独选择 embedding 模型；保存后自动下载到 ~/.dsh/magic-context/.cache"],
			rerankPreset: ["rerank preset", "单独选择 rerank 模型；保存后自动下载到 ~/.dsh/magic-context/.cache"],
			embeddingModel: ["embedding model", "留空表示关闭向量检索"],
			embeddingBaseUrl: ["embedding endpoint", "OpenAI-compatible embeddings endpoint"],
			embeddingApiKeyEnv: ["embedding API key env", "读取 API key 的环境变量名"],
			embeddingDim: ["embedding dimension", "向量维度，必须和模型输出一致"],
			rerankModel: ["rerank model", "留空表示关闭 rerank"],
			rerankBaseUrl: ["rerank endpoint", "OpenAI-compatible rerank endpoint"],
			rerankApiKeyEnv: ["rerank API key env", "读取 API key 的环境变量名"],
			rerankTopN: ["rerank top N", "最终保留的 rerank 结果数量"],
			rerankInputTopK: ["rerank input top K", "发送给 rerank 的候选数量"],
			ftsTopK: ["FTS top K", "FTS5 候选数量"],
			vecTopK: ["vector top K", "向量检索候选数量"],
			vecMinScore: ["vector minimum similarity", "低于此 cosine similarity 的向量结果不会进入 RRF 候选"],
			rrfK: ["RRF K", "混合检索 reciprocal-rank fusion 参数"],
			dreamerIdleMinutes: ["Dreamer idle minutes", "session 空闲多久后启动 Dreamer"],
			dreamerMaxRounds: ["Dreamer max rounds", "单次 Dreamer 最多调用轮数"],
			dreamerTimeoutMs: ["Dreamer timeout (ms)", "单次 Dreamer 维护超时时间"],
			verifyIntervalDays: ["memory verify interval (days)", "memory 再次进入校验队列的间隔"],
			compartmentBudgetTokens: ["compartment budget", "Dreamer 归档前允许保留的 summary token 总量"],
			dreamer: ["Dreamer 模型", "后台记忆整理使用的模型；留空表示沿用当前 session route"],
			dreamerMaxTokens: ["Dreamer 输出上限", "Dreamer 单轮输出预算；同样受模型上限收敛"],
		};

		const en = {
			title: "Context Compact",
			description: "Configure compartment compaction, project memory retrieval, and Dreamer. Changes apply to new ContextEngine instances.",
			loading: "Loading context settings…",
			compaction: "Compaction",
			memory: "Project memory",
			retrieval: "Retrieval",
			dreamer: "Dreamer",
			save: "Save",
			reset: "Reset defaults",
			saving: "Saving…",
			loaded: "Saved settings are used by new sessions.",
			saved: "Saved. Start a new session to use the values.",
			invalid: "Enter valid values before saving.",
			failed: "The settings could not be saved.",
			presetNone: "None (manual endpoint)",
			presetEmbeddingBge: "Local BGE-M3",
			presetRerankBge: "Local bge-reranker-v2-m3",
			embeddingModelLabel: "Embedding model",
			rerankModelLabel: "Rerank model",
			modelWaiting: "Waiting to download",
			modelLoading: "Downloading local model…",
			modelReady: "Local model is ready.",
			modelFailed: "Local model is unavailable. See the error details below.",
			meterMemories: "Memories",
			meterMemoriesHint: "Injected project_memory prefix. It rides every request but is not part of the conversation figure.",
			meterCompartments: "\u21B3 Compartments",
			meterCompartmentsHint: "Compartment checkpoints on the surface. Already counted inside conversation messages, shown here as a sub-total.",
			targetSessionRoute: "Same as the session model",
			targetManual: "Custom provider/model\u2026",
			targetSaved: "saved",
			targetProvider: "Provider route",
			targetModel: "Model id",
			targetEffort: "Reasoning effort",
			effortDefault: "Adapter default",
			catalogLoading: "Loading the model catalog\u2026",
			catalogUnavailable: "The model catalog is unavailable; enter the provider route and model id manually.",
			catalogFailures: "Providers that could not be listed:",
		};
		const zh = {
			title: "上下文管理",
			description: "配置 Compartment 压缩、项目记忆检索和 Dreamer。修改会应用到新的 ContextEngine 实例。",
			loading: "正在加载 context 设置…",
			compaction: "压缩",
			memory: "项目记忆",
			retrieval: "检索",
			dreamer: "Dreamer",
			save: "保存",
			reset: "恢复默认",
			saving: "保存中…",
			loaded: "保存的设置会用于新会话。",
			saved: "已保存。请新建会话后使用这些值。",
			invalid: "请先填写有效值。",
			failed: "设置保存失败。",
			presetNone: "无（手动 endpoint）",
			presetEmbeddingBge: "本地 BGE-M3",
			presetRerankBge: "本地 bge-reranker-v2-m3",
			embeddingModelLabel: "Embedding 模型",
			rerankModelLabel: "Rerank 模型",
			modelWaiting: "等待下载",
			modelLoading: "正在下载本地模型…",
			modelReady: "本地模型已准备好。",
			modelFailed: "本地模型不可用，请查看下方错误详情。",
			meterMemories: "项目记忆",
			meterMemoriesHint: "注入的 project_memory 前缀。它随每次请求发送，但不计入「对话消息」。",
			meterCompartments: "\u21B3 Compartment",
			meterCompartmentsHint: "surface 上的 Compartment checkpoint。已包含在「对话消息」内，此处仅作为其中的小计。",
			targetSessionRoute: "沿用 session 模型",
			targetManual: "自定义 provider/model\u2026",
			targetSaved: "已保存",
			targetProvider: "Provider route",
			targetModel: "Model id",
			targetEffort: "推理强度",
			effortDefault: "adapter 默认",
			catalogLoading: "正在加载模型目录…",
			catalogUnavailable: "模型目录不可用，请手动填写 provider route 和 model id。",
			catalogFailures: "以下 provider 无法列出模型：",
		};

		// --- Native context-meter rows -------------------------------------------
		// The composer's ContextMeter panel reports the heuristic system/tools/
		// messages composition, which omits the injected project_memory prefix
		// entirely and folds Compartment checkpoints into the conversation figure.
		// DSH renders that panel inline and exposes no slot inside it, so the two
		// extra rows are placed by DOM injection instead of patching the installed
		// `@deepseek-ai/dsh-client-ui-conversation` bundle.
		//
		// Selectors match CSS-module class SUFFIXES (`_panel`, `_rows`, `_row`,
		// `_swatch`): the hash prefix changes on every upstream rebuild, the suffix
		// does not. Rows are cloned from a live native row so all styling, spacing,
		// and theme tokens are inherited rather than duplicated.
		const METER_OWN = "data-dctx-meter-row";
		const METER_POLL_MS = 2000;
		// The swatch paints `background: var(--meter-tint)`, so an inline custom
		// property is enough to give Memories its own colour without new CSS.
		const METER_MEMORY_TINT = "#34d399";
		// Sub-total indent. The host row is `display:flex` with the value pushed
		// right by `justify-content:space-between`, so left padding on the row
		// moves only the label side. A sub-total carries no swatch of its own —
		// its tokens are already counted under the parent row's colour, so a
		// second colour would imply a separate segment. 28px therefore covers
		// the dropped swatch's footprint (8px plus its 6px `margin-right`) and
		// adds a 14px step, leaving the label one step right of the parent's.
		const METER_SUB_INDENT = "28px";

		/** Mirror of the host meter's compact token formatter (1234 -> "1.2K"). */
		function formatMeterTokens(n) {
			const scaled = (v) => (v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10));
			if (!Number.isFinite(n) || n < 0) return "0";
			if (n < 1e3) return String(Math.round(n));
			if (n < 1e6) return `${scaled(n / 1e3)}K`;
			return `${scaled(n / 1e6)}M`;
		}

		/** The open ContextMeter panel's legend list, or null when it is closed. */
		function findMeterRows() {
			const panels = document.querySelectorAll('[role="dialog"][class$="_panel"]');
			for (const panel of panels) {
				const rows = panel.querySelector('dl[class$="_rows"]');
				if (rows !== null) return rows;
			}
			return null;
		}

		/** Native (host-rendered) legend rows, in bar-segment order. */
		function nativeMeterRows(rows) {
			return Array.from(rows.children).filter((row) => !row.hasAttribute(METER_OWN));
		}

		/**
		 * Idempotently place/refresh one injected row. Writes only on an actual
		 * change so the MutationObserver that calls this cannot feed itself.
		 */
		function syncMeterRow(rows, template, spec) {
			let row = rows.querySelector(`[${METER_OWN}="${spec.key}"]`);
			if (row === null) {
				row = template.cloneNode(true);
				row.setAttribute(METER_OWN, spec.key);
				rows.appendChild(row);
			}
			if (row.title !== spec.hint) row.title = spec.hint;
			const indent = spec.indent === true ? METER_SUB_INDENT : "";
			if (row.style.paddingLeft !== indent) row.style.paddingLeft = indent;
			// Drop the cloned swatch on a sub-total. Done before the label is
			// written, because that step re-appends whatever swatch it finds.
			if (spec.indent === true) {
				const own = row.querySelector('span[class*="_swatch"]');
				if (own !== null) own.remove();
			}
			const dt = row.querySelector("dt");
			if (dt !== null && dt.textContent !== spec.label) {
				const swatch = dt.querySelector('span[class*="_swatch"]');
				dt.textContent = "";
				if (swatch !== null) dt.appendChild(swatch);
				dt.appendChild(document.createTextNode(spec.label));
			}
			if (spec.tint !== undefined) {
				const swatch = row.querySelector('span[class*="_swatch"]');
				if (swatch !== null && swatch.style.getPropertyValue("--meter-tint") !== spec.tint) {
					swatch.style.setProperty("--meter-tint", spec.tint);
				}
			}
			const dd = row.querySelector("dd");
			const value = `~${formatMeterTokens(spec.tokens)}`;
			if (dd !== null && dd.textContent !== value) dd.textContent = value;
		}

		/**
		 * Renders nothing: it exists to borrow the session-scoped slot lifecycle
		 * (mount, sessionId, disposal) for the DOM injection above. Polling only
		 * runs while the panel is actually open.
		 */
		function ContextMeterRows({ t, sessionId, session }) {
			const id = typeof sessionId === "string" && sessionId.length > 0
				? sessionId
				: (typeof session?.id === "string" ? session.id : undefined);
			const usageRef = react.useRef(null);
			react.useEffect(() => {
				if (id === undefined) return undefined;
				let active = true;
				let timer = null;
				let observer = null;
				const stopPolling = () => {
					if (timer === null) return;
					clearInterval(timer);
					timer = null;
				};
				const paint = () => {
					const usage = usageRef.current;
					const rows = findMeterRows();
					if (rows === null || usage === null) return;
					const native = nativeMeterRows(rows);
					if (native.length === 0) return; // no template to clone yet
					// Compartments inherit the conversation tint from the last native
					// row (they are part of that figure); Memories get their own.
					const template = native[native.length - 1];
					syncMeterRow(rows, template, {
						key: "compartments",
						label: t("meterCompartments"),
						hint: t("meterCompartmentsHint"),
						tokens: usage.compartments?.tokens ?? 0,
						indent: true,
					});
					syncMeterRow(rows, template, {
						key: "memories",
						label: t("meterMemories"),
						hint: t("meterMemoriesHint"),
						tokens: usage.memories?.tokens ?? 0,
						tint: METER_MEMORY_TINT,
					});
				};
				const load = async () => {
					try {
						const response = await fetch(`/magic-context/usage?sessionId=${encodeURIComponent(id)}`);
						if (!response.ok) return;
						const payload = await response.json();
						if (!active || payload?.ok !== true) return;
						usageRef.current = payload;
						paint();
					} catch { /* best effort; the next tick retries */ }
				};
				const tick = () => {
					if (!active) return;
					if (findMeterRows() === null) {
						stopPolling();
						return;
					}
					if (timer === null) timer = setInterval(() => { void load(); }, METER_POLL_MS);
					if (usageRef.current === null) void load();
					else paint();
				};
				if (typeof MutationObserver !== "undefined") {
					observer = new MutationObserver(tick);
					observer.observe(document.body, { childList: true, subtree: true });
				}
				tick();
				return () => {
					active = false;
					stopPolling();
					if (observer !== null) observer.disconnect();
					const rows = findMeterRows();
					if (rows !== null) rows.querySelectorAll(`[${METER_OWN}]`).forEach((row) => row.remove());
				};
			}, [id, t]);
			return null;
		}

		const CSS = [
			".dctx-panel{display:flex;flex-direction:column;gap:12px;max-width:760px;padding:2px 2px 6px}",
			".dctx-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;line-height:22px}",
			".dctx-description,.dctx-hint,.dctx-status{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
			".dctx-group{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px}",
			".dctx-models{display:flex;flex-direction:column;gap:10px;padding:2px 2px 4px}",
			".dctx-model-progress{display:flex;flex-direction:column;gap:5px}",
			".dctx-model-error{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;white-space:pre-wrap;overflow-wrap:anywhere}",
			".dctx-progress-meta{display:flex;justify-content:space-between;gap:12px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
			".dctx-progress-track{height:7px;overflow:hidden;background:var(--dsw-alias-border-l2);border-radius:99px}",
			".dctx-progress-fill{height:100%;background:var(--dsw-alias-state-business-primary);border-radius:99px;transition:width .2s ease}",
			".dctx-group summary{color:var(--dsw-alias-label-primary);cursor:pointer;font-size:13px;font-weight:600;line-height:22px}",
			".dctx-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 14px;padding-top:10px}",
			".dctx-field{display:flex;flex-direction:column;gap:4px;min-width:0}",
			".dctx-field-wide{grid-column:1/-1}",
			".dctx-subfield{display:flex;flex-direction:column;gap:4px;min-width:0;padding-top:2px}",
			".dctx-label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
			".dctx-input{box-sizing:border-box;width:100%;height:32px;color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:0 8px;font-size:12px;font-family:inherit}",
			".dctx-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}",
			".dctx-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
			".dctx-button{height:30px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:0 12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);cursor:pointer;font-size:12px}",
			".dctx-button.primary{color:var(--dsw-alias-text-on-primary);background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}",
			".dctx-button:disabled{opacity:.45;cursor:default}",
			"@media(max-width:680px){.dctx-grid{grid-template-columns:minmax(0,1fr)}}",
		].join("\n");

		const clone = (value) => JSON.parse(JSON.stringify(value));
		const valueAt = (object, path) => path.split(".").reduce((value, key) => value?.[key], object);
		const setAt = (object, path, value) => {
			const keys = path.split(".");
			let target = object;
			for (const key of keys.slice(0, -1)) target = target[key] ?? (target[key] = {});
			target[keys[keys.length - 1]] = value;
		};
		const merged = (config) => ({ ...clone(DEFAULTS), ...config, halfLives: { ...DEFAULTS.halfLives, ...(config?.halfLives ?? {}) } });
		const NUMBER_FIELDS = new Set(GROUPS.flatMap((group) => group.fields.filter((field) => field[1] === "number" || field[1] === "nullableNumber").map((field) => field[0])));

		function createContextStore() {
			return defineStore({
				init: () => ({ status: "loading", saved: clone(DEFAULTS), draft: clone(DEFAULTS), dirty: false, saving: false, message: "", modelStatus: { embedding: "idle", rerank: "idle" }, modelProgress: { embedding: 0, rerank: 0 }, modelError: { embedding: "", rerank: "" }, catalog: { status: "loading", groups: [], failures: [] } }),
				actions: {
					load: (state, config) => { state.saved = merged(config); state.draft = merged(config); state.dirty = false; state.saving = false; state.status = "ready"; state.message = ""; state.modelStatus = { embedding: "idle", rerank: "idle" }; state.modelProgress = { embedding: 0, rerank: 0 }; state.modelError = { embedding: "", rerank: "" }; },
					edit: (state, path, value) => { setAt(state.draft, path, value); state.dirty = true; state.message = ""; },
					reset: (state) => { state.draft = clone(DEFAULTS); state.dirty = true; state.message = ""; state.modelStatus = { embedding: "idle", rerank: "idle" }; state.modelProgress = { embedding: 0, rerank: 0 }; state.modelError = { embedding: "", rerank: "" }; },
					beginSave: (state) => { state.saving = true; state.message = ""; },
					saved: (state, config) => { state.saved = merged(config); state.draft = merged(config); state.dirty = false; state.saving = false; state.message = "saved"; },
					failed: (state, message) => { state.saving = false; state.message = message || "failed"; },
					modelLoading: (state, kind) => { state.modelStatus[kind] = "loading"; state.modelProgress[kind] = 0; state.modelError[kind] = ""; },
					modelProgress: (state, kind, progress) => { state.modelProgress[kind] = Math.max(0, Math.min(100, Number(progress) || 0)); },
					modelReady: (state, kind) => { state.modelStatus[kind] = "ready"; state.modelProgress[kind] = 100; state.modelError[kind] = ""; },
					modelFailed: (state, kind, error) => { state.modelStatus[kind] = "error"; state.modelError[kind] = error || ""; },
					catalog: (state, catalog) => { state.catalog = catalog; },
				},
			});
		}

		function normalizeDraft(draft) {
			const value = clone(draft);
			for (const path of NUMBER_FIELDS) {
				const raw = valueAt(value, path);
				if ((raw === "" || raw === "0" || raw === 0) && path.startsWith("halfLives.")) setAt(value, path, null);
				else {
					const number = Number(raw);
					if (!Number.isFinite(number)) throw new Error("invalid number");
					setAt(value, path, number);
				}
			}
			return value;
		}

		/** Split a catalog option value back into its provider/model pair. */
		function splitTarget(value) {
			const cut = value.indexOf("/");
			return cut === -1 ? { provider: value, model: "" } : { provider: value.slice(0, cut), model: value.slice(cut + 1) };
		}

		/** The catalog entry for one provider/model pair, when it advertises one. */
		function findCatalogModel(catalog, provider, model) {
			for (const group of catalog.groups) {
				if (group.id !== provider) continue;
				for (const entry of group.models) if (entry.id === model) return entry;
			}
			return undefined;
		}

		/**
		 * Provider/model/effort picker over the host's own provider registry.
		 *
		 * Catalog membership is advisory on purpose: a saved pair that no route
		 * advertises stays selected (shown as "saved") and manual entry remains
		 * available, so a gateway that hides its model list never blocks the
		 * organizer or Dreamer from being pointed somewhere cheaper.
		 */
		function ModelTargetField({ prefix, state, t, edit }) {
			const provider = String(valueAt(state.draft, `${prefix}Provider`) ?? "");
			const model = String(valueAt(state.draft, `${prefix}Model`) ?? "");
			const effort = String(valueAt(state.draft, `${prefix}ReasoningEffort`) ?? "");
			const pair = provider.length > 0 && model.length > 0 ? `${provider}/${model}` : "";
			const known = pair.length > 0 && findCatalogModel(state.catalog, provider, model) !== undefined;
			// Manual mode is only ever entered by choosing it. Deriving it from
			// catalog membership would depend on whether the catalog had arrived by
			// first render, so the panel would silently change shape with latency.
			const [manual, setManual] = react.useState(false);
			const copy = FIELD_LABELS[prefix] ?? [prefix, ""];
			const selected = manual ? "__manual__" : pair;
			const onSelect = (value) => {
				if (value === "__manual__") { setManual(true); return; }
				setManual(false);
				const next = value.length === 0 ? { provider: "", model: "" } : splitTarget(value);
				edit(`${prefix}Provider`, next.provider);
				edit(`${prefix}Model`, next.model);
				// Effort ids belong to one exact model; a stale id would fail the
				// next request, so switching the target clears it.
				edit(`${prefix}ReasoningEffort`, "");
			};
			const efforts = findCatalogModel(state.catalog, provider, model)?.reasoning?.efforts ?? [];
			const targetSelect = jsx("select", {
				className: "dctx-input",
				value: selected,
				onChange: (event) => onSelect(event.target.value),
				children: [
					jsx("option", { value: "", children: t("targetSessionRoute") }),
					...(pair.length > 0 && !known
						? [jsx("option", { key: "saved", value: pair, children: `${pair} (${t("targetSaved")})` })]
						: []),
					...state.catalog.groups.map((group) => jsx("optgroup", {
						label: group.name,
						children: group.models.map((entry) => jsx("option", {
							value: `${group.id}/${entry.id}`,
							children: entry.name === entry.id ? entry.id : `${entry.name} (${entry.id})`,
						}, entry.id)),
					}, group.id)),
					jsx("option", { value: "__manual__", children: t("targetManual") }),
				],
			});
			const manualInputs = manual
				? [
					jsx("div", { className: "dctx-subfield", children: [
						jsx("span", { className: "dctx-label", children: t("targetProvider") }),
						jsx("input", { className: "dctx-input", type: "text", value: provider, onChange: (event) => edit(`${prefix}Provider`, event.target.value) }),
					] }, "provider"),
					jsx("div", { className: "dctx-subfield", children: [
						jsx("span", { className: "dctx-label", children: t("targetModel") }),
						jsx("input", { className: "dctx-input", type: "text", value: model, onChange: (event) => edit(`${prefix}Model`, event.target.value) }),
					] }, "model"),
				]
				: [];
			const effortControl = efforts.length > 0
				? jsx("select", {
					className: "dctx-input",
					value: effort,
					onChange: (event) => edit(`${prefix}ReasoningEffort`, event.target.value),
					children: [
						jsx("option", { value: "", children: t("effortDefault") }),
						...efforts.map((entry) => jsx("option", { value: entry.id, children: entry.name ?? entry.id }, entry.id)),
					],
				})
				: jsx("input", { className: "dctx-input", type: "text", value: effort, placeholder: t("effortDefault"), onChange: (event) => edit(`${prefix}ReasoningEffort`, event.target.value) });
			return jsx("div", { className: "dctx-field dctx-field-wide", children: [
				jsx("span", { className: "dctx-label", children: copy[0] }),
				targetSelect,
				...manualInputs,
				jsx("div", { className: "dctx-subfield", children: [
					jsx("span", { className: "dctx-label", children: t("targetEffort") }),
					effortControl,
				] }),
				jsx("span", { className: "dctx-hint", children: state.catalog.status === "loading"
					? t("catalogLoading")
					: state.catalog.status === "error"
						? t("catalogUnavailable")
						: copy[1] }),
				...(state.catalog.failures.length > 0
					? [jsx("span", { className: "dctx-hint", children: `${t("catalogFailures")} ${state.catalog.failures.map((failure) => failure.id).join(", ")}` })]
					: []),
			] });
		}

		function Field({ field, state, t, edit }) {
			const [path, type, min, max, step] = field;
			if (type === "modelTarget") return jsx(ModelTargetField, { prefix: path, state, t, edit });
			const copy = FIELD_LABELS[path] ?? [path, ""];
			const current = valueAt(state.draft, path);
			const presetOptions = path === "embeddingPreset"
				? [["", "presetNone"], ["bge-m3", "presetEmbeddingBge"]]
				: [["", "presetNone"], ["bge-reranker-v2-m3", "presetRerankBge"]];
			const control = type === "select"
				? jsx("select", {
					className: "dctx-input",
					value: current ?? "",
					onChange: (event) => edit(path, event.target.value),
					children: presetOptions.map(([value, label]) => jsx("option", { key: value, value, children: t(label) })),
				})
				: jsx("input", {
					className: "dctx-input",
					type: type === "text" ? "text" : "number",
					value: current === null || current === undefined ? "" : String(current),
					min: type === "text" ? undefined : min,
					max: type === "text" ? undefined : max,
					step: type === "text" ? undefined : step,
					placeholder: type === "nullableNumber" ? "empty = never decays" : undefined,
					onChange: (event) => edit(path, event.target.value),
				});
			return jsx("label", { className: "dctx-field", children: [
				jsx("span", { className: "dctx-label", children: copy[0] }),
				control,
				jsx("span", { className: "dctx-hint", children: copy[1] }),
			] });
		}

		function ModelProgress({ kind, preset, status, progress, error, t }) {
			const percent = Math.max(0, Math.min(100, Number(progress) || 0));
			const label = kind === "embedding" ? t("embeddingModelLabel") : t("rerankModelLabel");
			const stateText = status === "loading" ? t("modelLoading") : status === "ready" ? t("modelReady") : status === "error" ? t("modelFailed") : t("modelWaiting");
			return jsx("div", { className: "dctx-model-progress", children: [
				jsx("div", { className: "dctx-progress-meta", children: [
					jsx("span", { children: `${label}: ${preset}` }),
					jsx("span", { children: `${Math.round(percent)}% · ${stateText}` }),
				] }),
				jsx("div", { className: "dctx-progress-track", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(percent), children: jsx("div", { className: "dctx-progress-fill", style: { width: `${percent}%` } }) }),
				...(status === "error" && error ? [jsx("div", { className: "dctx-model-error", children: error })] : []),
			] });
		}

		function ContextSettingsRow({ t, useStore, edit, save, reset }) {
			const state = useStore((snapshot) => snapshot);
			if (state.status === "loading") return jsx("div", { className: "dctx-panel", children: t("loading") });
			const modelRows = [
				{ kind: "embedding", preset: state.draft.embeddingPreset },
				{ kind: "rerank", preset: state.draft.rerankPreset },
			].filter((row) => row.preset);
			return jsx("div", { className: "dctx-panel", children: [
				jsx("div", { className: "dctx-title", children: t("title") }),
				jsx("div", { className: "dctx-description", children: t("description") }),
				...GROUPS.map((group) => jsx("details", { className: "dctx-group", open: group.key === "compaction", children: [
					jsx("summary", { children: t(group.key) }),
					jsx("div", { className: "dctx-grid", children: group.fields.map((field) => jsx(Field, { key: field[0], field, state, t, edit })) }),
				] })),
				...(modelRows.length > 0 ? [jsx("div", { className: "dctx-models", children: modelRows.map((row) => jsx(ModelProgress, { key: row.kind, ...row, status: state.modelStatus[row.kind], progress: state.modelProgress[row.kind], error: state.modelError[row.kind], t })) })] : []),
				jsx("div", { className: "dctx-actions", children: [
					jsx("button", { className: "dctx-button primary", type: "button", disabled: !state.dirty || state.saving, onClick: save, children: state.saving ? t("saving") : t("save") }),
					jsx("button", { className: "dctx-button", type: "button", disabled: state.saving, onClick: reset, children: t("reset") }),
					jsx("span", { className: "dctx-status", children: state.modelStatus.embedding === "loading" || state.modelStatus.rerank === "loading" ? t("modelLoading") : state.modelStatus.embedding === "error" || state.modelStatus.rerank === "error" ? t("modelFailed") : state.modelStatus.embedding === "ready" || state.modelStatus.rerank === "ready" ? t("modelReady") : state.message === "saved" ? t("saved") : state.message === "failed" ? t("failed") : state.message === "invalid" ? t("invalid") : t("loaded") }),
				] }),
			] });
		}

		function apply(ctx) {
			const store = createContextStore();
			const t = ctx.locale.bind(LOCALE_NS);
			let bound;
			let draft = clone(DEFAULTS);
			let loaded = null;
			const load = (config) => {
				loaded = merged(config);
				draft = clone(loaded);
				bound?.load(loaded);
			};
			const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
			const ensureModel = async (kind, preset) => {
				if (!preset) return;
				bound?.modelLoading(kind);
				try {
					const query = `kind=${encodeURIComponent(kind)}&preset=${encodeURIComponent(preset)}`;
					const kickoff = await fetch(`/magic-context/models/ensure?${query}`, { method: "POST" });
					if (!kickoff.ok) throw new Error("model download could not start");
					for (let attempt = 0; attempt < 900; attempt += 1) {
						const response = await fetch(`/magic-context/models/status?${query}`);
						const status = await response.json();
						if (typeof status.progress === "number") bound?.modelProgress(kind, status.progress);
						if (status.status === "ready") { bound?.modelReady(kind); return; }
						if (status.status === "error") throw new Error(status.error || "model download failed");
						await wait(1000);
					}
					throw new Error("model download timed out");
				} catch (error) {
					bound?.modelFailed(kind, error instanceof Error ? error.message : String(error));
				}
			};
			const loadCatalog = () => fetch("/magic-context/models/catalog")
				.then((response) => (response.ok ? response.json() : null))
				.then((payload) => {
					if (payload?.ok !== true || !Array.isArray(payload.groups)) throw new Error("catalog unavailable");
					bound?.catalog({ status: "ready", groups: payload.groups, failures: Array.isArray(payload.failures) ? payload.failures : [] });
				})
				.catch(() => bound?.catalog({ status: "error", groups: [], failures: [] }));
			fetch("/magic-context/config").then((response) => response.ok ? response.json() : null).then((payload) => {
				if (payload?.config) {
					load(payload.config);
					if (payload.config.embeddingPreset) void ensureModel("embedding", payload.config.embeddingPreset);
					if (payload.config.rerankPreset) void ensureModel("rerank", payload.config.rerankPreset);
				} else load(DEFAULTS);
			}).catch(() => load(DEFAULTS));
			const save = async () => {
				let payload;
				try { payload = normalizeDraft(draft); } catch { bound?.failed("invalid"); return; }
				bound?.beginSave();
				try {
					const response = await fetch("/magic-context/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
					const result = await response.json();
					if (!response.ok || result.ok !== true) { bound?.failed("failed"); return; }
					load(result.config);
					bound?.saved(result.config);
					if (result.config.embeddingPreset) void ensureModel("embedding", result.config.embeddingPreset);
					if (result.config.rerankPreset) void ensureModel("rerank", result.config.rerankPreset);
				} catch { bound?.failed("failed"); }
			};
			const injected = (actions) => {
				bound = actions;
				void loadCatalog();
				if (loaded !== null) actions.load(loaded);
				return {
					edit: (path, value) => {
						setAt(draft, path, value);
						actions.edit(path, value);
						if (path === "embeddingPreset" && value === "bge-m3") {
							setAt(draft, "embeddingDim", 1024);
							actions.edit("embeddingDim", 1024);
						}
					},
					save,
					reset: () => { draft = clone(DEFAULTS); actions.reset(); },
				};
			};
			const style = document.createElement("style");
			style.dataset.plugin = name;
			style.textContent = CSS;
			document.head.appendChild(style);
			ctx.effect(() => () => style.remove(), "dsh-magic-context-settings: styles");
			ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), "dsh-magic-context-settings: locale");
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "context-compact",
				order: 25,
				label: () => t("title"),
				locale: LOCALE_NS,
				store,
				inject: injected,
			}, ContextSettingsRow));
			// Renders nothing; it only borrows this session-scoped seat to inject the
			// Memories / Compartments rows into the native ContextMeter panel.
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "context-meter-rows",
				order: 90,
				locale: LOCALE_NS,
				inject: (sessionId) => ({ sessionId }),
			}, ContextMeterRows));
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});

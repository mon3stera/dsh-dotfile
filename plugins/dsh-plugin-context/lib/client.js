// Browser half of dsh-plugin-context: a file-backed settings panel.
// It follows the existing dsh-plugin-font settings-row contract so it works
// without registering the agent-plane ContextEngine as a global namespace.
window.__ModuleLoader__.load({
	id: "dsh-plugin-context",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const { jsx } = require("react/jsx-runtime");
		const { defineStore } = require("@deepseek-ai/dsh-client-runtime/client");
		const name = "dsh-plugin-context";
		const inject = ["slots", "locale"];
		const LOCALE_NS = "dsh-plugin-context-settings";

		const DEFAULTS = {
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
		};

		const GROUPS = [
			{
				key: "compaction",
				fields: [
					["thresholdRatio", "number", 0.1, 1, 0.05],
					["generateThreshold", "number", 0.1, 1, 0.05],
					["retainRounds", "number", 1, 100, 1],
					["waitReadyTimeoutMs", "number", 0, 600000, 1000],
					["summarizationProvider", "text"],
					["summarizationModel", "text"],
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
					["dreamerProvider", "text"],
					["dreamerModel", "text"],
				],
			},
		];

		const FIELD_LABELS = {
			thresholdRatio: ["context threshold", "自动落地阈值，占模型 context window 的比例"],
			generateThreshold: ["generation threshold", "后台开始生成 compartment 的 context 比例"],
			retainRounds: ["retained paragraphs", "自动压缩时原样保留的最近 N 个有段落号消息"],
			waitReadyTimeoutMs: ["ready wait timeout (ms)", "落地前等待异步 summary ready 的最长时间"],
			summarizationProvider: ["summary provider", "留空表示沿用当前 session route"],
			summarizationModel: ["summary model", "留空表示沿用当前 session route"],
			alpha: ["memory hit boost (alpha)", "memory 命中次数对分数的提升系数"],
			beta: ["memory decay speed (beta)", "命中次数对衰减半衰期的影响系数"],
			injectBudgetTokens: ["memory injection budget", "每次请求注入 memory summary 的 token 预算"],
			archiveThreshold: ["memory archive threshold", "低于此分数的 memory 不再自动注入"],
			"halfLives.ARCHITECTURE": ["ARCHITECTURE half-life (days)", "留空表示永不衰减"],
			"halfLives.CONSTRAINTS": ["CONSTRAINTS half-life (days)", "留空表示永不衰减"],
			"halfLives.ENVIRONMENT": ["ENVIRONMENT half-life (days)", "留空表示永不衰减"],
			"halfLives.CONVENTIONS": ["CONVENTIONS half-life (days)", "留空表示永不衰减"],
			"halfLives.PREFERENCES": ["PREFERENCES half-life (days)", "留空表示永不衰减"],
			embeddingPreset: ["embedding preset", "单独选择 embedding 模型；保存后自动下载到 ~/.dsh/context/.cache"],
			rerankPreset: ["rerank preset", "单独选择 rerank 模型；保存后自动下载到 ~/.dsh/context/.cache"],
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
			dreamerProvider: ["Dreamer provider", "留空表示沿用当前 session route"],
			dreamerModel: ["Dreamer model", "留空表示沿用当前 session route"],
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
			modelFailed: "Local model download failed; retrieval will retry on use.",
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
			modelFailed: "本地模型下载失败；检索时会继续重试。",
		};

		const CSS = [
			".dctx-panel{display:flex;flex-direction:column;gap:12px;max-width:760px;padding:2px 2px 6px}",
			".dctx-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;line-height:22px}",
			".dctx-description,.dctx-hint,.dctx-status{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
			".dctx-group{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px}",
			".dctx-models{display:flex;flex-direction:column;gap:10px;padding:2px 2px 4px}",
			".dctx-model-progress{display:flex;flex-direction:column;gap:5px}",
			".dctx-progress-meta{display:flex;justify-content:space-between;gap:12px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
			".dctx-progress-track{height:7px;overflow:hidden;background:var(--dsw-alias-border-l2);border-radius:99px}",
			".dctx-progress-fill{height:100%;background:var(--dsw-alias-state-business-primary);border-radius:99px;transition:width .2s ease}",
			".dctx-group summary{color:var(--dsw-alias-label-primary);cursor:pointer;font-size:13px;font-weight:600;line-height:22px}",
			".dctx-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 14px;padding-top:10px}",
			".dctx-field{display:flex;flex-direction:column;gap:4px;min-width:0}",
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
				init: () => ({ status: "loading", saved: clone(DEFAULTS), draft: clone(DEFAULTS), dirty: false, saving: false, message: "", modelStatus: { embedding: "idle", rerank: "idle" }, modelProgress: { embedding: 0, rerank: 0 } }),
				actions: {
					load: (state, config) => { state.saved = merged(config); state.draft = merged(config); state.dirty = false; state.saving = false; state.status = "ready"; state.message = ""; state.modelStatus = { embedding: "idle", rerank: "idle" }; state.modelProgress = { embedding: 0, rerank: 0 }; },
					edit: (state, path, value) => { setAt(state.draft, path, value); state.dirty = true; state.message = ""; },
					reset: (state) => { state.draft = clone(DEFAULTS); state.dirty = true; state.message = ""; state.modelStatus = { embedding: "idle", rerank: "idle" }; state.modelProgress = { embedding: 0, rerank: 0 }; },
					beginSave: (state) => { state.saving = true; state.message = ""; },
					saved: (state, config) => { state.saved = merged(config); state.draft = merged(config); state.dirty = false; state.saving = false; state.message = "saved"; },
					failed: (state, message) => { state.saving = false; state.message = message || "failed"; },
					modelLoading: (state, kind) => { state.modelStatus[kind] = "loading"; state.modelProgress[kind] = 0; },
					modelProgress: (state, kind, progress) => { state.modelProgress[kind] = Math.max(0, Math.min(100, Number(progress) || 0)); },
					modelReady: (state, kind) => { state.modelStatus[kind] = "ready"; state.modelProgress[kind] = 100; },
					modelFailed: (state, kind) => { state.modelStatus[kind] = "error"; },
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

		function Field({ field, state, t, edit }) {
			const [path, type, min, max, step] = field;
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

		function ModelProgress({ kind, preset, status, progress, t }) {
			const percent = Math.max(0, Math.min(100, Number(progress) || 0));
			const label = kind === "embedding" ? t("embeddingModelLabel") : t("rerankModelLabel");
			const stateText = status === "loading" ? t("modelLoading") : status === "ready" ? t("modelReady") : status === "error" ? t("modelFailed") : t("modelWaiting");
			return jsx("div", { className: "dctx-model-progress", children: [
				jsx("div", { className: "dctx-progress-meta", children: [
					jsx("span", { children: `${label}: ${preset}` }),
					jsx("span", { children: `${Math.round(percent)}% · ${stateText}` }),
				] }),
				jsx("div", { className: "dctx-progress-track", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(percent), children: jsx("div", { className: "dctx-progress-fill", style: { width: `${percent}%` } }) }),
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
				...(modelRows.length > 0 ? [jsx("div", { className: "dctx-models", children: modelRows.map((row) => jsx(ModelProgress, { key: row.kind, ...row, status: state.modelStatus[row.kind], progress: state.modelProgress[row.kind], t })) })] : []),
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
					const kickoff = await fetch(`/context/models/ensure?${query}`, { method: "POST" });
					if (!kickoff.ok) throw new Error("model download could not start");
					for (let attempt = 0; attempt < 900; attempt += 1) {
						const response = await fetch(`/context/models/status?${query}`);
						const status = await response.json();
						if (typeof status.progress === "number") bound?.modelProgress(kind, status.progress);
						if (status.status === "ready") { bound?.modelReady(kind); return; }
						if (status.status === "error") throw new Error(status.error || "model download failed");
						await wait(1000);
					}
					throw new Error("model download timed out");
				} catch {
					bound?.modelFailed(kind);
				}
			};
			fetch("/context/config").then((response) => response.ok ? response.json() : null).then((payload) => {
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
					const response = await fetch("/context/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
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
			ctx.effect(() => () => style.remove(), "dsh-plugin-context-settings: styles");
			ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), "dsh-plugin-context-settings: locale");
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "context-compact",
				order: 25,
				label: () => t("title"),
				locale: LOCALE_NS,
				store,
				inject: injected,
			}, ContextSettingsRow));
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});

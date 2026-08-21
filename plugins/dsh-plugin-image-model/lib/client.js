// Browser half of dsh-plugin-image-model: a settings section for image routes.
//
// The host's own provider editor cannot host these. It picks its form by
// settings namespace - `layoutOf` returns `deepseek` for `llm-deepseek`,
// `pi-ai` for `llm-pi-ai`, and `unknown` for anything else - and an unknown
// namespace renders a bare hint with the submit button disabled. A third-party
// provider registered into that directory would therefore be visible and
// uneditable, so this plugin owns its own section and registers it through the
// same public `settings.section` list slot the host's Models page uses.
//
// Everything here writes through the two host routes and re-renders from the
// response, so the running process stays the single source of truth: a saved
// change re-registers the adapter's routes immediately, with no restart.
window.__ModuleLoader__.load({
	id: "dsh-plugin-image-model",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const { jsx } = require("react/jsx-runtime");

		const NS = "dsh-plugin-image-model";
		const inject = ["slots", "locale"];

		const zh = {
			nav: "生图模型",
			title: "生图模型",
			description: "把 OpenAI 兼容的生图接口作为模型使用。保存后立即生效，无需重启。选中这类模型的会话只出图、不对话。",
			loading: "加载中...",
			addProvider: "添加提供商",
			addModel: "添加模型",
			remove: "删除",
			save: "保存",
			saving: "保存中...",
			reset: "放弃修改",
			saved: "已保存并生效",
			providerId: "路由 id",
			providerIdHint: "模型选择器中显示的提供商标识",
			providerName: "显示名称",
			baseURL: "接口地址",
			baseURLHint: "不含 /images/generations 的前缀，例如 https://example.com/v1",
			apiKeyRef: "凭据名",
			apiKeyRefHint: "POSIX 标识符，例如 OPENAI_API_KEY；环境变量与此处保存的密钥都按它解析",
			apiKeyValue: "密钥",
			apiKeyPlaceholder: "粘贴密钥后保存",
			apiKeyStored: "已配置",
			apiKeyMissing: "未配置",
			apiKeySave: "保存密钥",
			apiKeyClear: "清除",
			apiKeyReadOnly: "该凭据不可写入，请改用环境变量",
			edits: "把上一张图作为编辑对象",
			editsHint: "后续消息改图而不是重新生成",
			models: "模型",
			modelId: "模型 id",
			modelName: "显示名称",
			advanced: "生成参数",
			size: "尺寸 (size)",
			quality: "质量 (quality)",
			background: "背景 (background)",
			outputFormat: "输出格式 (output_format)",
			optionHint: "留空即不发送该参数；网关会拒绝它不认识的参数。",
			limits: "附件存储默认上限为单边 2000px、编码后 3.5 MiB。过大的输出会被拒绝，请调小尺寸或用 jpeg。",
			empty: "还没有配置生图提供商。",
			needModel: "每个提供商至少需要一个模型，缺少 id 的条目会被丢弃。",
			seeded: "来自配置文件",
			failed: "操作失败",
		};
		const en = {
			nav: "Image models",
			title: "Image models",
			description: "Use OpenAI-compatible image endpoints as models. Saving applies immediately, with no restart. A session on one of these routes only produces images; it cannot converse.",
			loading: "Loading...",
			addProvider: "Add provider",
			addModel: "Add model",
			remove: "Remove",
			save: "Save",
			saving: "Saving...",
			reset: "Discard changes",
			saved: "Saved and applied",
			providerId: "Route id",
			providerIdHint: "The provider key shown in the model selector",
			providerName: "Display name",
			baseURL: "Endpoint",
			baseURLHint: "The prefix without /images/generations, e.g. https://example.com/v1",
			apiKeyRef: "Credential name",
			apiKeyRefHint: "A POSIX identifier such as OPENAI_API_KEY; both an environment variable and a key saved here resolve through it",
			apiKeyValue: "Key",
			apiKeyPlaceholder: "Paste the key, then save",
			apiKeyStored: "configured",
			apiKeyMissing: "not configured",
			apiKeySave: "Save key",
			apiKeyClear: "Clear",
			apiKeyReadOnly: "This credential is not writable; set the environment variable instead",
			edits: "Refine the previous image",
			editsHint: "A follow-up message edits it instead of generating from scratch",
			models: "Models",
			modelId: "Model id",
			modelName: "Display name",
			advanced: "Generation options",
			size: "size",
			quality: "quality",
			background: "background",
			outputFormat: "output_format",
			optionHint: "An empty field is not sent; gateways reject parameters they do not recognize.",
			limits: "The attachment store allows 2000px per side and 3.5 MiB encoded by default. A larger output is refused - reduce the size or use jpeg.",
			empty: "No image providers configured yet.",
			needModel: "Every provider needs at least one model; an entry without an id is dropped.",
			seeded: "from the config file",
			failed: "The operation failed",
		};

		const CSS = [
			`.${NS}-panel{display:flex;flex-direction:column;gap:12px;max-width:720px;`
				+ `color:var(--dsw-alias-label-primary)}`,
			`.${NS}-title{margin:0;font-size:16px;font-weight:500;line-height:24px}`,
			`.${NS}-desc,.${NS}-hint{margin:0;color:var(--dsw-alias-label-tertiary);`
				+ `font-size:12px;line-height:18px}`,
			`.${NS}-card{display:flex;flex-direction:column;gap:12px;padding:12px 14px;`
				+ `border:1px solid var(--dsw-alias-border-l2);border-radius:12px}`,
			`.${NS}-head{display:flex;align-items:center;gap:8px}`,
			`.${NS}-head-name{font-size:14px;font-weight:500;flex:1 1 auto;min-width:0;`
				+ `overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
			`.${NS}-tag{flex:none;padding:1px 6px;border:1px solid var(--dsw-alias-border-l3);`
				+ `border-radius:4px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}`,
			`.${NS}-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}`,
			`.${NS}-field{display:flex;flex-direction:column;gap:4px;min-width:0}`,
			`.${NS}-label{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px}`,
			`.${NS}-input{box-sizing:border-box;width:100%;height:32px;padding:0 10px;font:inherit;`
				+ `font-size:14px;line-height:22px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;`
				+ `background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}`,
			`.${NS}-input:focus{border-color:var(--dsw-alias-brand-primary);outline:none}`,
			`.${NS}-input::placeholder{color:var(--dsw-alias-label-dimmed)}`,
			`.${NS}-row{display:flex;align-items:flex-end;gap:8px}`,
			`.${NS}-row>.${NS}-field{flex:1 1 auto}`,
			`.${NS}-check{display:inline-flex;align-items:center;gap:8px;font-size:13px}`,
			`.${NS}-dot{flex:none;width:8px;height:8px;border-radius:50%;display:inline-block}`,
			`.${NS}-dot-on{background:var(--dsw-alias-state-success-primary)}`,
			`.${NS}-dot-off{background:var(--dsw-alias-state-error-primary)}`,
			`.${NS}-models{display:flex;flex-direction:column;gap:8px;padding-top:10px;`
				+ `border-top:1px solid var(--dsw-alias-border-l2)}`,
			`.${NS}-model{display:flex;flex-direction:column;gap:8px;padding:8px;`
				+ `border:1px solid var(--dsw-alias-border-l2);border-radius:8px}`,
			`.${NS}-btn{box-sizing:border-box;height:28px;padding:0 10px;font:inherit;font-size:12px;`
				+ `line-height:18px;cursor:pointer;border-radius:14px;display:inline-flex;align-items:center;`
				+ `gap:4px;border:1px solid var(--dsw-alias-border-l2);background:none;`
				+ `color:var(--dsw-alias-label-primary)}`,
			`.${NS}-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}`,
			`.${NS}-btn:disabled{opacity:.4;cursor:default}`,
			`.${NS}-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:transparent}`,
			`.${NS}-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}`,
			`.${NS}-btn-primary{height:36px;padding:0 14px;font-size:14px;line-height:22px;border-radius:18px;`
				+ `border:none;background:var(--dsw-alias-button-primary-fill);`
				+ `color:var(--dsw-alias-label-primary-foreground)}`,
			`.${NS}-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}`,
			`.${NS}-actions{display:flex;gap:8px;align-items:center}`,
			`.${NS}-spacer{margin-left:auto}`,
			`.${NS}-error{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}`,
			`.${NS}-ok{margin:0;color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:18px}`,
			`.${NS}-add{box-sizing:border-box;height:44px;border:1px dashed var(--dsw-alias-border-l3);`
				+ `border-radius:12px;background:none;color:var(--dsw-alias-label-primary);font:inherit;`
				+ `font-size:14px;cursor:pointer}`,
			`.${NS}-add:hover{background:var(--dsw-alias-interactive-bg-hover)}`,
		].join("");

		/** The per-model generation options this panel exposes, in display order. */
		const MODEL_OPTIONS = ["size", "quality", "background", "outputFormat"];

		/** A fresh provider draft. The id is what the model selector will show. */
		function blankProvider(index) {
			return {
				id: `image-${index}`,
				name: "",
				baseURL: "",
				apiKeyRef: "",
				edits: true,
				models: [blankModel()],
			};
		}

		function blankModel() {
			return { id: "", name: "" };
		}

		/** Read a provider list out of a route response, tolerating a failure body. */
		function providersOf(payload) {
			return Array.isArray(payload?.providers) ? payload.providers : [];
		}

		/**
		 * Post JSON to a host route and return the parsed body.
		 *
		 * A non-2xx answer still carries a reason, so the body is parsed either way
		 * and the caller decides what to show.
		 */
		async function post(path, body) {
			const response = await fetch(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			let payload = {};
			try {
				payload = await response.json();
			} catch {
				payload = { ok: false, error: `HTTP ${response.status}` };
			}
			return payload;
		}

		function Field({ label, hint, value, placeholder, onChange, type }) {
			return jsx("label", {
				className: `${NS}-field`,
				children: [
					jsx("span", { className: `${NS}-label`, children: label }, "l"),
					jsx("input", {
						className: `${NS}-input`,
						type: type ?? "text",
						value: value ?? "",
						placeholder: placeholder ?? "",
						spellCheck: false,
						onChange: (event) => onChange(event.target.value),
					}, "i"),
					hint === undefined ? null : jsx("span", { className: `${NS}-hint`, children: hint }, "h"),
				],
			});
		}

		function ModelCard({ model, index, t, onEdit, onRemove }) {
			return jsx("div", {
				className: `${NS}-model`,
				children: [
					jsx("div", {
						className: `${NS}-row`,
						children: [
							jsx(Field, {
								label: t("modelId"),
								value: model.id,
								placeholder: "gpt-image-1",
								onChange: (value) => onEdit("id", value),
							}, "id"),
							jsx(Field, {
								label: t("modelName"),
								value: model.name,
								onChange: (value) => onEdit("name", value),
							}, "name"),
							jsx("button", {
								type: "button",
								className: `${NS}-btn ${NS}-btn-danger`,
								onClick: onRemove,
								children: t("remove"),
							}, "rm"),
						],
					}, "head"),
					jsx("details", {
						children: [
							jsx("summary", { className: `${NS}-label`, children: t("advanced") }, "s"),
							jsx("div", {
								className: `${NS}-grid`,
								style: { paddingTop: "8px" },
								children: MODEL_OPTIONS.map((key) => jsx(Field, {
									label: t(key),
									value: model[key],
									onChange: (value) => onEdit(key, value),
								}, key)),
							}, "g"),
							jsx("p", { className: `${NS}-hint`, children: t("optionHint") }, "h"),
						],
					}, `adv-${index}`),
				],
			});
		}

		function ProviderCard({ provider, index, seeded, credential, t, onEdit, onRemove, onKey }) {
			const [key, setKey] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const writable = credential === undefined || credential.writable === true;
			const editModel = (modelIndex, field, value) => {
				const models = provider.models.map((model, i) => (i === modelIndex ? { ...model, [field]: value } : model));
				onEdit("models", models);
			};
			const submitKey = async (value) => {
				setBusy(true);
				try {
					await onKey(provider.apiKeyRef, value);
					setKey("");
				} finally {
					setBusy(false);
				}
			};
			return jsx("div", {
				className: `${NS}-card`,
				children: [
					jsx("div", {
						className: `${NS}-head`,
						children: [
							jsx("span", {
								className: `${NS}-head-name`,
								children: provider.name === "" ? provider.id : provider.name,
							}, "n"),
							seeded ? jsx("span", { className: `${NS}-tag`, children: t("seeded") }, "t") : null,
							jsx("button", {
								type: "button",
								className: `${NS}-btn ${NS}-btn-danger ${NS}-spacer`,
								onClick: onRemove,
								children: t("remove"),
							}, "rm"),
						],
					}, "head"),
					jsx("div", {
						className: `${NS}-grid`,
						children: [
							jsx(Field, {
								label: t("providerId"),
								hint: t("providerIdHint"),
								value: provider.id,
								onChange: (value) => onEdit("id", value),
							}, "id"),
							jsx(Field, {
								label: t("providerName"),
								value: provider.name,
								onChange: (value) => onEdit("name", value),
							}, "name"),
							jsx(Field, {
								label: t("baseURL"),
								hint: t("baseURLHint"),
								value: provider.baseURL,
								placeholder: "https://example.com/v1",
								onChange: (value) => onEdit("baseURL", value),
							}, "url"),
							jsx(Field, {
								label: t("apiKeyRef"),
								hint: t("apiKeyRefHint"),
								value: provider.apiKeyRef,
								placeholder: "OPENAI_API_KEY",
								onChange: (value) => onEdit("apiKeyRef", value),
							}, "ref"),
						],
					}, "grid"),
					provider.apiKeyRef === "" ? null : jsx("div", {
						className: `${NS}-row`,
						children: [
							jsx(Field, {
								label: t("apiKeyValue"),
								value: key,
								type: "password",
								placeholder: t("apiKeyPlaceholder"),
								onChange: setKey,
							}, "key"),
							jsx("button", {
								type: "button",
								className: `${NS}-btn`,
								disabled: busy || key === "" || !writable,
								onClick: () => void submitKey(key),
								children: t("apiKeySave"),
							}, "set"),
							jsx("button", {
								type: "button",
								className: `${NS}-btn`,
								disabled: busy || credential?.configured !== true || !writable,
								onClick: () => void submitKey(""),
								children: t("apiKeyClear"),
							}, "clear"),
						],
					}, "keyrow"),
					provider.apiKeyRef === "" ? null : jsx("div", {
						className: `${NS}-check`,
						children: [
							jsx("span", {
								className: `${NS}-dot ${credential?.configured === true ? `${NS}-dot-on` : `${NS}-dot-off`}`,
							}, "d"),
							jsx("span", {
								className: `${NS}-hint`,
								children: credential?.configured === true
									? `${t("apiKeyStored")}${credential.source === undefined ? "" : ` (${credential.source})`}`
									: writable ? t("apiKeyMissing") : t("apiKeyReadOnly"),
							}, "s"),
						],
					}, "keystate"),
					jsx("label", {
						className: `${NS}-check`,
						children: [
							jsx("input", {
								type: "checkbox",
								checked: provider.edits !== false,
								onChange: (event) => onEdit("edits", event.target.checked),
							}, "c"),
							jsx("span", { children: t("edits") }, "l"),
						],
					}, "edits"),
					jsx("p", { className: `${NS}-hint`, children: t("editsHint") }, "editsHint"),
					jsx("div", {
						className: `${NS}-models`,
						children: [
							jsx("span", { className: `${NS}-label`, children: t("models") }, "l"),
							...provider.models.map((model, modelIndex) => jsx(ModelCard, {
								model,
								index: `${index}-${modelIndex}`,
								t,
								onEdit: (field, value) => editModel(modelIndex, field, value),
								onRemove: () => onEdit("models", provider.models.filter((_, i) => i !== modelIndex)),
							}, `m${modelIndex}`)),
							jsx("button", {
								type: "button",
								className: `${NS}-btn`,
								onClick: () => onEdit("models", [...provider.models, blankModel()]),
								children: t("addModel"),
							}, "add"),
						],
					}, "models"),
				],
			});
		}

		function ImageModelsSection({ t }) {
			const [state, setState] = react.useState({ status: "loading", providers: [], credentials: {}, seeded: [] });
			const [busy, setBusy] = react.useState(false);
			const [message, setMessage] = react.useState(undefined);

			const adopt = (payload, status) => {
				setState({
					status: status ?? "ready",
					providers: providersOf(payload).map((provider) => ({
						id: provider.id ?? "",
						name: provider.name ?? "",
						baseURL: provider.baseURL ?? "",
						apiKeyRef: provider.apiKeyRef ?? "",
						edits: provider.edits !== false,
						contextWindow: provider.contextWindow,
						models: Array.isArray(provider.models) && provider.models.length > 0
							? provider.models.map((model) => ({ ...model }))
							: [blankModel()],
					})),
					credentials: payload?.credentials ?? {},
					seeded: Array.isArray(payload?.seeded) ? payload.seeded : [],
				});
			};

			const load = react.useCallback(async () => {
				try {
					const response = await fetch("/image-model/config");
					adopt(await response.json());
				} catch (error) {
					setState((previous) => ({ ...previous, status: "ready" }));
					setMessage({ kind: "error", text: `${t("failed")}: ${String(error)}` });
				}
			}, [t]);

			react.useEffect(() => { void load(); }, [load]);

			const editProvider = (index, field, value) => {
				setState((previous) => ({
					...previous,
					providers: previous.providers.map((provider, i) => (i === index ? { ...provider, [field]: value } : provider)),
				}));
				setMessage(undefined);
			};

			const save = async () => {
				setBusy(true);
				setMessage(undefined);
				try {
					const payload = await post("/image-model/config", { providers: state.providers });
					if (payload?.ok !== true) {
						setMessage({ kind: "error", text: `${t("failed")}: ${payload?.error ?? ""}` });
						return;
					}
					adopt(payload);
					setMessage({ kind: payload.warning === undefined ? "ok" : "error", text: payload.warning ?? t("saved") });
				} catch (error) {
					setMessage({ kind: "error", text: `${t("failed")}: ${String(error)}` });
				} finally {
					setBusy(false);
				}
			};

			const storeKey = async (ref, value) => {
				const payload = await post("/image-model/credential", { ref, value });
				if (payload?.ok !== true) {
					setMessage({ kind: "error", text: `${t("failed")}: ${payload?.error ?? ""}` });
					return;
				}
				setState((previous) => ({ ...previous, credentials: payload.credentials ?? previous.credentials }));
				setMessage({ kind: "ok", text: t("saved") });
			};

			if (state.status === "loading") {
				return jsx("div", { className: `${NS}-panel`, children: t("loading") });
			}

			const seeded = new Set(state.seeded);
			return jsx("div", {
				className: `${NS}-panel`,
				children: [
					jsx("h3", { className: `${NS}-title`, children: t("title") }, "title"),
					jsx("p", { className: `${NS}-desc`, children: t("description") }, "desc"),
					jsx("p", { className: `${NS}-hint`, children: t("limits") }, "limits"),
					state.providers.length === 0
						? jsx("p", { className: `${NS}-hint`, children: t("empty") }, "empty")
						: null,
					...state.providers.map((provider, index) => jsx(ProviderCard, {
						provider,
						index,
						seeded: seeded.has(provider.id),
						credential: state.credentials[provider.apiKeyRef],
						t,
						onEdit: (field, value) => editProvider(index, field, value),
						onRemove: () => {
							setState((previous) => ({
								...previous,
								providers: previous.providers.filter((_, i) => i !== index),
							}));
							setMessage(undefined);
						},
						onKey: storeKey,
					}, `p${index}`)),
					jsx("button", {
						type: "button",
						className: `${NS}-add`,
						onClick: () => {
							setState((previous) => ({
								...previous,
								providers: [...previous.providers, blankProvider(previous.providers.length + 1)],
							}));
							setMessage(undefined);
						},
						children: t("addProvider"),
					}, "addProvider"),
					jsx("p", { className: `${NS}-hint`, children: t("needModel") }, "needModel"),
					message === undefined ? null : jsx("p", {
						className: message.kind === "ok" ? `${NS}-ok` : `${NS}-error`,
						children: message.text,
					}, "msg"),
					jsx("div", {
						className: `${NS}-actions`,
						children: [
							jsx("button", {
								type: "button",
								className: `${NS}-btn ${NS}-btn-primary`,
								disabled: busy,
								onClick: () => void save(),
								children: busy ? t("saving") : t("save"),
							}, "save"),
							jsx("button", {
								type: "button",
								className: `${NS}-btn`,
								disabled: busy,
								onClick: () => { setMessage(undefined); void load(); },
								children: t("reset"),
							}, "reset"),
						],
					}, "actions"),
				],
			});
		}

		function apply(ctx) {
			const style = document.createElement("style");
			style.dataset.plugin = NS;
			style.textContent = CSS;
			document.head.appendChild(style);
			ctx.effect(() => () => style.remove(), `${NS}: styles`);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${NS}: locale`);
			// order 30 keeps this after the host's Models (10) and General sections;
			// image routes are an addition to model configuration, not a replacement.
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "image-models",
				order: 30,
				label: () => ctx.locale.bind(NS)("nav"),
				locale: NS,
			}, ImageModelsSection));
		}

		exports.name = NS;
		exports.inject = inject;
		exports.apply = apply;
		exports.ImageModelsSection = ImageModelsSection;
		exports.blankProvider = blankProvider;
		exports.providersOf = providersOf;
		return module.exports;
	},
});

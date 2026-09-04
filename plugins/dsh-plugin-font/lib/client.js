/**
 * Browser half of dsh-plugin-font. Hand-written client bundle in the
 * DSH client-modules format (window.__ModuleLoader__.load CJS factory).
 *
 * Features:
 *  - a "界面字体 / UI fonts" settings row in Settings > General,
 *  - two dropdown font pickers: body font (--dsw-font-family) and code font
 *    (--ds-font-family-code), each with presets plus a "custom…" free-text
 *    input for fonts outside the list; empty = system default,
 *  - body and code font-size steppers (absolute px). The theme baselines are
 *    probed through the layout engine, so host-side derived tokens resolve
 *    correctly; unadjusted sizes follow the theme's own content font-size
 *    axis. Persisted through the plugin-owned $DSH_HOME/font/config.json, so
 *    the choices survive restarts without depending on the Host settings
 *    document.
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-font",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const jsx = require("react/jsx-runtime").jsx;
		const { defineStore } = require("@deepseek-ai/dsh-client-store");

		const name = "dsh-plugin-font";
		const inject = ["slots", "locale"];
		const SETTINGS_LOCALE_NS = "dsh-plugin-font";

		/** The UI/body and code font tokens defined by the theme base sheet. */
		const BODY_FONT_VAR = "--dsw-font-family";
		const CODE_FONT_VAR = "--ds-font-family-code";
		/** Fallback stacks used when the base sheet's values cannot be read. */
		const DEFAULT_BODY_STACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif";
		const DEFAULT_CODE_STACK = "'SF Mono', 'JetBrains Mono', 'Fira Code', Consolas, 'Liberation Mono', Menlo, Courier, 'PingFang SC', 'Microsoft YaHei'";

		/** Markdown font families scaled by the font-size setting (the markdown root
		 * consumes font: var(--dsw-font-markdown-base), headings h1-h4, etc.). */
		const MARKDOWN_FONT_FAMILIES = [
			"base", "base-italic", "base-strong", "base-strong-italic",
			"h1", "h2", "h3", "h4",
			"table", "table-head",
			"small", "small-strong", "small-italic", "small-strong-italic",
			"code", "code-block", "code-block-small"
		];
		/** Code families scale with the code size setting; the rest follow the body size. */
		const CODE_FONT_FAMILIES = new Set(["code", "code-block", "code-block-small"]);
		const round1 = (value) => Math.round(value * 10) / 10;

		/** Font-size slider bounds (absolute px of the markdown base / inline code). */
		const FONT_SIZE_MIN = 12;
		const FONT_SIZE_MAX = 24;
		/** Pre-derived-theme base, kept only to migrate legacy percentage configs. */
		const LEGACY_BASE_FONT_SIZE = 16;
		/** Stepper display fallbacks while the theme baselines have not been probed. */
		const FALLBACK_BODY_SIZE = 14;
		const FALLBACK_CODE_SIZE = 12;
		const clampFontSize = (value) => (typeof value === "number" && Number.isFinite(value) ? Math.round(Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, value))) : null);

		/** Dropdown presets; empty selection = system default, CUSTOM = free text. */
		const CUSTOM = "__custom__";
		const BODY_FONT_PRESETS = [
			"Inter", "Noto Sans SC", "Noto Sans CJK SC", "Source Han Sans SC",
			"HarmonyOS Sans SC", "MiSans", "PingFang SC", "Microsoft YaHei",
			"LXGW WenKai", "Sarasa Gothic SC", "IBM Plex Sans", "Roboto"
		];
		const CODE_FONT_PRESETS = [
			"JetBrains Mono", "Fira Code", "Cascadia Code", "Source Code Pro",
			"SF Mono", "Menlo", "Consolas", "IBM Plex Mono", "Maple Mono NF",
			"Sarasa Mono SC", "Liberation Mono"
		];

		/** Row styles (dft-* prefix, tokens mirrored from the settings rows). */
		const PLUGIN_CSS = [
			".dft-group{display:flex;flex-direction:column;gap:10px;padding:2px 2px 4px}",
			".dft-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}",
			".dft-field{display:flex;flex-direction:column;gap:6px;max-width:520px}",
			".dft-label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
			".dft-select{box-sizing:border-box;height:32px;max-width:520px;color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:0 8px;font-size:13px;font-family:inherit}",
			".dft-input{box-sizing:border-box;flex:1;min-width:0;height:32px;color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:0 10px;font-size:13px;font-family:inherit}",
			".dft-input:focus,.dft-select:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}",
			".dft-sizeRow{flex-direction:column;align-items:stretch;gap:6px;display:flex;max-width:520px}",
			".dft-stepper{align-items:center;gap:8px;display:flex}",
			".dft-step{box-sizing:border-box;width:28px;height:28px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;font-size:14px;line-height:1;cursor:pointer;font-family:inherit}",
			".dft-step:disabled{opacity:.4;cursor:default}",
			".dft-step:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}",
			".dft-sizeValue{color:var(--dsw-alias-label-primary);font-size:13px;min-width:40px;text-align:center;font-variant-numeric:tabular-nums}",
			".dft-preview{color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-family);margin-top:2px}",
			".dft-previewCode{margin-top:0}",
			".dft-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}"
		].join("\n");

		function injectFontCss() {
			document.querySelectorAll('style[data-plugin-css="dsh-plugin-font/ui.css"]').forEach((el) => el.remove());
			const tag = document.createElement("style");
			tag.dataset.plugin = name;
			tag.dataset.pluginCss = "dsh-plugin-font/ui.css";
			tag.textContent = PLUGIN_CSS;
			document.head.appendChild(tag);
		}

		/** Locale dictionaries for the settings row (zh is the key-set source of truth). */
		const zh = {
			"font.title": "界面字体",
			"font.body": "正文字体",
			"font.code": "代码字体",
			"font.default": "系统默认",
			"font.custom": "自定义…",
			"font.customPlaceholder": "输入系统已安装的字体名称",
			"font.size": "正文字号",
			"font.codeSize": "代码字号",
			"font.preview": "字体预览 Aa 中文 123",
			"font.previewCode": "代码预览 const x = 42",
			"font.hint": "正文字号与代码字号分别设置，未手动调整时跟随主题的系统字号；标题/表格按正文比例跟随，代码块/行内代码按代码比例跟随；仅影响文字（字号与行高），界面布局与图片不受影响。正文字体与代码字体也可分别选择，选择“系统默认”或清空自定义输入即恢复对应项"
		};
		const en = {
			"font.title": "UI fonts",
			"font.body": "Body font",
			"font.code": "Code font",
			"font.default": "System default",
			"font.custom": "Custom…",
			"font.customPlaceholder": "Type an installed font-family name",
			"font.size": "Body size",
			"font.codeSize": "Code size",
			"font.preview": "Preview Aa 中文 123",
			"font.previewCode": "Code preview const x = 42",
			"font.hint": "Body size and code size are independent and follow the theme's font-size setting until adjusted: headings/tables follow the body ratio, code blocks/inline code follow the code ratio. Text only (font-size and line-height) — layout and images are untouched. Body and code fonts also apply independently; “System default” or an empty custom input restores that item"
		};

		/** Mirror store for the settings row (the theme row pattern). */
		function createFontRowStore() {
			return defineStore({
				init: () => ({ family: "", codeFamily: "", fontSize: null, codeFontSize: null, natural: { body: null, code: null }, fonts: null, revision: -1 }),
				actions: {
					sync: (d, family, codeFamily, fontSize, codeFontSize, revision) => {
						if (revision <= d.revision) return;
						d.family = family;
						d.codeFamily = codeFamily;
						d.fontSize = fontSize;
						d.codeFontSize = codeFontSize;
						d.revision = revision;
					},
					setNatural: (d, body, code) => {
						d.natural = { body, code };
					},
					setFonts: (d, fonts) => {
						d.fonts = fonts;
					}
				}
			});
		}

		/** One dropdown picker: an options list + custom free text when "custom…" is chosen. */
		function FontPicker({ id, labelKey, value, options, t, onChange }) {
			const isCustom = value !== "" && !options.includes(value);
			return jsx("div", {
				className: "dft-field",
				children: [
					jsx("label", { className: "dft-label", htmlFor: id, children: t(labelKey) }),
					jsx("select", {
						id,
						className: "dft-select",
						value: isCustom ? CUSTOM : (value || ""),
						onChange: (e) => {
							const picked = e.target.value;
							if (picked === CUSTOM) return; /* reveal the custom input, keep current value */
							onChange(picked);
						},
						children: [
							jsx("option", { key: "", value: "", children: t("font.default") }),
							...options.map((font) => jsx("option", { key: font, value: font, children: font })),
							jsx("option", { key: CUSTOM, value: CUSTOM, children: t("font.custom") })
						]
					}),
					isCustom ? jsx("input", {
						className: "dft-input",
						type: "text",
						defaultValue: value,
						placeholder: t("font.customPlaceholder"),
						onBlur: (e) => {
							const typed = String(e.target.value || "").trim();
							if (typed === value) return;
							onChange(typed);
						}
					}) : null
				]
			});
		}

		/** Settings > General row: body + code font pickers. */
		function FontRow({ t, useStore, setFamily, setCodeFamily, setFontSize, setCodeFontSize }) {
			const s = useStore((st) => st);
			const bodyOptions = s.fonts ? s.fonts.families : BODY_FONT_PRESETS;
			const codeOptions = s.fonts ? (s.fonts.mono && s.fonts.mono.length ? s.fonts.mono : s.fonts.families) : CODE_FONT_PRESETS;
			/** null = follow the theme's content font-size axis (probed when ready). */
			const size = s.fontSize ?? s.natural?.body ?? FALLBACK_BODY_SIZE;
			const codeSize = s.codeFontSize ?? s.natural?.code ?? FALLBACK_CODE_SIZE;
			const stepper = (labelKey, value, onStep) => jsx("div", {
				className: "dft-sizeRow",
				children: [
					jsx("label", { className: "dft-label", children: t(labelKey) }),
					jsx("div", {
						className: "dft-stepper",
						children: [
							jsx("button", {
								type: "button",
								className: "dft-step",
								"aria-label": "−",
								disabled: value <= FONT_SIZE_MIN,
								onClick: () => { onStep(value - 1); },
								children: "−"
							}),
							jsx("span", { className: "dft-sizeValue", children: value + "px" }),
							jsx("button", {
								type: "button",
								className: "dft-step",
								"aria-label": "+",
								disabled: value >= FONT_SIZE_MAX,
								onClick: () => { onStep(value + 1); },
								children: "+"
							})
						]
					})
				]
			});
			return jsx("div", {
				className: "dft-group",
				children: [
					jsx("div", { className: "dft-title", children: t("font.title") }),
					jsx(FontPicker, { id: "dft-body-font", labelKey: "font.body", value: s.family || "", options: bodyOptions, t, onChange: setFamily }),
					jsx(FontPicker, { id: "dft-code-font", labelKey: "font.code", value: s.codeFamily || "", options: codeOptions, t, onChange: setCodeFamily }),
					stepper("font.size", size, setFontSize),
					jsx("div", {
						className: "dft-preview",
						style: { fontSize: size + "px", lineHeight: 1.6 },
						children: t("font.preview")
					}),
					stepper("font.codeSize", codeSize, setCodeFontSize),
					jsx("div", {
						className: "dft-preview dft-previewCode",
						style: { fontSize: codeSize + "px", lineHeight: 1.6, fontFamily: "var(--ds-font-family-code)" },
						children: t("font.previewCode")
					}),
					jsx("div", { className: "dft-hint", children: t("font.hint") })
				]
			});
		}

		function apply(ctx) {
			const store = createFontRowStore();
			let bound = null;
			let saveTimer = null;
			const state = { family: "", codeFamily: "", fontSize: null, codeFontSize: null, fonts: null, revision: -1 };
			let originalStacks = null;

			let markdownBaselines = null;
			const markdownVar = (suffix) => `--dsw-font-markdown-${suffix}`;

			/**
			 * Capture each markdown family's resolved size/line-height/weight/style
			 * by probing with the theme's own variables: computed longhands come back
			 * fully resolved, so any host-side derivation (calc(), var() chains, the
			 * min/max table formula) is resolved by the layout engine instead of a
			 * regex over the custom-property token stream. Families whose longhands
			 * do not resolve to finite px stay theme-controlled.
			 */
			const captureMarkdownBaselines = () => {
				const probe = document.createElement("div");
				probe.style.position = "absolute";
				probe.style.visibility = "hidden";
				probe.style.pointerEvents = "none";
				document.body.appendChild(probe);
				const baselines = {};
				try {
					for (const family of MARKDOWN_FONT_FAMILIES) {
						const ps = probe.style;
						ps.fontFamily = `var(${markdownVar(family)}-font-family)`;
						ps.fontSize = `var(${markdownVar(family)}-font-size)`;
						ps.lineHeight = `var(${markdownVar(family)}-line-height)`;
						ps.fontWeight = `var(${markdownVar(family)}-font-weight)`;
						ps.fontStyle = `var(${markdownVar(family)}-font-style)`;
						const cs = getComputedStyle(probe);
						const size = Number.parseFloat(cs.fontSize);
						const lh = Number.parseFloat(cs.lineHeight);
						if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(lh) || lh <= 0) continue;
						baselines[family] = {
							size,
							lh,
							weight: cs.fontWeight || "400",
							style: cs.fontStyle || "normal"
						};
					}
				} finally {
					probe.remove();
				}
				return baselines;
			};

			/** Probe once, lazily; false while the document is not ready. */
			const ensureBaselines = () => {
				if (markdownBaselines !== null) return true;
				try {
					markdownBaselines = captureMarkdownBaselines();
				} catch {
					return false;
				}
				return markdownBaselines !== null;
			};

			/** Publish the theme's natural sizes so the steppers can display "follow". */
			const pushNatural = () => {
				if (bound && markdownBaselines) {
					bound.setNatural(markdownBaselines.base ? markdownBaselines.base.size : null, markdownBaselines.code ? markdownBaselines.code.size : null);
				}
			};

			/** Desired px over natural px; unset (null) or unprobed means follow the theme. */
			const factorFor = (desired, base) => (typeof desired === "number" && base && base.size > 0 ? desired / base.size : 1);

			/**
			 * Text-only scale: restack the font tokens, then override the markdown
			 * font variables with scaled size/line-height (layout untouched — no
			 * zoom). Factor 1 removes the overrides so the theme (and its content
			 * font-size axis) controls the family again.
			 */
			const applyTypography = () => {
				const root = document.documentElement;
				const body = document.body;
				/* fonts always restacked (the composites embed the current families) */
				if (originalStacks === null) {
					let bodyStack = "";
					let codeStack = "";
					try {
						const cs = getComputedStyle(root);
						bodyStack = cs.getPropertyValue(BODY_FONT_VAR).trim();
						codeStack = cs.getPropertyValue(CODE_FONT_VAR).trim();
					} catch { /* pre-boot guard */ }
					originalStacks = { body: bodyStack || DEFAULT_BODY_STACK, code: codeStack || DEFAULT_CODE_STACK };
				}
				const restack = (fontVar, base, family) => {
					if (!family) {
						root.style.removeProperty(fontVar);
						return;
					}
					const sanitized = family.replace(/['"]/g, "").trim();
					if (!sanitized) {
						root.style.removeProperty(fontVar);
						return;
					}
					root.style.setProperty(fontVar, `'${sanitized}', ${base}`);
				};
				restack(BODY_FONT_VAR, originalStacks.body, state.family);
				restack(CODE_FONT_VAR, originalStacks.code, state.codeFamily);
				if (!ensureBaselines()) return;
				const bodyFactor = factorFor(state.fontSize, markdownBaselines.base);
				const codeFactor = factorFor(state.codeFontSize, markdownBaselines.code);
				const cs = getComputedStyle(body);
				const clearFamily = (family) => {
					body.style.removeProperty(markdownVar(family));
					body.style.removeProperty(markdownVar(`${family}-font-size`));
					body.style.removeProperty(markdownVar(`${family}-line-height`));
				};
				for (const family of MARKDOWN_FONT_FAMILIES) {
					const factor = CODE_FONT_FAMILIES.has(family) ? codeFactor : bodyFactor;
					const base = markdownBaselines[family];
					if (factor === 1 || !base) {
						clearFamily(family);
						continue;
					}
					const size = round1(base.size * factor);
					const lh = round1(base.lh * factor);
					/* families re-read per apply so a restacked --dsw-font-family lands */
					const currentFamily = cs.getPropertyValue(markdownVar(`${family}-font-family`)).trim();
					const style = base.style === "normal" ? "" : base.style + " ";
					const weight = base.weight === "400" ? "" : base.weight + " ";
					const composite = `${style}${weight}${size}px/${lh}px ${currentFamily || "inherit"}`;
					body.style.setProperty(markdownVar(`${family}-font-size`), `${size}px`);
					body.style.setProperty(markdownVar(`${family}-line-height`), `${lh}px`);
					body.style.setProperty(markdownVar(family), composite);
				}
			};

			const syncStore = () => {
				if (bound) bound.sync(state.family, state.codeFamily, state.fontSize, state.codeFontSize, state.revision);
			};

			/** Persist after a quiet period; failures are swallowed (next change retries). */
			const scheduleSave = () => {
				if (saveTimer) clearTimeout(saveTimer);
				saveTimer = setTimeout(() => {
					saveTimer = null;
					/* null sizes are omitted: absent keys mean "follow the theme" */
					const payload = { family: state.family, codeFamily: state.codeFamily };
					if (state.fontSize !== null) payload.fontSize = state.fontSize;
					if (state.codeFontSize !== null) payload.codeFontSize = state.codeFontSize;
					fetch("/font/config", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(payload)
					}).catch(() => { /* best-effort; the next change retries */ });
				}, 300);
			};

			/** Optimistically apply a user patch locally, then persist it. */
			const commit = (patch) => {
				let changed = false;
				if (patch.family !== undefined && patch.family !== state.family) {
					state.family = patch.family;
					changed = true;
				}
				if (patch.codeFamily !== undefined && patch.codeFamily !== state.codeFamily) {
					state.codeFamily = patch.codeFamily;
					changed = true;
				}
				if (patch.fontSize !== undefined) {
					const value = patch.fontSize === null ? null : clampFontSize(patch.fontSize);
					if (value !== state.fontSize) {
						state.fontSize = value;
						changed = true;
					}
				}
				if (patch.codeFontSize !== undefined) {
					const value = patch.codeFontSize === null ? null : clampFontSize(patch.codeFontSize);
					if (value !== state.codeFontSize) {
						state.codeFontSize = value;
						changed = true;
					}
				}
				if (!changed) return;
				state.revision += 1;
				applyTypography();
				syncStore();
				scheduleSave();
			};

			/** Restore the persisted config at startup (best effort). */
			const loadConfig = () => {
				fetch("/font/config")
					.then((response) => {
						if (!response.ok) return null;
						return response.json();
					})
					.then((config) => {
						if (!config || typeof config !== "object") return;
						let changed = false;
						if (typeof config.family === "string" && config.family !== state.family) {
							state.family = config.family;
							changed = true;
						}
						if (typeof config.codeFamily === "string" && config.codeFamily !== state.codeFamily) {
							state.codeFamily = config.codeFamily;
							changed = true;
						}
						/* null/absent = follow the theme's own content font-size axis */
						const desiredSize = typeof config.fontSize === "number"
							? clampFontSize(config.fontSize)
							: (typeof config.scale === "number" ? clampFontSize(Math.round(LEGACY_BASE_FONT_SIZE * config.scale)) : null);
						if (desiredSize !== state.fontSize) {
							state.fontSize = desiredSize;
							changed = true;
						}
						const desiredCodeSize = typeof config.codeFontSize === "number" ? clampFontSize(config.codeFontSize) : null;
						if (desiredCodeSize !== state.codeFontSize) {
							state.codeFontSize = desiredCodeSize;
							changed = true;
						}
						if (!changed) return;
						state.revision += 1;
						applyTypography();
						syncStore();
					})
					.catch(() => { /* host route may be absent until restart */ });
			};

			/** Fetch the installed-font catalog for the pickers (falls back to presets). */
			const fetchCatalog = () => {
				fetch("/font/list")
					.then((response) => (response.ok ? response.json() : null))
					.then((catalog) => {
						if (!catalog || catalog.ok !== true || !Array.isArray(catalog.families)) return;
						const fonts = { families: catalog.families, mono: Array.isArray(catalog.mono) ? catalog.mono : [] };
						state.fonts = fonts;
						if (bound) bound.setFonts(fonts);
					})
					.catch(() => { /* host route may be absent until restart */ });
			};

			const injected = (actions) => {
				bound = actions;
				syncStore();
				ensureBaselines();
				pushNatural();
				if (state.fonts) bound.setFonts(state.fonts);
				return {
					setFamily: (value) => { commit({ family: value }); },
					setCodeFamily: (value) => { commit({ codeFamily: value }); },
					setFontSize: (value) => { commit({ fontSize: value }); },
					setCodeFontSize: (value) => { commit({ codeFontSize: value }); }
				};
			};

			ctx.effect(() => ctx.locale.register(SETTINGS_LOCALE_NS, { zh, en }), "dsh-plugin-font: row dictionaries");
			ctx.effect(() => injectFontCss(), "dsh-plugin-font: row styles");
			ctx.effect(() => {
				ensureBaselines();
				pushNatural();
			}, "dsh-plugin-font: theme baselines");
			ctx.effect(() => () => {
				if (saveTimer) clearTimeout(saveTimer);
				document.documentElement.style.removeProperty(BODY_FONT_VAR);
				document.documentElement.style.removeProperty(CODE_FONT_VAR);
				const body = document.body;
				for (const family of MARKDOWN_FONT_FAMILIES) {
					body.style.removeProperty(markdownVar(family));
					body.style.removeProperty(markdownVar(`${family}-font-size`));
					body.style.removeProperty(markdownVar(`${family}-line-height`));
				}
			}, "dsh-plugin-font: teardown");
			loadConfig();
			fetchCatalog();
			ctx.slots.inject("settings.general.item", () => ctx.slots.register({
				name: "settings.general.item",
				id: "ui-font",
				order: 21,
				store,
				locale: SETTINGS_LOCALE_NS,
				inject: injected
			}, FontRow));
		}

		exports.name = name;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

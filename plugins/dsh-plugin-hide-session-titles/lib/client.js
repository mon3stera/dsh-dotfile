/**
 * Browser half of dsh-plugin-hide-session-titles. Hand-written client bundle
 * in the DSH client-modules format (window.__ModuleLoader__.load CJS factory).
 *
 * Features:
 *  - a small eye toggle button inserted into the left workspace header, just
 *    left of the existing search button (the workspace search slot is a flex
 *    row, so an inserted sibling lands right next to it),
 *  - toggling hides/shows the session titles in the workspace rows (CSS
 *    targets the css-modules class suffixes, which are stable across builds
 *    — the generated hash prefix is ignored),
 *  - state persisted through the plugin-owned $DSH_HOME/session-titles/
 *    config.json, so the choice survives restarts.
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-hide-session-titles",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const name = "dsh-plugin-hide-session-titles";
		const inject = [];

		const BTN_ID = "dsh-hide-titles-toggle";
		const TITLE_ATTR = "data-dsh-hide-titles";

		const EYE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
		const EYE_OFF_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

		const PLUGIN_CSS = [
			`.${BTN_ID}{box-sizing:border-box;flex:none;width:28px;height:28px;color:inherit;background:transparent;border:none;border-radius:8px;padding:0;margin-left:auto;margin-right:4px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}`,
			`.${BTN_ID}:hover{background:var(--dsw-alias-interactive-bg-hover)}`,
			`.${BTN_ID} svg{width:14px;height:14px}`,
			`.${BTN_ID}[data-active="true"]{color:var(--dsw-alias-state-business-primary)}`,
			/* the button lives in the section header (left of the search slot); the slot's
			 * own margin-left:auto is neutralized so this button's auto margin pushes the
			 * whole right cluster (button + search + view options) to the edge */
			`html [class$="_searchSlot"]{margin-left:0}`,
			/* rail (collapsed) mode shows icons only; the workspace search slot is absent anyway */
			`[class$="_rail"] .${BTN_ID}{display:none}`,
			/* mask session-row titles with a placeholder (box size stays, so the
			 * row and its meta stay aligned; class suffixes are stable across builds) */
			`[${TITLE_ATTR}="on"] [class$="_sessionRow"] [class$="_title"]{visibility:hidden;position:relative}`,
			`[${TITLE_ATTR}="on"] [class$="_sessionRow"] [class$="_title"]::after{content:"[MASKED]";visibility:visible;position:absolute;inset:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}`
		].join("\n");

		function injectCss() {
			document.querySelectorAll(`style[data-plugin-css="${name}/ui.css"]`).forEach((el) => el.remove());
			const tag = document.createElement("style");
			tag.dataset.plugin = name;
			tag.dataset.pluginCss = `${name}/ui.css`;
			tag.textContent = PLUGIN_CSS;
			document.head.appendChild(tag);
		}

		function apply(ctx) {
			injectCss();
			const state = { hidden: false, revision: -1 };
			let button = null;
			let observer = null;
			let saveTimer = null;

			const syncButton = () => {
				if (!button) return;
				button.setAttribute("aria-pressed", String(state.hidden));
				button.setAttribute("data-active", String(state.hidden));
				button.title = state.hidden ? "显示会话标题 / Show session titles" : "隐藏会话标题 / Hide session titles";
				button.innerHTML = state.hidden ? EYE_OFF_ICON : EYE_ICON;
			};

			/** Push the toggle into the DOM (html attribute drives the CSS rule). */
			const applyHidden = () => {
				document.documentElement.setAttribute(TITLE_ATTR, state.hidden ? "on" : "off");
				syncButton();
			};

			/** Persist after a quiet period; failures are swallowed (next change retries). */
			const scheduleSave = () => {
				if (saveTimer) clearTimeout(saveTimer);
				saveTimer = setTimeout(() => {
					saveTimer = null;
					fetch("/session-titles/config", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ hidden: state.hidden })
					}).catch(() => { /* best-effort; the next change retries */ });
				}, 300);
			};

			const toggle = () => {
				state.hidden = !state.hidden;
				state.revision += 1;
				applyHidden();
				scheduleSave();
			};

			/** Insert the toggle button into the section header, left of the search slot. */
			const injectButton = () => {
				if (button) return true;
				const slot = document.querySelector('[class$="_searchSlot"]');
				if (!slot) return false;
				const header = slot.parentElement;
				if (!header) return false;
				const btn = document.createElement("button");
				btn.type = "button";
				btn.id = BTN_ID;
				btn.className = BTN_ID;
				btn.setAttribute("aria-label", "Toggle session titles");
				btn.addEventListener("click", toggle);
				header.insertBefore(btn, slot);
				button = btn;
				syncButton();
				return true;
			};

			/** The workspace header mounts lazily and re-renders; keep the button in place. */
			const ensureObserver = () => {
				if (observer || typeof MutationObserver === "undefined") return;
				observer = new MutationObserver(() => {
					const slot = document.querySelector('[class$="_searchSlot"]');
					if (slot && !button) injectButton();
					else if (!slot && button) {
						button.remove();
						button = null;
					}
				});
				observer.observe(document.body, { childList: true, subtree: true });
			};

			/** Restore the persisted toggle at startup (best effort). */
			const loadConfig = () => {
				fetch("/session-titles/config")
					.then((response) => (response.ok ? response.json() : null))
					.then((config) => {
						if (!config || typeof config !== "object" || typeof config.hidden !== "boolean") return;
						if (config.hidden === state.hidden) return;
						state.hidden = config.hidden;
						state.revision += 1;
						applyHidden();
					})
					.catch(() => { /* host route may be absent until restart */ });
			};

			ctx.effect(() => () => {
				if (observer) observer.disconnect();
				if (button) button.remove();
				document.documentElement.removeAttribute(TITLE_ATTR);
				if (saveTimer) clearTimeout(saveTimer);
			}, `${name}: teardown`);

			applyHidden();
			injectButton();
			ensureObserver();
			loadConfig();
		}

		exports.name = name;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

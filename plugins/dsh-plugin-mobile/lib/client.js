// Browser half of dsh-plugin-mobile: make the Web shell usable on a phone.
//
// The shell is not unresponsive - `@deepseek-ai/dsh-client-ui-layout` tracks the
// frame width with a ResizeObserver and auto-collapses the sidebar to its rail
// below `SIDEBAR_AUTO_COLLAPSE` (1024px). What it does not adapt is the geometry
// that survives the collapse, because all three columns stay in grid flow at
// every width:
//
//   * Expanding the sidebar squeezes the centre column instead of covering it.
//     `computeColumns` clamps an open sidebar to at least 264px, so a 390px
//     screen is left with ~110px of conversation behind the sidebar - and every
//     open/close reflows the whole message list.
//   * The 8px column drag handles carry `touch-action: none`. Without a pointer
//     they cannot be used, but they still swallow vertical swipes in two thin
//     bands.
//   * Transcript overscroll is handed to the shell, so a flick at either end
//     rubber-bands the whole page instead of stopping in the transcript.
//
// Two further phone defects were expected here and measured away instead, which
// is why no rule addresses them. Reading a bundle is not evidence:
//
//   * A composer font under iOS's 16px focus-zoom threshold. The composer input
//     is `font-size: inherit` and its whole ancestor chain computes 16px; the
//     13px `--dsw-font-xs-13` seen in the same bundle belongs to a different
//     editor. Chrome at 390px reports 16px with this plugin disabled.
//   * A conversation inset derived from `--dsh-composer-side-clearance`. That
//     custom property is not defined anywhere in this build (it computes empty
//     on both `:root` and `body`), and the widest padded node inside the
//     scrollport is a hashed composer class with a hardcoded `padding: 0 24px`.
//     Overriding the token changed nothing, and reclaiming that inset would mean
//     selecting a per-build hash.
//
// Everything that remains is keyed on host contracts that survive a rebuild:
// declared slots and `data-*` hooks. CSS module class names are hashed per build
// (`pI_x6G_frame`) and are never selected. The frame itself is identified as the
// element whose direct child is the declared `shell.overlay` outlet, which is
// what the frame is by construction.
window.__ModuleLoader__.load({
	id: "dsh-plugin-mobile",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const { jsx } = require("react/jsx-runtime");

		const NS = "dsh-plugin-mobile";
		const inject = ["slots", "locale", "layout"];

		// Phone territory only. The host is already "narrow" below 1024px, but a
		// 768px tablet keeps a 488px conversation with the sidebar open, which
		// needs none of this. Staying a strict subset of the host's narrow mode
		// means the drawer rules can rely on `data-sidebar-collapsed` tracking
		// `narrowExpanded` rather than the width preference.
		const PHONE_MAX = 640;

		// The frame: the element whose direct child is the shell.overlay outlet.
		const FRAME = `div:has(> [data-shell-overlay])`;

		const zh = { dismiss: "关闭导航" };
		const en = { dismiss: "Close navigation" };

		const CSS = [
			`@media (max-width:${PHONE_MAX}px){`,

			// 1. Drop the column drag handles. They are pointer-only affordances
			// (`cursor:col-resize`) and their `touch-action:none` bands otherwise
			// eat vertical swipes at the column seams.
			`${FRAME}>[data-side]{display:none!important}`,

			// 2. Keep momentum scrolling inside the transcript instead of handing
			// the overscroll to the shell.
			`[data-conversation-scroll]{overscroll-behavior:contain}`,

			// 3. Turn an expanded sidebar into a drawer. Below the host's
			// auto-collapse width `data-sidebar-collapsed` is absent exactly while
			// the narrow override is on, so this state is "the user opened the
			// sidebar on a phone". The sidebar's track collapses to zero and its
			// content is allowed to paint outside it, over the conversation.
			//
			// The column must stay IN grid flow. Taking it out with
			// `position:absolute` shifts every remaining item one track to the
			// left, which hands the 1fr track to the details column and leaves the
			// conversation zero pixels wide - measured in Chrome at 390px:
			// `grid-template-columns: 0 390 0` with a 0px centre column. Keeping
			// `position:relative` preserves placement while still creating the
			// stacking context the drawer needs above the scrim.
			//
			// The drawer's own width is whatever the host renders the sidebar at
			// (it keeps passing the computed width as a slot prop regardless of the
			// track), so no second hardcoded number appears here. The inline
			// `grid-template-columns` needs `!important` to be overridden.
			`${FRAME}:not([data-sidebar-collapsed]){grid-template-columns:0 minmax(0,1fr) 0!important}`,
			`${FRAME}:not([data-sidebar-collapsed])>:first-child{`
				+ `position:relative;z-index:25;overflow:visible;`
				+ `box-shadow:0 18px 48px rgb(0 0 0/.45)}`,

			// The scrim occupies the declared overlay layer (z-index 20), so it
			// covers the conversation and stays under the drawer (25). Visibility
			// is pure CSS keyed on the same attribute, so nothing mirrors layout
			// state into this plugin.
			`.${NS}-scrim{position:absolute;inset:0;border:none;padding:0;`
				+ `background:rgb(0 0 0/.45);opacity:0;pointer-events:none;`
				+ `transition:opacity var(--ds-transition-duration-slow,.2s) ease}`,
			`${FRAME}:not([data-sidebar-collapsed]) .${NS}-scrim{opacity:1;pointer-events:auto}`,

			`}`,
		].join("\n");

		/**
		 * Tap-outside-to-close for the phone drawer.
		 *
		 * Kept out of the tab order: the sidebar's own toggle button is the
		 * keyboard path, and a viewport-sized focus stop ahead of it would be
		 * noise. Pointer users get the affordance they expect from a drawer.
		 *
		 * @param props - composed slot props.
		 * @returns the scrim element.
		 */
		function MobileScrim({ dismiss, t }) {
			return jsx("button", {
				type: "button",
				className: `${NS}-scrim`,
				tabIndex: -1,
				"aria-label": t("dismiss"),
				onClick: dismiss,
			});
		}

		/**
		 * Install the phone stylesheet and the drawer scrim.
		 *
		 * @param ctx - client plugin context.
		 */
		function apply(ctx) {
			const style = document.createElement("style");
			style.dataset.plugin = NS;
			style.dataset.pluginCss = `${NS}/ui.css`;
			style.textContent = CSS;
			document.head.appendChild(style);
			ctx.effect(() => () => style.remove(), `${NS}: styles`);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${NS}: locale`);

			// `toggleSidebar` throws while the root entry has not attached its
			// store actions. A scrim tap must never surface as an unhandled error,
			// and the drawer is still closable from its own toggle.
			const dismiss = () => {
				try {
					ctx.layout.toggleSidebar();
				} catch (_panelsNotWired) {
					// The frame owns the sidebar; nothing to do from here.
				}
			};

			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "mobile-scrim",
				locale: NS,
				inject: () => ({ dismiss }),
			}, MobileScrim));
		}

		exports.name = NS;
		exports.inject = inject;
		exports.apply = apply;
		exports.CSS = CSS;
		exports.PHONE_MAX = PHONE_MAX;
		exports.FRAME = FRAME;
		exports.MobileScrim = MobileScrim;
		return module.exports;
	},
});

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
//   * A wide markdown table is clipped by the transcript's `overflow: hidden`:
//     measured with a probe table, 872px of content inside a 326px scrollport,
//     with no way to reach the cut-off columns.
//   * The settings dialog is an 800px flex row - a 188px nav plus a `flex: 1`
//     content pane. At 390px the panel is 342px wide, which leaves the content
//     154px and wraps CJK text one character per line.
//   * An open details panel is invisible below 996px. `computeColumns` keeps
//     the details track inline only while `56 (rail) + 300 (details min) +
//     640 (centre min)` fits; below that bound it always returns
//     `details: 0`, and `.pI_x6G_detailsCol` has `overflow: hidden`, so the
//     panel is clipped away entirely - its close button sits off-screen at
//     x=411 on a 390px viewport.
//   * The served viewport meta carries no `interactive-widget` key. Android
//     Chrome's default `resizes-visual` overlays the virtual keyboard on the
//     layout viewport, which hides a bottom-anchored composer while typing.
//
// Three further phone defects were expected here and measured away instead,
// which is why no rule addresses them. Reading a bundle is not evidence:
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
//   * Hover-gated message actions. The host styles every `:hover` rule in the
//     conversation bundle as a colour change, and the only hover-gated reveal
//     (message timestamps) is already wrapped in `@media (hover:hover)`, so
//     touch users lose nothing.
//
// Everything that remains is keyed on host contracts that survive a rebuild:
// declared slots, `data-*` hooks, and structural positions. CSS module class
// names are hashed per build (`pI_x6G_frame`) and are never selected. The frame
// itself is identified as the element whose direct child is the declared
// `shell.overlay` outlet, which is what the frame is by construction.
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

		// Details overlay bound. `computeColumns` keeps an open details panel
		// inline only while `56 + 300 + 640` fits the viewport; at 996px and up
		// the host lays the panel out itself, and this plugin must not touch it.
		const DETAILS_MAX = 995;

		// The frame: the element whose direct child is the shell.overlay outlet.
		const FRAME = `div:has(> [data-shell-overlay])`;

		// The details column: the third child of the frame (sidebar, centre,
		// details, then the absolutely positioned overlay outlet, which never
		// participates in the grid flow). Taking the LAST in-flow column out of
		// the grid with `position:absolute` shifts nothing - unlike the sidebar,
		// where the centre and details columns follow it and an absolute
		// position moved every remaining item one track left.
		const DETAILS_COL = `${FRAME}>:nth-child(3)`;

		// Set on <html> by the layout-service wrapper in apply() while the
		// details panel is open. The frame's own `data-details-collapsed`
		// attribute keys on the computed track (`cols.details === 0`), which is
		// always true below 996px whether the user opened details or not, so it
		// cannot drive the overlay on a phone.
		const DETAILS_OPEN = `[data-dsh-plugin-mobile-details="open"]`;

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

			// 4. Wide markdown tables scroll within themselves. The transcript
			// scrollport clips at `overflow:hidden`, so without this a table wider
			// than the column loses its right-hand columns for good. `display:
			// block` + `overflow-x:auto` is the standard containment pattern;
			// `width:fit-content` keeps narrow tables at their natural size. The
			// selector deliberately does not reach the details panel, which lives
			// outside `[data-conversation-scroll]` and already scrolls its own
			// panes.
			`[data-conversation-scroll] table{`
				+ `display:block;width:fit-content;max-width:100%;overflow-x:auto}`,

			// 5. Settings dialog: stack it. The host panel is an 800px flex row
			// (a 188px nav plus a `flex:1` content pane) inside a
			// `max-width:calc(100vw - 48px)` shell, so on a 390px screen the
			// content pane gets 154px and CJK text wraps one character per line.
			// The dialog is identified through the declared `sidebar.settings`
			// slot outlet and its `role=dialog` panel - never a hashed class. The
			// specificity of the attribute selector (0,2,0) beats every host rule
			// here (0,1,0), so no `!important` is needed. Height switches the
			// host's `100vh` (the large-viewport height on Android Chrome, which
			// overflows under the URL bar) to `100dvh`; on engines without `dvh`
			// the declaration is dropped and the host value survives.
			`[data-slot="sidebar.settings"] [role="dialog"]{`
				+ `flex-direction:column;height:min(800px,100dvh - 48px)}`,
			`[data-slot="sidebar.settings"] [role="dialog"]>nav{`
				+ `width:auto;flex:none;padding:10px 12px 0}`,
			`[data-slot="sidebar.settings"] [role="dialog"]>nav>div+div{`
				+ `flex-direction:row;overflow-x:auto}`,
			`[data-slot="sidebar.settings"] [role="dialog"]>nav+div{min-height:0}`,

			`}`,

			// 6. Details overlay below the host's inline-layout bound. When the
			// layout service reports an open details panel at these widths, the
			// host still computes a 0px track, so the column is promoted to a
			// right-hand overlay at the service's own preferred width (360px,
			// the value `openDetails` stores). The close button travels with the
			// panel and clears the state through the same service.
			`@media (max-width:${DETAILS_MAX}px){`,
			`${DETAILS_OPEN} ${DETAILS_COL}{`
				+ `position:absolute;top:0;bottom:0;right:0;width:min(360px,100vw);`
				+ `z-index:25;box-shadow:-12px 0 40px rgb(0 0 0/.45)}`,
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
		 * Track the details panel through the layout service face.
		 *
		 * Every host caller - the tool rows in the conversation bundle and the
		 * session runner - opens and closes details through this same service
		 * object, so wrapping the two actions observes all of them. The wrapper
		 * only flips the `<html>` attribute the stylesheet keys on; the store
		 * actions themselves run untouched.
		 *
		 * @param ctx - client plugin context.
		 */
		function trackDetails(ctx) {
			const layout = ctx.layout;
			if (!layout || typeof layout.openDetails !== "function" || typeof layout.closeDetails !== "function") return;
			const openDetails = layout.openDetails;
			const closeDetails = layout.closeDetails;
			const mark = (open) => {
				const root = document.documentElement;
				if (open) root.setAttribute("data-dsh-plugin-mobile-details", "open");
				else root.removeAttribute("data-dsh-plugin-mobile-details");
			};
			layout.openDetails = (...args) => {
				mark(true);
				return openDetails.apply(layout, args);
			};
			layout.closeDetails = (...args) => {
				mark(false);
				return closeDetails.apply(layout, args);
			};
			ctx.effect(() => () => {
				layout.openDetails = openDetails;
				layout.closeDetails = closeDetails;
				mark(false);
			}, `${NS}: details tracking`);
		}

		/**
		 * Ask Android Chrome to resize the layout viewport for the keyboard.
		 *
		 * Chrome 108+ honours `interactive-widget` in the viewport meta; the
		 * default `resizes-visual` overlays the keyboard on the layout viewport,
		 * which hides a bottom-anchored composer while typing.
		 * `resizes-content` shrinks the layout viewport instead, so the shell
		 * reflows above the keyboard. Only set when absent: an explicit host
		 * choice must win. The change is global rather than phone-scoped
		 * because it only takes effect while a virtual keyboard is open, which
		 * is exactly the surface it fixes.
		 *
		 * @returns true when the meta was extended.
		 */
		function applyKeyboardViewport() {
			const meta = document.querySelector('meta[name="viewport"]');
			if (!meta || meta.content.includes("interactive-widget=")) return false;
			meta.content = `${meta.content.trim()}, interactive-widget=resizes-content`;
			return true;
		}

		/**
		 * Install the phone stylesheet, the keyboard viewport fix, the details
		 * tracking, and the drawer scrim.
		 *
		 * @param ctx - client plugin context.
		 */
		function apply(ctx) {
			applyKeyboardViewport();
			trackDetails(ctx);

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
		exports.DETAILS_MAX = DETAILS_MAX;
		exports.FRAME = FRAME;
		exports.DETAILS_COL = DETAILS_COL;
		exports.DETAILS_OPEN = DETAILS_OPEN;
		exports.MobileScrim = MobileScrim;
		exports.applyKeyboardViewport = applyKeyboardViewport;
		exports.trackDetails = trackDetails;
		return module.exports;
	},
});

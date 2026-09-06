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
//   * The collapsed sidebar survives as a 56px rail that a phone never has
//     room for (`computeColumns` keeps `sidebar: 56` for a closed preference).
//     On a phone the rail is hidden entirely - the same track collapse the
//     drawer uses, keyed on the opposite attribute - and a floating button
//     opens it as the drawer instead.
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

		const { jsx, jsxs } = require("react/jsx-runtime");

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

		const zh = { dismiss: "关闭导航", open: "打开导航", addImages: "添加图片" };
		const en = { dismiss: "Close navigation", open: "Open navigation", addImages: "Add images" };

		// Inline photo icon: rounded frame, sun, mountain ridge.
		const IMAGE_ICON = jsxs("svg", {
			viewBox: "0 0 24 24",
			width: 18,
			height: 18,
			fill: "none",
			stroke: "currentColor",
			strokeWidth: 1.8,
			strokeLinecap: "round",
			strokeLinejoin: "round",
			"aria-hidden": true,
			children: [
				jsx("rect", { x: 3, y: 3, width: 18, height: 18, rx: 3 }),
				jsx("circle", { cx: 8.5, cy: 8.5, r: 1.5 }),
				jsx("path", { d: "m21 15-4.5-4.5L6 21" }),
			],
		});

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

			// 3b. Hide the collapsed rail entirely. `computeColumns` answers a
			// closed sidebar preference with a 56px rail track on every width,
			// which a phone has no room for. The same track collapse the drawer
			// uses, keyed on the opposite attribute: the track drops to zero and
			// the rail's own `min-width:0;overflow:hidden` clips its content away,
			// so no per-build class or inline width is fought here. The column
			// stays in grid flow for the same measured reason as above.
			// `visibility:hidden` additionally removes the rail's border line and
			// its buttons from hit-testing and the tab order; the FAB below is
			// the opening path.
			`${FRAME}[data-sidebar-collapsed]{grid-template-columns:0 minmax(0,1fr) 0!important}`,
			`${FRAME}[data-sidebar-collapsed]>:first-child{visibility:hidden}`,

			// 3c. The floating button that opens the drawer. Rendered in the same
			// overlay layer as the scrim, shown only on a phone while the sidebar
			// is collapsed. The base rule lives outside both media blocks so the
			// button is inert on every wide viewport, and the phone block only
			// un-hides it under the collapsed attribute - which is absent while
			// the drawer is open, exactly when the scrim takes over dismissal.
			//
			// The bottom edge is anchored to the composer's live top edge, not a
			// constant: the composer card grows with its content and the system
			// font scale, so fixed offsets measured correct on one device and
			// embedded the button in the input box on another (96px and 148px
			// each failed on a real phone). trackFabAnchor() publishes the
			// frame-to-composer-seat distance as a custom property; 148px is
			// only the fallback for engines without a ResizeObserver.
			`.${NS}-fab{position:absolute;right:16px;`
				+ `bottom:var(--dsh-plugin-mobile-fab-bottom,148px);`
				+ `width:44px;height:44px;display:none;align-items:center;justify-content:center;`
				+ `padding:0;border:.5px solid var(--dsw-alias-border-l3,rgb(128 128 128/.4));`
				+ `border-radius:50%;background:var(--dsw-alias-bg-layer-1,#202024);`
				+ `color:var(--dsw-alias-label-primary,#fff);`
				+ `box-shadow:0 6px 20px rgb(0 0 0/.4);pointer-events:auto;cursor:pointer;`
				+ `z-index:1;-webkit-tap-highlight-color:transparent}`,
			`${FRAME}[data-sidebar-collapsed] .${NS}-fab{display:flex}`,

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

			// 5b. Hide the header's utility band. Session log download, the
			// outline trigger, and the diff-viewer trigger all register into the
			// declared `conversation.session.header.utilities` list slot, and at
			// phone width they crowd the title row until the preset label, the
			// session-id chip, and the buttons overlap (measured on a real
			// session at 390px). A phone starts tasks and reads answers; all
			// three utilities are inspectable on a desktop, so the whole band is
			// hidden through the renderer's stable `data-slot` outlet attribute
			// - the same hook the settings rule above keys on. The outlets carry
			// `display:contents` as an INLINE style, so only `!important`
			// outranks it.
			`[data-slot="conversation.session.header.utilities"]{display:none!important}`,

			// 6. Compact the model trigger. The host button renders the full			// "GLM-5.3-Flash High" label inline; with the command, permission,
			// context-meter, and send controls the tool row totals ~358px at
			// 390px, so a 360px device (or any system font scaling) wraps the
			// model, context meter, and send onto a second row. The label and
			// effort spans are addressed structurally (button > span) inside
			// the declared model outlet and replaced by a fixed short label;
			// the button's own aria-label still names the current model and
			// level for assistive tech. Tapping still opens the host's own
			// floating picker menu (role=menu, ~248px wide, fits a phone) -
			// model plus reasoning level in one surface, which is exactly the
			// floating-panel flow, so no second picker is built here. The picker
			// menu renders INSIDE the outlet, so the rule must not match its
			// items: the trigger is the only button carrying `aria-haspopup`,
			// which is the precise hook.
			`[data-slot="conversation.input.model"] button[aria-haspopup="menu"] span{display:none}`,
			`[data-slot="conversation.input.model"] button[aria-haspopup="menu"]::before{content:"模型"}`,

			// 7. The phone image button. The host admits draft images through
			// paste and document drop on desktop, neither of which exists as a
			// gesture on a phone; this button opens the platform file picker
			// and routes the files into the stock intake (see
			// intakeImageFiles). The phone rule outranks the inert base with an
			// element selector (`button.` = 0,1,1 over 0,1,0): the base sits at
			// the stylesheet tail, so a same-specificity rule here would lose
			// to it - unlike the FAB, whose show rule carries attribute
			// selectors. 28px matches the tool row's other icon controls.
			`button.${NS}-image{display:inline-flex;align-items:center;justify-content:center;`
				+ `width:28px;height:28px;padding:0;border:none;background:none;`
				+ `color:var(--dsw-alias-label-secondary,#999);cursor:pointer;`
				+ `-webkit-tap-highlight-color:transparent}`,

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

			// 7. The FAB's inert base, outside every media block: on a wide
			// viewport the button must not render at all, so `display:none` is
			// its only out-of-phone rule and the phone block owns the un-hide.
			`.${NS}-fab{display:none}`,

			// 8. The image button's inert base, same reasoning as the FAB.
			`.${NS}-image{display:none}`,
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
		 * The floating button that opens the drawer on a phone.
		 *
		 * Unlike the scrim this is a real control, so it stays in the tab
		 * order and carries its own label. Visibility is pure CSS: hidden
		 * everywhere, un-hidden on a phone only while `data-sidebar-collapsed`
		 * is present - i.e. exactly while the drawer is closed.
		 *
		 * @param props - composed slot props.
		 * @returns the FAB element.
		 */
		function MobileFab({ open, t }) {
			return jsx("button", {
				type: "button",
				className: `${NS}-fab`,
				"aria-label": t("open"),
				onClick: open,
				children: jsx("svg", {
					viewBox: "0 0 24 24",
					width: 22,
					height: 22,
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 2,
					strokeLinecap: "round",
					"aria-hidden": true,
					children: jsx("path", { d: "M4 6h16M4 12h16M4 18h16" }),
				}),
			});
		}

		/**
		 * Hand files to the stock draft-image intake.
		 *
		 * The attachment presentation owns the only file-admission path: it
		 * listens for document-level `drop` events carrying Files and forwards
		 * them to the composer's validation (`onAddImages`), so limits, the
		 * draft rail, and removal all stay the host's. A synthetic drop
		 * dispatched on `document` therefore rides the exact desktop path - a
		 * real drop needs no trust flag, and every guard (busy phase, size,
		 * dimensions, per-message count) applies unchanged.
		 *
		 * @param files - picked image files.
		 */
		function intakeImageFiles(files) {
			if (files.length === 0 || typeof DataTransfer === "undefined" || typeof DragEvent === "undefined") return;
			const transfer = new DataTransfer();
			for (const file of files) transfer.items.add(file);
			document.dispatchEvent(new DragEvent("drop", {
				dataTransfer: transfer,
				bubbles: true,
				cancelable: true,
			}));
		}

		/**
		 * The phone image button.
		 *
		 * The host admits images through paste and document drop on desktop -
		 * neither gesture exists on a phone, so images were unreachable there.
		 * This opens a file picker and routes the result through
		 * {@link intakeImageFiles}. Hidden everywhere by CSS; the phone block
		 * is the only scope that shows it.
		 *
		 * @param props - composed slot props.
		 * @returns the picker button element.
		 */
		function MobileImagePicker({ t }) {
			return jsx("button", {
				type: "button",
				className: `${NS}-image`,
				"aria-label": t("addImages"),
				onClick: () => {
					const input = document.createElement("input");
					input.type = "file";
					input.accept = "image/*";
					input.multiple = true;
					input.style.display = "none";
					const gone = () => input.remove();
					input.addEventListener("change", () => {
						gone();
						intakeImageFiles([...(input.files ?? [])]);
					});
					input.addEventListener("cancel", gone);
					document.body.appendChild(input);
					input.click();
				},
				children: IMAGE_ICON,
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
		 * Publish the FAB's bottom offset as a custom property on <html>.
		 *
		 * The composer is not a sibling below the transcript: it renders inside
		 * the scroll container as the sticky `[data-composer-seat]` (measured:
		 * the scrollport's own bottom equals the frame bottom, so the
		 * scrollport is useless as an anchor). The seat's TOP edge is the
		 * composer's live top, whatever height the card currently is, and the
		 * attribute is a declared host hook. The offset is that edge minus a
		 * 12px gap, measured from the frame bottom (the overlay outlet is
		 * `inset:0`, so its bottom is the frame's).
		 *
		 * Re-measured by a ResizeObserver on the seat (composer growth),
		 * window resizes, capture-phase scroll (sticky transitions, session
		 * switches, streaming), and a bounded rAF retry while the app is still
		 * mounting - the first frames see neither the frame nor the seat.
		 *
		 * @returns a disposer uninstalling the observers and the property.
		 */
		function trackFabAnchor() {
			const VAR = "--dsh-plugin-mobile-fab-bottom";
			if (typeof ResizeObserver === "undefined" || typeof requestAnimationFrame === "undefined") {
				return () => {};
			}

			const GAP = 12;
			const SEAT = "[data-composer-seat]";
			const MAX_MOUNT_TICKS = 600;
			let observedSeat = null;
			let wired = false;
			let ticks = 0;

			const sync = () => {
				const frame = document.querySelector(FRAME);
				const seat = document.querySelector(SEAT);
				if (!frame || !seat) return;
				if (seat !== observedSeat) {
					if (observedSeat) observer.unobserve(observedSeat);
					observer.observe(seat);
					observedSeat = seat;
				}
				const bottom = frame.getBoundingClientRect().bottom
					- seat.getBoundingClientRect().top + GAP;
				document.documentElement.style.setProperty(VAR, `${Math.max(0, Math.round(bottom))}px`);
				wired = true;
			};

			const observer = new ResizeObserver(sync);

			const tick = () => {
				ticks += 1;
				sync();
				if (!wired && ticks < MAX_MOUNT_TICKS) requestAnimationFrame(tick);
			};

			tick();
			window.addEventListener("resize", sync);
			// Passive and capture: never blocks a scroll, and sees the
			// transcript's own scroller wherever it is in the tree.
			document.addEventListener("scroll", sync, { passive: true, capture: true });

			return () => {
				wired = true;
				observer.disconnect();
				window.removeEventListener("resize", sync);
				document.removeEventListener("scroll", sync, { capture: true });
				document.documentElement.style.removeProperty(VAR);
			};
		}

		/**
		 * Install the phone stylesheet, the keyboard viewport fix, the details
		 * tracking, the drawer scrim and FAB, and the FAB's composer anchor.
		 *
		 * @param ctx - client plugin context.
		 */
		function apply(ctx) {
			applyKeyboardViewport();
			trackDetails(ctx);
			ctx.effect(trackFabAnchor, `${NS}: fab anchor`);

			const style = document.createElement("style");
			style.dataset.plugin = NS;
			style.dataset.pluginCss = `${NS}/ui.css`;
			style.textContent = CSS;
			document.head.appendChild(style);
			ctx.effect(() => () => style.remove(), `${NS}: styles`);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${NS}: locale`);

			// `toggleSidebar` throws while the root entry has not attached its
			// store actions. Neither overlay tap - scrim or FAB - must surface
			// that as an unhandled error, and the drawer stays closable from
			// its own toggle either way.
			const toggleDrawer = () => {
				try {
					ctx.layout.toggleSidebar();
				} catch (_panelsNotWired) {
					// The frame owns the sidebar; nothing to do from here.
				}
			};

			ctx.slots.inject("shell.overlay", () => {
				ctx.slots.register({
					name: "shell.overlay",
					id: "mobile-scrim",
					locale: NS,
					inject: () => ({ dismiss: toggleDrawer }),
				}, MobileScrim);

				ctx.slots.register({
					name: "shell.overlay",
					id: "mobile-fab",
					locale: NS,
					inject: () => ({ open: toggleDrawer }),
				}, MobileFab);
			});

			// The composer tool row's left list slot: the phone-only image
			// picker. A list slot, so no priority is involved and the host's
			// own occupants are untouched.
			ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
				name: "conversation.input.left",
				id: "mobile-image",
				locale: NS,
			}, MobileImagePicker));
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
		exports.MobileFab = MobileFab;
		exports.MobileImagePicker = MobileImagePicker;
		exports.intakeImageFiles = intakeImageFiles;
		exports.applyKeyboardViewport = applyKeyboardViewport;
		exports.trackDetails = trackDetails;
		exports.trackFabAnchor = trackFabAnchor;
		return module.exports;
	},
});

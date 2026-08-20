// Browser half of dsh-plugin-session-id: name the current session in its header.
//
// The session id is the one handle that ties a UI complaint to durable evidence
// (session logs, `compartments` rows, Dreamer notices). It is otherwise only
// visible in the URL, so reporting "the session that failed" costs a detour.
//
// This registers into `conversation.session.header.actions`, the same list slot
// that carries the agent-preset label (order -10), with order -9 so the chip
// lands immediately after the preset name. Using the slot rather than DOM
// injection means the host owns placement and teardown, and the chip disappears
// with the header exactly like the preset label does.
//
// The chip shows the id's distinguishing head and copies the FULL id on click:
// a short form is what a human reads, the full form is what greps a log.
window.__ModuleLoader__.load({
	id: "dsh-plugin-session-id",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const { jsx } = require("react/jsx-runtime");

		const NS = "dsh-plugin-session-id";
		const inject = ["slots", "locale"];

		const zh = {
			hint: "点击复制完整会话 id",
			copied: "已复制",
		};
		const en = {
			hint: "Click to copy the full session id",
			copied: "copied",
		};

		const CSS = [
			`.${NS}-chip{box-sizing:border-box;flex:none;height:22px;max-width:180px;`
				+ `background:var(--dsw-alias-fill-tsp-secondary);color:var(--dsw-alias-label-secondary);`
				+ `border:none;border-radius:6px;padding:0 6px;font-size:11px;line-height:22px;`
				+ `font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);`
				+ `white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`
				+ `display:inline-flex;align-items:center;cursor:pointer}`,
			`.${NS}-chip:hover{color:var(--dsw-alias-label-primary)}`,
			`.${NS}-chip[data-copied="true"]{color:var(--dsw-alias-state-business-primary)}`,
		].join("\n");

		/**
		 * The id's distinguishing head: the `session-` prefix is constant and the
		 * remainder is a uuid, so the first block already identifies a session.
		 *
		 * @param sessionId - full session id.
		 * @returns a short display form, never empty for a non-empty id.
		 */
		function shortId(sessionId) {
			if (typeof sessionId !== "string" || sessionId === "") return "";
			const body = sessionId.replace(/^session-/, "");
			if (body === "") return sessionId;
			return body.length <= 12 ? body : body.slice(0, 8);
		}

		/**
		 * Copy text, preferring the async clipboard and falling back to a hidden
		 * textarea so a non-secure context still works.
		 *
		 * @param text - exact text to place on the clipboard.
		 * @returns whether some path reported success.
		 */
		async function copyText(text) {
			try {
				const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
				if (clipboard !== undefined && typeof clipboard.writeText === "function") {
					await clipboard.writeText(text);
					return true;
				}
			} catch (_clipboardRefused) {
				// Permission or non-secure context: fall through to the legacy path.
			}
			try {
				const area = document.createElement("textarea");
				area.value = text;
				area.setAttribute("readonly", "");
				area.style.position = "fixed";
				area.style.opacity = "0";
				if (document.body === undefined || document.body === null) return false;
				document.body.appendChild(area);
				area.select?.();
				const ok = document.execCommand?.("copy") ?? false;
				area.remove?.();
				return ok === true;
			} catch (_legacyCopyFailed) {
				return false;
			}
		}

		/**
		 * Render this session's id beside the agent-preset label.
		 *
		 * @param props - composed slot props.
		 * @returns the chip, or null when the slot has no session id.
		 */
		function SessionIdLabel({ sessionId, copy, t }) {
			const [copied, setCopied] = react.useState(false);
			const timer = react.useRef(undefined);
			const short = react.useMemo(() => shortId(sessionId), [sessionId]);
			react.useEffect(() => () => {
				if (timer.current !== undefined) clearTimeout(timer.current);
			}, []);
			if (short === "") return null;
			const announce = () => {
				setCopied(true);
				if (timer.current !== undefined) clearTimeout(timer.current);
				timer.current = setTimeout(() => setCopied(false), 1200);
			};
			return jsx("button", {
				type: "button",
				className: `${NS}-chip`,
				"data-dsh-session-id": sessionId,
				"data-copied": copied ? "true" : "false",
				title: `${sessionId}\n${t("hint")}`,
				"aria-label": sessionId,
				onClick: () => {
					const result = copy();
					if (result !== undefined && typeof result.then === "function") {
						result.then(announce, announce);
						return;
					}
					announce();
				},
				children: copied ? t("copied") : short,
			});
		}

		/**
		 * Register styles, locale, and the header slot entry.
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
			ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
				name: "conversation.session.header.actions",
				id: "session-id",
				// The agent-preset label registers at -10; -9 keeps this chip
				// immediately after it and ahead of every default-order entry.
				order: -9,
				locale: NS,
				inject: (sessionId) => ({ copy: () => copyText(sessionId) }),
			}, SessionIdLabel));
		}

		exports.name = NS;
		exports.inject = inject;
		exports.apply = apply;
		exports.shortId = shortId;
		return module.exports;
	},
});

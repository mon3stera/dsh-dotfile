// Browser half of dsh-plugin-outline: a right-side user-message outline.
window.__ModuleLoader__.load({
  id: "dsh-plugin-outline",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const { jsx, jsxs } = require("react/jsx-runtime");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    const NS = "dsh-plugin-outline";
    const inject = ["slots", "locale"];

    const zh = {
      title: "会话目录",
      toggle: "显示或隐藏会话目录",
      close: "关闭会话目录",
      userMessages: "条用户消息",
      empty: "当前会话还没有用户消息",
      message: "消息",
      loadOlder: "加载更早消息",
      nativeLoadOlder: "加载更早",
      loadingOlder: "正在加载更早消息..."
    };
    const en = {
      title: "Session outline",
      toggle: "Show or hide the session outline",
      close: "Close session outline",
      userMessages: "user messages",
      empty: "No user messages in this session",
      message: "Message",
      loadOlder: "Load earlier messages",
      nativeLoadOlder: "Load earlier",
      loadingOlder: "Loading earlier messages..."
    };

    const CSS = `
.dsh-outline-root{display:inline-flex;align-items:center}
.dsh-outline-trigger{height:32px;min-width:32px;color:var(--dsw-alias-label-secondary);background:transparent;border:1px solid transparent;border-radius:8px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:0 8px;font:var(--dsw-font-xs-13)}
.dsh-outline-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-outline-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.dsh-outline-panel{position:fixed;z-index:60;top:58px;right:12px;bottom:132px;box-sizing:border-box;width:min(360px,calc(100vw - 24px));min-width:0;display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary)}
.dsh-outline-header{display:flex;align-items:center;gap:8px;min-height:48px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.dsh-outline-title{min-width:0;flex:1;font-size:14px;font-weight:600;line-height:20px}
.dsh-outline-count{color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-outline-load{width:calc(100% - 16px);margin:8px 8px 0;padding:7px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;line-height:18px;text-align:left}
.dsh-outline-load:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-selected);color:var(--dsw-alias-label-primary)}
.dsh-outline-load:disabled{cursor:wait;color:var(--dsw-alias-label-tertiary)}
.dsh-outline-close{width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;display:grid;place-items:center}
.dsh-outline-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-outline-list{min-height:0;flex:1;overflow-y:auto;margin:0;padding:8px;list-style:none;overscroll-behavior:contain}
.dsh-outline-item{width:100%;display:flex;align-items:flex-start;gap:8px;margin:0;padding:0;border:0;background:transparent;text-align:left;color:var(--dsw-alias-label-secondary);cursor:pointer;border-radius:6px}
.dsh-outline-item:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-outline-item[aria-current=true]{background:var(--dsw-alias-interactive-bg-selected);color:var(--dsw-alias-label-primary)}
.dsh-outline-index{box-sizing:border-box;flex:none;width:28px;padding:9px 0;color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums;text-align:center}
.dsh-outline-text{min-width:0;flex:1;padding:8px 4px 8px 0;font-size:13px;line-height:18px;overflow-wrap:anywhere}
.dsh-outline-empty{padding:20px 12px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;text-align:center}
@media(max-width:700px){.dsh-outline-panel{top:52px;right:8px;bottom:112px;width:min(340px,calc(100vw - 16px))}.dsh-outline-trigger{padding:0 6px}}
`;

    function plainText(content) {
      if (!Array.isArray(content)) return "";
      return content.map((block) => {
        if (typeof block === "string") return block;
        if (block?.type === "text" && typeof block.text === "string") return block.text;
        if (typeof block?.text === "string") return block.text;
        if (block?.type === "image") return "[image]";
        return "";
      }).join(" ").replace(/\s+/g, " ").trim();
    }

    function summarize(text) {
      if (text.length <= 120) return text;
      return `${text.slice(0, 117).trimEnd()}...`;
    }

    function collectItems(order, nodeStore) {
      if (!Array.isArray(order) || nodeStore === undefined) return [];
      return order.map((key) => nodeStore.get(key)).filter((node) => node !== undefined && (node.kind === "user" || node.kind === "steering")).map((node, index) => {
        const text = summarize(plainText(node.data?.content));
        return {
          key: node.key,
          seq: node.anchorSeq ?? node.data?.seq,
          index: index + 1,
          text: text || `(${zh.message} ${index + 1})`,
        };
      });
    }

    function findAnchor(key) {
      return [...document.querySelectorAll("[data-chat-anchor-key]")].find((element) => element.getAttribute("data-chat-anchor-key") === key) ?? null;
    }

    function scrollToMessage(key) {
      const element = findAnchor(key);
      if (element === null) return false;
      element.scrollIntoView({ behavior: "smooth", block: "start" });
      return true;
    }

    function OutlineHeader({ sessionId, useSession, loadOlder, t }) {
      const order = useSession((snapshot) => snapshot.chat.order);
      const nodeStore = useSession((snapshot) => snapshot.chat.nodes);
      const hasMore = useSession((snapshot) => snapshot.hasMore);
      const loadingOlder = useSession((snapshot) => snapshot.loadingOlder);
      // Collapsed by default: this component is session-scoped, so it remounts
      // on every session switch, and defaulting to open meant the panel kept
      // reappearing uninvited over the conversation.
      const [open, setOpen] = react.useState(false);
      const [activeKey, setActiveKey] = react.useState(null);
      const items = react.useMemo(() => collectItems(order, nodeStore), [order, nodeStore]);

      react.useEffect(() => {
        if (activeKey !== null && !items.some((item) => item.key === activeKey)) setActiveKey(null);
      }, [activeKey, items]);

      const handleLoadOlder = () => {
        if (loadingOlder) return;
        // Reuse ChatView's own button first: it preserves the current scroll
        // anchor while prepending the next history page.
        const nativeButton = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === t("nativeLoadOlder"));
        if (nativeButton !== undefined && nativeButton.disabled !== true) {
          nativeButton.click();
          return;
        }
        if (typeof loadOlder === "function") void loadOlder().catch(() => {});
      };

      const handleSelect = (item) => {
        if (scrollToMessage(item.key)) setActiveKey(item.key);
      };

      return jsxs("span", {
        className: "dsh-outline-root",
        "data-outline-session": sessionId,
        children: [
          jsxs("button", {
            type: "button",
            className: "dsh-outline-trigger",
            "aria-label": t("toggle"),
            "aria-expanded": open,
            title: t("toggle"),
            onClick: () => setOpen((value) => !value),
            children: [jsx(primitives.IconListPenOutline16, { size: 16 }), open ? null : jsx("span", { children: t("title") })],
          }),
          open && jsxs("aside", {
            className: "dsh-outline-panel",
            role: "dialog",
            "aria-label": t("title"),
            children: [
              jsxs("div", {
                className: "dsh-outline-header",
                children: [
                  jsx("strong", { className: "dsh-outline-title", children: t("title") }),
                  jsx("span", { className: "dsh-outline-count", children: `${items.length} ${t("userMessages")}` }),
                  jsx("button", {
                    type: "button",
                    className: "dsh-outline-close",
                    "aria-label": t("close"),
                    title: t("close"),
                    onClick: () => setOpen(false),
                    children: jsx(primitives.IconCloseOutline16, { size: 16 }),
                  }),
                ],
              }),
              hasMore && jsx("button", {
                type: "button",
                className: "dsh-outline-load",
                disabled: loadingOlder,
                onClick: handleLoadOlder,
                children: loadingOlder ? t("loadingOlder") : t("loadOlder"),
              }),
              items.length === 0
                ? jsx("div", { className: "dsh-outline-empty", children: t("empty") })
                : jsx("ol", {
                    className: "dsh-outline-list",
                    children: items.map((item) => jsx("li", {
                      children: jsxs("button", {
                        type: "button",
                        className: "dsh-outline-item",
                        "aria-current": item.key === activeKey,
                        onClick: () => handleSelect(item),
                        children: [jsx("span", { className: "dsh-outline-index", children: item.index }), jsx("span", { className: "dsh-outline-text", children: item.text })],
                      }),
                    }, item.key)),
                  }),
            ],
          }),
        ],
      });
    }

    function apply(ctx) {
      const style = document.createElement("style");
      style.dataset.plugin = "dsh-plugin-outline";
      style.textContent = CSS;
      document.head.appendChild(style);
      ctx.effect(() => () => style.remove(), "dsh-plugin-outline: styles");
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-plugin-outline: locale");
      ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
        name: "conversation.session.header.utilities",
        id: "session-outline",
        order: 80,
        locale: NS,
        inject: (sessionId) => ({
          loadOlder: async () => {
            const binding = ctx.get("sessions")?.binding(sessionId);
            if (binding?.session !== undefined) await binding.session.loadOlder();
          },
        }),
      }, OutlineHeader));
    }

    exports.name = "dsh-plugin-outline";
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});

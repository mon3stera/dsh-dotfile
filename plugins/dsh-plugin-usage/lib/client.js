// Browser half of dsh-plugin-usage: a token-usage dashboard panel.
//
// The panel mirrors dsh-plugin-diff-viewer's shape (a session-header trigger
// plus a fixed side panel) and talks only to this plugin's own host routes
// under /usage/. Three tabs:
//
// - Composition: exact cumulative totals plus the estimated per-category
//   breakdown of the current context (the only estimated numbers, labeled).
// - Requests: the exact per-request accounting from the provider.
// - Sessions: the workspace overview, one summary row per session.
//
// While the panel is open it polls every 15 seconds so a live session's
// numbers advance without a manual refresh.
window.__ModuleLoader__.load({
  id: "dsh-plugin-usage",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const { jsx, jsxs } = require("react/jsx-runtime");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    const NS = "dsh-plugin-usage";
    const inject = ["slots", "locale"];

    const zh = {
      title: "Token 用量",
      toggle: "显示或隐藏 Token 用量面板",
      close: "关闭面板",
      refresh: "刷新",
      tabComposition: "构成",
      tabRequests: "请求",
      tabSessions: "会话",
      loading: "加载中...",
      noData: "这个会话还没有任何模型请求",
      noSession: "找不到会话日志",
      contextNow: "当前上下文",
      contextOf: (used, window) => `${used} / ${window}`,
      sessionTotal: "会话累计",
      billedInput: "输入(含缓存)",
      outputTokens: "输出",
      cacheHit: "缓存命中率",
      rewrites: "前缀重写",
      requestsCount: "请求数",
      category: "分类",
      tokens: "tokens",
      estimateNote: "构成按字符启发式估算并归一到最后一次请求的真实总量；其余数字为计费精确值。",
      estTotal: "估算总量的偏差",
      chartBar: "构成条",
      colRequest: "请求",
      colTurn: "turn.step",
      colTime: "时间",
      colInput: "输入",
      colCacheRead: "缓存读",
      colCacheWrite: "缓存写",
      colOutput: "输出",
      colTotal: "上下文",
      rewriteFull: "全量重写",
      rewritePartial: "疑似重写",
      colModel: "模型",
      colPreset: "预设",
      colActivity: "最近活动",
      colSession: "会话",
      sessionsOf: "本工作区",
      noCwd: "当前会话没有工作目录",
      turns: "轮"
    };
    const en = {
      title: "Token usage",
      toggle: "Show or hide the token usage panel",
      close: "Close panel",
      refresh: "Refresh",
      tabComposition: "Composition",
      tabRequests: "Requests",
      tabSessions: "Sessions",
      loading: "Loading...",
      noData: "This session has no model requests yet",
      noSession: "Session log not found",
      contextNow: "Current context",
      contextOf: (used, window) => `${used} / ${window}`,
      sessionTotal: "Session total",
      billedInput: "Input (incl. cache)",
      outputTokens: "Output",
      cacheHit: "Cache hit rate",
      rewrites: "Prefix rewrites",
      requestsCount: "Requests",
      category: "Category",
      tokens: "tokens",
      estimateNote: "Composition is estimated with a character heuristic and normalized to the last request's exact total; every other number is exact billing data.",
      estTotal: "Raw estimate deviation",
      chartBar: "Composition bar",
      colRequest: "#",
      colTurn: "turn.step",
      colTime: "Time",
      colInput: "Input",
      colCacheRead: "Cache read",
      colCacheWrite: "Cache write",
      colOutput: "Output",
      colTotal: "Context",
      rewriteFull: "full rewrite",
      rewritePartial: "suspected rewrite",
      colModel: "Model",
      colPreset: "Preset",
      colActivity: "Last activity",
      colSession: "Session",
      sessionsOf: "This workspace",
      noCwd: "This session has no working directory",
      turns: "turns"
    };

    const MONO = "var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)";
    const CSS = `
.dsh-us-root{display:inline-flex;align-items:center}
.dsh-us-trigger{height:32px;min-width:32px;color:var(--dsw-alias-label-secondary);background:transparent;border:1px solid transparent;border-radius:8px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:0 8px;font:var(--dsw-font-xs-13)}
.dsh-us-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-us-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.dsh-us-panel{position:fixed;z-index:60;top:58px;right:12px;bottom:132px;box-sizing:border-box;width:min(760px,calc(100vw - 24px));min-width:0;display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:color-mix(in oklab,var(--dsw-alias-bg-layer-1) 86%,transparent);backdrop-filter:blur(20px) saturate(1.4);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary)}
@supports not (backdrop-filter:blur(1px)){.dsh-us-panel{background:var(--dsw-alias-bg-layer-1)}}
.dsh-us-header{display:flex;align-items:center;gap:8px;min-height:48px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.dsh-us-title{min-width:0;flex:none;font-size:14px;font-weight:600;line-height:20px}
.dsh-us-sub{min-width:0;flex:1;overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;white-space:nowrap;text-overflow:ellipsis}
.dsh-us-tabs{flex:none;display:inline-flex;gap:2px;padding:2px;border-radius:7px;background:var(--dsw-alias-interactive-bg-hover)}
.dsh-us-tab{padding:4px 10px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;line-height:18px}
.dsh-us-tab[aria-selected=true]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-shadow-lv1)}
.dsh-us-icon{width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;display:grid;place-items:center;flex:none}
.dsh-us-icon:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-us-body{min-height:0;flex:1;overflow:auto;overscroll-behavior:contain;padding:12px}
.dsh-us-note{padding:20px 12px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;text-align:center}
.dsh-us-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin-bottom:12px}
.dsh-us-card{padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.dsh-us-cardLabel{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dsh-us-cardValue{font-size:16px;line-height:22px;font-weight:600;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.dsh-us-cardDim{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dsh-us-meter{height:6px;border-radius:3px;background:var(--dsw-alias-interactive-bg-hover);overflow:hidden;margin-top:6px}
.dsh-us-meterFill{height:100%;border-radius:3px;background:var(--dsw-alias-label-primary)}
.dsh-us-sect{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);margin:14px 0 8px}
.dsh-us-bar{display:flex;height:14px;border-radius:7px;overflow:hidden;border:1px solid var(--dsw-alias-border-l1)}
.dsh-us-barSeg{height:100%}
.dsh-us-rows{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden}
.dsh-us-row{display:grid;align-items:center;gap:8px;padding:6px 10px;font-size:12px;line-height:18px;border-top:1px solid var(--dsw-alias-border-l1)}
.dsh-us-row:first-child{border-top:0}
.dsh-us-rowHead{background:var(--dsw-alias-bg-layer-1);background-image:linear-gradient(var(--dsw-alias-interactive-bg-hover),var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-label-tertiary);font-weight:600}
.dsh-us-num{font-variant-numeric:tabular-nums;text-align:right}
.dsh-us-dim{color:var(--dsw-alias-label-tertiary)}
.dsh-us-mono{font-family:${MONO}}
.dsh-us-swatch{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;vertical-align:baseline}
.dsh-us-share{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dsh-us-flag{font-size:11px;padding:1px 6px;border-radius:6px;background:color-mix(in oklab,#ef4444 16%,transparent);color:#dc2626}
.dsh-us-flag[data-kind=partial]{background:color-mix(in oklab,#f59e0b 16%,transparent);color:#b45309}
.dsh-us-grid{display:grid;grid-template-columns:minmax(40px,auto) minmax(64px,auto) minmax(70px,auto) repeat(4,minmax(64px,auto)) minmax(72px,auto) minmax(90px,auto)}
.dsh-us-gridComp{display:grid;grid-template-columns:minmax(120px,auto) 1fr minmax(70px,auto) minmax(70px,auto) minmax(64px,auto)}
.dsh-us-gridSess{display:grid;grid-template-columns:minmax(90px,auto) minmax(110px,auto) repeat(4,minmax(64px,auto)) minmax(64px,auto) minmax(110px,auto)}
@media(max-width:820px){.dsh-us-panel{top:52px;right:8px;bottom:112px;width:min(560px,calc(100vw - 16px))}.dsh-us-body{padding:8px}}
`;

    // Distinct tints per category; tinted with --meter-tint by the injected
    // ContextMeter rows convention, but this panel owns fixed hues so the
    // stacked bar stays readable on any theme.
    const CATEGORY_COLORS = {
      system: "#94a3b8",
      tools: "#6366f1",
      instructions: "#f59e0b",
      skills: "#14b8a6",
      memory: "#a855f7",
      user: "#22c55e",
      assistant: "#3b82f6",
      tool: "#8b8b8b"
    };

    /**
     * GET one plugin route and parse its JSON body.
     * @throws when the transport fails or the route reports an error.
     */
    async function fetchJson(path, params) {
      const query = new URLSearchParams(params).toString();
      const response = await fetch(`/usage/${path}?${query}`, { headers: { accept: "application/json" } });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        throw new Error(`bad response (${response.status})`);
      }
      if (!response.ok || typeof payload?.error === "string") throw new Error(payload?.error ?? `http ${response.status}`);
      return payload;
    }

    /**
     * Run an async loader with phase tracking, a manual reload, and an
     * optional poll interval while the panel stays open.
     */
    function useAsync(load, deps, enabled, pollMs) {
      const [state, setState] = react.useState({ phase: "idle", data: null, error: null });
      const [nonce, setNonce] = react.useState(0);
      react.useEffect(() => {
        if (!enabled) return undefined;
        let live = true;
        const run = () => {
          setState((prev) => ({ phase: "loading", data: prev.data, error: null }));
          load().then(
            (data) => {
              if (live) setState({ phase: "ready", data, error: null });
            },
            (error) => {
              if (live) setState({ phase: "error", data: null, error: String(error?.message ?? error) });
            },
          );
        };
        run();
        const timer = pollMs === undefined ? null : setInterval(run, pollMs);
        return () => {
          live = false;
          if (timer !== null) clearInterval(timer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [...deps, nonce, enabled]);
      return { ...state, reload: () => setNonce((value) => value + 1) };
    }

    /** Format a token count as 12 / 12.3k / 1.31M. */
    function fmtTokens(value) {
      if (value === null || value === undefined) return "-";
      if (value < 1000) return String(value);
      if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
      return `${(value / 1_000_000).toFixed(2)}M`;
    }

    function fmtTime(ms) {
      if (typeof ms !== "number") return "-";
      const d = new Date(ms);
      const pad = (n) => String(n).padStart(2, "0");
      return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    function pct(value) {
      if (value === null || value === undefined) return "-";
      return `${Math.round(value * 100)}%`;
    }

    /** Render a short note line inside the body. */
    function note(text) {
      return jsx("div", { className: "dsh-us-note", children: text });
    }

    /** One summary card with an optional meter bar. */
    function Card({ label, value, dim, meter }) {
      return jsxs("div", {
        className: "dsh-us-card",
        children: [
          jsx("div", { className: "dsh-us-cardLabel", children: label }),
          jsx("div", { className: "dsh-us-cardValue", children: value }),
          dim === undefined ? null : jsx("div", { className: "dsh-us-cardDim", children: dim }),
          meter === undefined ? null : jsxs("div", {
            className: "dsh-us-meter",
            children: [jsx("div", { className: "dsh-us-meterFill", style: { width: `${Math.min(100, Math.round(meter * 100))}%` } })],
          }),
        ],
      });
    }

    /** Composition tab: exact totals plus the estimated category breakdown. */
    function Composition({ detail, t }) {
      const totals = detail.totals ?? {};
      const composition = detail.composition;
      const window = detail.contextWindow ?? null;
      const last = detail.lastTotalTokens ?? null;

      const categories = composition === null ? [] : Object.entries(composition)
        .filter(([, value]) => value.chars > 0 || value.tokens > 0)
        .sort((a, b) => b[1].tokens - a[1].tokens);

      const rawEstimate = detail.compositionRaw?.estimatedTotal ?? null;
      const actual = detail.compositionRaw?.actualTotal ?? null;
      const deviation = rawEstimate !== null && actual !== null && actual > 0 ? `${((rawEstimate / actual - 1) * 100).toFixed(0)}%` : null;

      return jsxs("div", {
        children: [
          jsxs("div", {
            className: "dsh-us-cards",
            children: [
              jsx(Card, {
                label: t("contextNow"),
                value: fmtTokens(last),
                dim: window === null ? undefined : t("contextOf")(fmtTokens(last), fmtTokens(window)),
                meter: window !== null && last !== null ? last / window : undefined,
              }),
              jsx(Card, { label: t("sessionTotal"), value: fmtTokens(totals.totalTokens), dim: `${totals.requests ?? 0} ${t("requestsCount")}` }),
              jsx(Card, { label: t("billedInput"), value: fmtTokens(totals.billedInputTokens), dim: `cache ${fmtTokens(totals.cacheReadTokens)}` }),
              jsx(Card, { label: t("outputTokens"), value: fmtTokens(totals.outputTokens) }),
              jsx(Card, { label: t("cacheHit"), value: pct(totals.cacheHitRate) }),
              jsx(Card, { label: t("rewrites"), value: String(totals.suspectedRewrites ?? 0), dim: `${t("rewriteFull")}: ${totals.fullRewrites ?? 0}` }),
            ],
          }),
          categories.length === 0 ? null : jsxs("div", {
            children: [
              jsx("div", { className: "dsh-us-sect", children: `${t("chartBar")} · ${fmtTokens(actual)}` }),
              jsx("div", {
                className: "dsh-us-bar",
                role: "img",
                "aria-label": t("chartBar"),
                children: categories.map(([key, value]) => jsx("div", { className: "dsh-us-barSeg", style: { width: `${value.share * 100}%`, background: CATEGORY_COLORS[key] ?? "#888" } }, key)),
              }),
              jsx("div", { className: "dsh-us-sect", children: t("category") }),
              jsx("div", {
                className: "dsh-us-rows",
                children: [
                  jsxs("div", {
                    className: "dsh-us-row dsh-us-rowHead dsh-us-gridComp",
                    children: [
                      jsx("span", { children: t("category") }),
                      jsx("span", {}),
                      jsx("span", { className: "dsh-us-num", children: t("tokens") }),
                      jsx("span", { className: "dsh-us-num", children: "share" }),
                      jsx("span", { className: "dsh-us-num", children: "chars" }),
                    ],
                  }),
                  ...categories.map(([key, value]) => jsxs("div", {
                    className: "dsh-us-row dsh-us-gridComp",
                    children: [
                      jsxs("span", { children: [jsx("span", { className: "dsh-us-swatch", style: { background: CATEGORY_COLORS[key] ?? "#888" } }), key] }),
                      jsx("span", {}),
                      jsx("span", { className: "dsh-us-num dsh-us-mono", children: fmtTokens(value.tokens) }),
                      jsx("span", { className: "dsh-us-num dsh-us-share", children: `${(value.share * 100).toFixed(1)}%` }),
                      jsx("span", { className: "dsh-us-num dsh-us-dim dsh-us-mono", children: value.chars.toLocaleString() }),
                    ],
                  }, key)),
                ],
              }),
              jsx("div", { className: "dsh-us-note", style: { padding: "10px 4px", textAlign: "left" }, children: `${t("estimateNote")}${deviation === null ? "" : ` ${t("estTotal")}: ${deviation}.`}` }),
            ],
          }),
        ],
      });
    }

    /** Requests tab: the exact per-request accounting. */
    function Requests({ detail, t }) {
      const requests = detail.requests ?? [];
      if (requests.length === 0) return note(t("noData"));
      const rows = [...requests].reverse().map((request) => jsxs("div", {
        className: "dsh-us-row dsh-us-grid",
        children: [
          jsx("span", { className: "dsh-us-num dsh-us-dim", children: request.index + 1 }),
          jsx("span", { className: "dsh-us-mono dsh-us-dim", children: `${request.turn ?? "-"}.${request.step ?? "-"}` }),
          jsx("span", { className: "dsh-us-dim", children: fmtTime(request.time) }),
          jsx("span", { className: "dsh-us-num dsh-us-mono", children: fmtTokens(request.inputTokens) }),
          jsx("span", { className: "dsh-us-num dsh-us-mono", children: fmtTokens(request.cacheReadTokens) }),
          jsx("span", { className: "dsh-us-num dsh-us-mono", children: fmtTokens(request.outputTokens) }),
          jsx("span", { className: "dsh-us-num dsh-us-mono", children: fmtTokens(request.totalTokens) }),
          jsxs("span", { children: [
            request.rewrite === "full" ? jsx("span", { className: "dsh-us-flag", children: t("rewriteFull") }) : null,
            request.rewrite === "partial" ? jsx("span", { className: "dsh-us-flag", "data-kind": "partial", children: t("rewritePartial") }) : null,
          ] }),
        ],
      }, request.index));
      return jsxs("div", {
        className: "dsh-us-rows",
        children: [
          jsxs("div", {
            className: "dsh-us-row dsh-us-rowHead dsh-us-grid",
            children: [
              jsx("span", { className: "dsh-us-num", children: t("colRequest") }),
              jsx("span", { children: t("colTurn") }),
              jsx("span", { children: t("colTime") }),
              jsx("span", { className: "dsh-us-num", children: t("colInput") }),
              jsx("span", { className: "dsh-us-num", children: t("colCacheRead") }),
              jsx("span", { className: "dsh-us-num", children: t("colOutput") }),
              jsx("span", { className: "dsh-us-num", children: t("colTotal") }),
              jsx("span", {}),
            ],
          }),
          rows,
        ],
      });
    }

    /** Sessions tab: one summary row per session of this workspace. */
    function Sessions({ overview, t }) {
      const sessions = overview?.sessions ?? [];
      if (sessions.length === 0) return note(t("noData"));
      const copyId = (id) => {
        navigator.clipboard?.writeText(id).catch(() => {});
      };
      return jsxs("div", {
        className: "dsh-us-rows",
        children: [
          jsxs("div", {
            className: "dsh-us-row dsh-us-rowHead dsh-us-gridSess",
            children: [
              jsx("span", { children: t("colSession") }),
              jsx("span", { children: t("colPreset") }),
              jsx("span", { className: "dsh-us-num", children: t("requestsCount") }),
              jsx("span", { className: "dsh-us-num", children: t("sessionTotal") }),
              jsx("span", { className: "dsh-us-num", children: t("billedInput") }),
              jsx("span", { className: "dsh-us-num", children: t("outputTokens") }),
              jsx("span", { className: "dsh-us-num", children: t("contextNow") }),
              jsx("span", { children: t("colActivity") }),
            ],
          }),
          ...sessions.map((session) => jsxs("div", {
            className: "dsh-us-row dsh-us-gridSess",
            children: [
              jsx("button", {
                type: "button",
                className: "dsh-us-mono",
                style: { all: "unset", cursor: "pointer", color: "var(--dsw-alias-label-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
                title: `${session.sessionId ?? ""} (copy)`,
                onClick: () => copyId(session.sessionId ?? ""),
                children: (session.sessionId ?? "").replace(/^session-/, "").slice(0, 8),
              }),
              jsx("span", { className: "dsh-us-dim", style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: session.agentPreset ?? "-" }),
              jsx("span", { className: "dsh-us-num dsh-us-mono", children: session.requests ?? 0 }),
              jsx("span", { className: "dsh-us-num dsh-us-mono", children: fmtTokens(session.totalTokens) }),
              jsx("span", { className: "dsh-us-num dsh-us-mono", children: fmtTokens(session.billedInputTokens) }),
              jsx("span", { className: "dsh-us-num dsh-us-mono", children: fmtTokens(session.outputTokens) }),
              jsx("span", { className: "dsh-us-num dsh-us-mono", children: fmtTokens(session.lastTotalTokens) }),
              jsx("span", { className: "dsh-us-dim", children: fmtTime(session.lastActivity) }),
            ],
          }, session.sessionId)),
        ],
      });
    }

    /** The whole panel: header, tabs, and the active tab's body. */
    function Panel({ sessionId, cwd, t, onClose }) {
      const [tab, setTab] = react.useState("composition");
      const detail = useAsync(
        () => fetchJson("session", { id: sessionId, ...(cwd === undefined ? {} : { cwd }) }),
        [sessionId, cwd],
        true,
        15_000,
      );
      const overview = useAsync(
        () => fetchJson("overview", cwd === undefined ? {} : { cwd }),
        [cwd],
        tab === "sessions" && cwd !== undefined,
      );

      const data = detail.data;
      const body = () => {
        if (tab === "sessions") {
          if (cwd === undefined) return note(t("noCwd"));
          if (overview.phase === "error") return note(overview.error);
          if (overview.data === null) return note(t("loading"));
          return jsx(Sessions, { overview: overview.data, t });
        }
        if (detail.phase === "error") return note(detail.error === `no session log for "${sessionId}"` ? t("noSession") : detail.error);
        if (data === null) return note(t("loading"));
        if ((data.requests ?? []).length === 0) return note(t("noData"));
        return tab === "composition" ? jsx(Composition, { detail: data, t }) : jsx(Requests, { detail: data, t });
      };

      return jsxs("aside", {
        className: "dsh-us-panel",
        role: "dialog",
        "aria-label": t("title"),
        children: [
          jsxs("div", {
            className: "dsh-us-header",
            children: [
              jsx("strong", { className: "dsh-us-title", children: t("title") }),
              jsx("span", { className: "dsh-us-sub", children: (data?.models ?? []).join(", ") || "" }),
              jsxs("span", {
                className: "dsh-us-tabs",
                role: "tablist",
                children: [
                  jsx("button", { type: "button", className: "dsh-us-tab", role: "tab", "aria-selected": tab === "composition", onClick: () => setTab("composition"), children: t("tabComposition") }),
                  jsx("button", { type: "button", className: "dsh-us-tab", role: "tab", "aria-selected": tab === "requests", onClick: () => setTab("requests"), children: t("tabRequests") }),
                  jsx("button", { type: "button", className: "dsh-us-tab", role: "tab", "aria-selected": tab === "sessions", onClick: () => setTab("sessions"), children: t("tabSessions") }),
                ],
              }),
              jsx("button", { type: "button", className: "dsh-us-icon", "aria-label": t("refresh"), title: t("refresh"), onClick: () => { detail.reload(); overview.reload(); }, children: jsx(primitives.IconRefreshOutline16, { size: 16 }) }),
              jsx("button", { type: "button", className: "dsh-us-icon", "aria-label": t("close"), title: t("close"), onClick: onClose, children: jsx(primitives.IconCloseOutline16, { size: 16 }) }),
            ],
          }),
          jsx("div", { className: "dsh-us-body", children: body() }),
        ],
      });
    }

    /** A tiny inline bar-chart glyph for the trigger button. */
    function ChartIcon() {
      return jsx("svg", {
        width: 16,
        height: 16,
        viewBox: "0 0 16 16",
        fill: "none",
        "aria-hidden": true,
        children: [
          [3, 7, 6], [7, 4, 9], [11, 2, 12],
        ].map(([x, y, h]) => jsx("rect", { x, y, width: 2.4, height: h, rx: 1, fill: "currentColor", opacity: 0.9 }, x)),
      });
    }

    /**
     * Header trigger plus the panel, scoped to one session. The workspace
     * comes from the sessions list store (`useSessions`), the only client
     * surface carrying cwd.
     */
    function UsageTrigger({ sessionId, useSessions, t }) {
      const [open, setOpen] = react.useState(false);
      const cwd = useSessions((state) => {
        const entry = state?.byId?.[sessionId];
        return typeof entry?.cwd === "string" && entry.cwd !== "" ? entry.cwd : undefined;
      });
      return jsxs("span", {
        className: "dsh-us-root",
        "data-usage-session": sessionId,
        children: [
          jsxs("button", {
            type: "button",
            className: "dsh-us-trigger",
            "aria-label": t("toggle"),
            "aria-expanded": open,
            title: t("toggle"),
            onClick: () => setOpen((value) => !value),
            children: [jsx(ChartIcon, {}), open ? null : jsx("span", { children: t("title") })],
          }),
          open && jsx(Panel, { sessionId, cwd, t, onClose: () => setOpen(false) }),
        ],
      });
    }

    /**
     * Register styles, locale, and the session-header slot entry.
     * @param ctx - client plugin context.
     */
    function apply(ctx) {
      const style = document.createElement("style");
      style.dataset.plugin = NS;
      style.textContent = CSS;
      document.head.appendChild(style);
      ctx.effect(() => () => style.remove(), `${NS}: styles`);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${NS}: locale`);
      ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
        name: "conversation.session.header.utilities",
        id: "usage",
        order: 72,
        locale: NS,
      }, UsageTrigger));
    }

    exports.name = NS;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});

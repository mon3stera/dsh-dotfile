/**
 * Browser half of dsh-plugin-session-repair: a "Session repair" section in
 * the Settings sidebar.
 *
 * Scans a workspace's session logs for the backward-seq corruption (stale
 * writer collision after an interrupted turn) and repairs them with the fixed
 * pattern implemented host-side. The original log is always kept as
 * `session.jsonl.zstd.bak-<ts>` before a repair; restore brings the newest
 * backup back.
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-session-repair",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const { jsx, jsxs } = require("react/jsx-runtime");
    const { defineStore } = require("@deepseek-ai/dsh-client-store");

    const name = "dsh-plugin-session-repair";
    const inject = ["slots", "locale"];
    const NS = "dsh-plugin-session-repair";

    const PLUGIN_CSS = [
      ".dsr-group{display:flex;flex-direction:column;gap:10px;padding:2px 2px 4px;max-width:760px}",
      ".dsr-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}",
      ".dsr-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
      ".dsr-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
      ".dsr-input{flex:1;min-width:260px;box-sizing:border-box;height:32px;color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:0 12px;font-size:12.5px;font-family:inherit}",
      ".dsr-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}",
      ".dsr-btn{box-sizing:border-box;height:32px;padding:0 14px;color:#fff;background:var(--dsw-alias-state-business-primary);border:none;border-radius:8px;font-size:13px;cursor:pointer;font-family:inherit}",
      ".dsr-btn:disabled{opacity:.5;cursor:default}",
      ".dsr-btn-secondary{color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major);border:1px solid var(--dsw-alias-border-l2)}",
      ".dsr-msg{font-size:12px;line-height:18px;white-space:pre-wrap}",
      ".dsr-error{color:var(--dsw-alias-state-danger,#c62828)}",
      ".dsr-ok{color:var(--dsw-alias-state-success,#2e7d32)}",
      ".dsr-table{width:100%;border-collapse:collapse;font-size:12px;color:var(--dsw-alias-label-primary)}",
      ".dsr-table th{text-align:left;font-weight:500;color:var(--dsw-alias-label-tertiary);border-bottom:1px solid var(--dsw-alias-border-l2);padding:6px 8px}",
      ".dsr-table td{border-bottom:1px solid var(--dsw-alias-border-l2);padding:6px 8px;vertical-align:top}",
      ".dsr-code{font-family:var(--ds-font-family-code);font-size:11.5px}",
      // Session-header trigger and its per-session panel.
      ".dsr-htrigger{height:32px;min-width:32px;color:var(--dsw-alias-label-secondary);background:transparent;border:1px solid transparent;border-radius:8px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:0 8px;font:var(--dsw-font-xs-13)}",
      ".dsr-htrigger:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}",
      ".dsr-hroot{display:inline-flex;position:relative}",
      ".dsr-hpanel{position:absolute;z-index:100;top:calc(100% + 8px);right:0;box-sizing:border-box;width:min(460px,calc(100vw - 24px));color:var(--dsw-alias-label-primary);background:var(--dsw-specific-menu);border:0;border-radius:12px;box-shadow:var(--dsw-elevation-prominent);padding:12px;font-size:12px;line-height:20px}",
      ".dsr-hhead{display:flex;align-items:center;gap:6px}",
      ".dsr-htitle{font-weight:500;font-size:13px}",
      ".dsr-hclose{margin-left:auto;width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;display:grid;place-items:center}",
      ".dsr-hmeta{color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code);font-size:11px;margin-top:2px;word-break:break-all}",
      ".dsr-hhint{color:var(--dsw-alias-label-secondary);margin-top:8px}",
      ".dsr-hrow{display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap}",
      ".dsr-hmsg{margin-top:8px;font-size:12px;line-height:18px;white-space:pre-wrap}"
    ].join("\n");

    /** Locale dictionaries for the settings section. */
    const zh = {
      "nav": "会话修复",
      "title": "会话历史修复",
      "hint": "扫描会话日志中的 seq 倒退损坏（中断轮次后迟到的工具结果用旧计数器写盘所致），并按固定模式离线修复：存在合成中断批次则删除并回移，否则把迟到尾部整体上移。修复前会自动备份原文件（.bak-<时间戳>）。",
      "cwdLabel": "工作区路径（留空扫描全部）",
      "cwdPlaceholder": "/home/me/project",
      "scan": "扫描",
      "scanning": "扫描中…",
      "repair": "修复",
      "dryRun": "预览",
      "restore": "恢复备份",
      "repairing": "修复中…",
      "noCorruption": "未发现损坏的会话日志。",
      "found": "发现 {n} 个损坏会话（另有 {m} 个正常）：",
      "repairDone": "修复完成：删除 {d} 条合成事件，共 {e} 条事件，末尾 seq {l}。已备份原文件。",
      "dryRunDone": "预览（未写入）：将删除 {d} 条合成事件，修复后共 {e} 条事件。",
      "restoreDone": "已从备份恢复。",
      "colSession": "会话",
      "colGap": "损坏点",
      "colInfo": "信息",
      "colActions": "操作",
      "trigger": "修复",
      "panelTitle": "会话修复",
      "panelHint": "检查当前会话日志的 seq 倒退损坏；修复前自动备份原文件。",
      "check": "检查",
      "checking": "检查中…",
      "cleanMsg": "未检测到 seq 损坏。若会话仍无法加载，请使用设置页的会话修复面板查看详情。",
      "damagedMsg": "检测到损坏：{gap}。预览：删除 {d} 条合成事件，修复后共 {e} 条事件。",
      "containerMsg": "容器格式损坏（整份日志被压成了单帧），事件内容健康；将重新编码为两帧容器（frame1 = header，frame2 = 事件），内容零改动。",
      "containerShort": "容器单帧",
      "repairedMsg": "修复完成：共 {e} 条事件，末尾 seq {l}。已备份原文件。刷新后重新打开此会话。",
      "restoreDone": "已从备份恢复。",
      "close": "关闭"
    };
    const en = {
      "nav": "Session repair",
      "title": "Session history repair",
      "hint": "Scans session logs for the backward-seq corruption (a late tool result committed with a pre-interrupt event counter) and repairs them offline with the fixed pattern: drop the synthetic interrupt batch when present and shift the tail, otherwise shift the late tail up. The original log is backed up as .bak-<timestamp> before any write.",
      "cwdLabel": "Workspace path (empty = scan all)",
      "cwdPlaceholder": "/home/me/project",
      "scan": "Scan",
      "scanning": "Scanning…",
      "repair": "Repair",
      "dryRun": "Dry run",
      "restore": "Restore backup",
      "repairing": "Repairing…",
      "noCorruption": "No corrupted session logs found.",
      "found": "{n} corrupted session(s) found ({m} healthy):",
      "repairDone": "Repaired: dropped {d} synthetic events, {e} events total, last seq {l}. Original backed up.",
      "dryRunDone": "Dry run (nothing written): would drop {d} synthetic events, {e} events after repair.",
      "restoreDone": "Restored from backup.",
      "colSession": "Session",
      "colGap": "Corruption",
      "colInfo": "Info",
      "colActions": "Actions",
      "trigger": "Repair",
      "panelTitle": "Session repair",
      "panelHint": "Checks this session's log for the backward-seq corruption; the original file is backed up before any repair.",
      "check": "Check",
      "checking": "Checking…",
      "cleanMsg": "No seq corruption detected. If the session still fails to load, use the Session repair section in Settings for details.",
      "damagedMsg": "Corruption detected: {gap}. Preview: would drop {d} synthetic events, {e} events after repair.",
      "containerMsg": "Broken container framing (the whole log was compressed as one frame) while the event content is healthy; it will be re-encoded as a two-frame container (frame 1 = header, frame 2 = events) with the content untouched.",
      "containerShort": "single-frame container",
      "repairedMsg": "Repaired: {e} events, last seq {l}. Original backed up. Refresh and reopen this session.",
      "restoreDone": "Restored from backup.",
      "close": "Close"
    };

    /** Mirror store for the section state. */
    function createStore() {
      return defineStore({
        init: () => ({ cwd: "", sessions: [], healthyCount: 0, scanMs: 0, status: "idle", message: null, error: null }),
        actions: {
          sync: (d, state) => Object.assign(d, state)
        }
      });
    }

    /** Format the gap description for one corrupted session. */
    function gapText(t, session) {
      if (session.error !== undefined) return session.error;

      if (session.containerBroken === true) {
        const gap = session.gap;
        const seq = gap === null || gap === undefined ? "" : ` · seq ${gap.got === null ? "unparsable" : `expected ${gap.expected}, got ${gap.got}`}`;
        return t("containerShort") + seq;
      }

      const gap = session.gap;
      if (gap === null || gap === undefined) return "";
      if (gap.got === null) return `unparsable row at ${gap.row}`;
      return `expected ${gap.expected}, got ${gap.got}`;
    }

    /** Inline wrench icon for the header trigger. */
    const WRENCH_ICON = jsx("svg", {
      viewBox: "0 0 24 24", width: 16, height: 16, fill: "none", stroke: "currentColor",
      strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true,
      children: jsx("path", { d: "M14.5 6.5a3.5 3.5 0 0 0-4.9 4.2L4 16.3V20h3.7l5.6-5.6a3.5 3.5 0 0 0 4.2-4.9l-2.6 2.6-2.4-2.4 2.6-2.6z" })
    });

    /** Format the stored gap for a message template. */
    function gapLabel(session) {
      const gap = session?.gap;
      if (gap === null || gap === undefined) return "unknown";
      if (gap.got === null) return `unparsable row at ${gap.row}`;
      return `expected ${gap.expected}, got ${gap.got}`;
    }

    /**
     * Session-header utility: checks and repairs THIS session's log in place.
     * The dry run doubles as the status probe: 200 = damaged (with a preview),
     * 409 = clean. A real repair is only offered after a damaged dry run.
     *
     * @param {{sessionId: string, useSessions: Function, t: Function}} props -
     *   session scope from the slot host; cwd comes from the sessions list
     *   store and may be undefined while the list has not loaded.
     */
    function RepairTrigger({ sessionId, useSessions, t }) {
      const [open, setOpen] = react.useState(false);
      const [busy, setBusy] = react.useState(false);
      const [result, setResult] = react.useState(null);
      const cwd = useSessions((state) => {
        const entry = state?.byId?.[sessionId];
        return typeof entry?.cwd === "string" && entry.cwd !== "" ? entry.cwd : undefined;
      });

      const post = (path, body) => fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, cwd, ...body })
      }).then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok !== true) {
          const error = new Error(data.error ?? "request failed");
          error.status = response.status;
          throw error;
        }
        return data;
      });

      const check = () => {
        setBusy(true);
        setResult(null);
        post("/session-repair/repair", { dryRun: true })
          .then((data) => setResult(data.recontainerizeOnly === true
            ? { kind: "damaged", data, text: t("containerMsg") }
            : {
              kind: "damaged",
              data,
              text: t("damagedMsg").replace("{gap}", gapLabel(data)).replace("{d}", data.passes.reduce((n, p) => n + p.dropped, 0)).replace("{e}", data.eventsAfter)
            }))
          .catch((error) => setResult(error.status === 409 ? { kind: "clean" } : { kind: "error", text: String(error?.message ?? error) }))
          .finally(() => setBusy(false));
      };

      const repair = () => {
        setBusy(true);
        post("/session-repair/repair", { dryRun: false })
          .then((data) => setResult({ kind: "repaired", data, text: t("repairedMsg").replace("{e}", data.eventsAfter).replace("{l}", data.lastSeq) }))
          .catch((error) => setResult({ kind: "error", text: String(error?.message ?? error) }))
          .finally(() => setBusy(false));
      };

      const restore = () => {
        setBusy(true);
        post("/session-repair/restore", {})
          .then(() => setResult({ kind: "restored", text: t("restoreDone") }))
          .catch((error) => setResult({ kind: "error", text: String(error?.message ?? error) }))
          .finally(() => setBusy(false));
      };

      return jsxs("span", {
        className: "dsr-hroot",
        "data-dsh-session-repair": sessionId,
        children: [
          jsx("button", {
            type: "button",
            className: "dsr-htrigger",
            "aria-label": t("trigger"),
            "aria-expanded": open,
            title: t("trigger"),
            onClick: () => { setResult(null); setOpen((v) => !v); },
            children: [WRENCH_ICON, open ? null : jsx("span", { children: t("trigger") })]
          }),
          open && jsxs("div", {
            className: "dsr-hpanel",
            role: "dialog",
            "aria-label": t("panelTitle"),
            children: [
              jsxs("div", { className: "dsr-hhead", children: [
                jsx("span", { className: "dsr-htitle", children: t("panelTitle") }),
                jsx("button", {
                  type: "button", className: "dsr-hclose", "aria-label": t("close"),
                  onClick: () => setOpen(false), children: "×"
                })
              ] }),
              jsx("div", { className: "dsr-hmeta", children: `${sessionId}${cwd === undefined ? "" : ` · ${cwd}`}` }),
              jsx("div", { className: "dsr-hhint", children: t("panelHint") }),
              result === null ? jsx("div", { className: "dsr-hrow", children: jsx("button", {
                type: "button", className: "dsr-btn dsr-btn-secondary", disabled: busy || cwd === undefined,
                onClick: check, children: busy ? t("checking") : t("check")
              }) }) : null,
              result?.kind === "damaged" ? jsx("div", { className: "dsr-hrow", children: jsx("button", {
                type: "button", className: "dsr-btn", disabled: busy,
                onClick: repair, children: busy ? t("repairing") : t("repair")
              }) }) : null,
              (result?.kind === "repaired" || result?.kind === "restored") ? jsx("div", { className: "dsr-hrow", children: jsx("button", {
                type: "button", className: "dsr-btn dsr-btn-secondary", disabled: busy,
                onClick: restore, children: t("restore")
              }) }) : null,
              result?.text !== undefined ? jsx("div", { className: `dsr-hmsg${result.kind === "error" ? " dsr-error" : result.kind === "clean" ? "" : " dsr-ok"}`, children: result.text }) : null
            ]
          })
        ]
      });
    }

    /** Settings > sidebar section: cwd input + scan + corrupted-session table. */    function SessionRepairSection({ t, useStore, scan, repair, restore, setCwd }) {
      const s = useStore((st) => st);
      const busy = s.status !== "idle";
      const fmt = (text) => text.replace("{n}", s.sessions.length).replace("{m}", s.healthyCount);

      return jsx("div", {
        className: "dsr-group",
        children: [
          jsx("div", { className: "dsr-title", children: t("title") }),
          jsx("div", { className: "dsr-hint", children: t("hint") }),
          jsx("div", {
            className: "dsr-row",
            children: [
              jsx("input", {
                className: "dsr-input",
                value: s.cwd,
                placeholder: t("cwdPlaceholder"),
                spellCheck: false,
                onChange: (e) => setCwd(e.target.value)
              }),
              jsx("button", { type: "button", className: "dsr-btn", onClick: scan, disabled: busy, children: s.status === "scanning" ? t("scanning") : t("scan") })
            ]
          }),
          s.status === "idle" && s.sessions.length === 0 && s.error === null ? jsx("div", { className: "dsr-msg", children: t("noCorruption") }) : null,
          s.sessions.length > 0 ? jsx("div", { className: "dsr-msg", children: fmt(t("found")) }) : null,
          s.sessions.length > 0 ? jsx("table", {
            className: "dsr-table",
            children: [
              jsx("thead", {
                children: jsx("tr", {
                  children: [t("colSession"), t("colGap"), t("colInfo"), t("colActions")].map((label) => jsx("th", { key: label, children: label }))
                })
              }),
              jsx("tbody", {
                children: s.sessions.map((session) => jsx("tr", {
                  key: `${session.projectDir}/${session.sessionId}`,
                  children: [
                    jsx("td", { className: "dsr-code", children: `${session.projectDir}/${session.sessionId}` }),
                    jsx("td", { children: gapText(t, session) }),
                    jsx("td", {
                      children: [
                        `${session.events ?? "?"} events`,
                        session.hasSyntheticBatch ? " · interrupt batch" : "",
                        (session.backups?.length ?? 0) > 0 ? ` · ${session.backups.length} backup(s)` : ""
                      ].join("")
                    }),
                    jsx("td", {
                      children: [
                        jsx("button", {
                          key: "dry", type: "button", className: "dsr-btn dsr-btn-secondary", disabled: busy,
                          onClick: () => repair(session, true), children: t("dryRun")
                        }),
                        " ",
                        jsx("button", {
                          key: "fix", type: "button", className: "dsr-btn", disabled: busy,
                          onClick: () => repair(session, false), children: s.status === "repairing" ? t("repairing") : t("repair")
                        }),
                        (session.backups?.length ?? 0) > 0 ? jsx("button", {
                          key: "restore", type: "button", className: "dsr-btn dsr-btn-secondary", disabled: busy,
                          onClick: () => restore(session), children: t("restore")
                        }) : null
                      ]
                    })
                  ]
                }))
              })
            ]
          }) : null,
          s.message !== null ? jsx("div", { className: "dsr-msg dsr-ok", children: s.message }) : null,
          s.error !== null ? jsx("div", { className: "dsr-msg dsr-error", children: s.error }) : null
        ]
      });
    }

    function apply(ctx) {
      const store = createStore();
      let bound = null;
      const state = {
        cwd: localStorage.getItem("dsh-session-repair.cwd") ?? "",
        sessions: [], healthyCount: 0, scanMs: 0, status: "idle", message: null, error: null
      };

      const syncStore = () => {
        if (bound) bound.sync({ ...state });
      };
      const commit = (patch) => {
        Object.assign(state, patch);
        syncStore();
      };

      const scan = () => {
        commit({ status: "scanning", message: null, error: null });
        localStorage.setItem("dsh-session-repair.cwd", state.cwd);
        const query = state.cwd.trim() === "" ? "" : `?cwd=${encodeURIComponent(state.cwd.trim())}`;
        fetch(`/session-repair/scan${query}`)
          .then(async (response) => {
            const data = await response.json();
            if (!response.ok || data.ok !== true) throw new Error(data.error ?? "scan failed");
            commit({ sessions: data.sessions, healthyCount: data.healthyCount, scanMs: data.scannedInMs, status: "idle", error: null });
          })
          .catch((error) => commit({ status: "idle", error: String(error?.message ?? error) }));
      };

      const repair = (session, dryRun) => {
        commit({ status: "repairing", message: null, error: null });
        fetch("/session-repair/repair", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: session.sessionId, dryRun })
        })
          .then(async (response) => {
            const data = await response.json();
            if (!response.ok || data.ok !== true) throw new Error(data.error ?? "repair failed");
            const text = dryRun ? "dryRunDone" : "repairDone";
            const message = t(text).replace("{d}", data.passes.reduce((n, pass) => n + pass.dropped, 0)).replace("{e}", data.eventsAfter).replace("{l}", data.lastSeq);
            commit({ status: "idle", message, error: null });
            if (!dryRun) scan();
          })
          .catch((error) => commit({ status: "idle", error: String(error?.message ?? error) }));
      };

      const restore = (session) => {
        commit({ status: "repairing", message: null, error: null });
        fetch("/session-repair/restore", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: session.sessionId })
        })
          .then(async (response) => {
            const data = await response.json();
            if (!response.ok || data.ok !== true) throw new Error(data.error ?? "restore failed");
            commit({ status: "idle", message: t("restoreDone"), error: null });
            scan();
          })
          .catch((error) => commit({ status: "idle", error: String(error?.message ?? error) }));
      };

      const setCwd = (value) => commit({ cwd: value });

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-plugin-session-repair: section dictionaries");
      ctx.effect(() => {
        document.querySelectorAll('style[data-plugin-css="dsh-plugin-session-repair/ui.css"]').forEach((el) => el.remove());
        const tag = document.createElement("style");
        tag.dataset.plugin = name;
        tag.dataset.pluginCss = "dsh-plugin-session-repair/ui.css";
        tag.textContent = PLUGIN_CSS;
        document.head.appendChild(tag);
      }, "dsh-plugin-session-repair: section styles");

      const injected = (actions) => {
        bound = actions;
        syncStore();
        return { scan, repair, restore, setCwd };
      };

      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "session-repair",
        order: 31,
        label: () => ctx.locale.bind(NS)("nav"),
        locale: NS,
        store,
        inject: injected
      }, SessionRepairSection));

      ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
        name: "conversation.session.header.utilities",
        id: "session-repair",
        order: 74,
        locale: NS
      }, RepairTrigger));

      syncStore();
    }

    exports.name = name;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});

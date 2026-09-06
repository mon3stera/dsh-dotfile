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

    const jsx = require("react/jsx-runtime").jsx;
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
      ".dsr-code{font-family:var(--ds-font-family-code);font-size:11.5px}"
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
      "colActions": "操作"
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
      "colActions": "Actions"
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
      const gap = session.gap;
      if (gap === null || gap === undefined) return "";
      if (gap.got === null) return `unparsable row at ${gap.row}`;
      return `expected ${gap.expected}, got ${gap.got}`;
    }

    /** Settings > sidebar section: cwd input + scan + corrupted-session table. */
    function SessionRepairSection({ t, useStore, scan, repair, restore, setCwd }) {
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

      syncStore();
    }

    exports.name = name;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});

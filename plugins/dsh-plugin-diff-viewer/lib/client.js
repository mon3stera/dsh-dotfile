// Browser half of dsh-plugin-diff-viewer: a read-only git diff and file browser.
//
// The panel mirrors dsh-plugin-outline's shape (a header trigger plus a fixed
// side panel) rather than taking over shell.overlay, so it coexists with the
// rest of the conversation chrome and disappears with the session header.
//
// All data comes from the plugin's own host routes under /diff-viewer/. The
// baseline is HEAD, so a commit resets the view instead of letting a long-lived
// session accumulate an unbounded change set.
window.__ModuleLoader__.load({
  id: "dsh-plugin-diff-viewer",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const { jsx, jsxs } = require("react/jsx-runtime");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    const NS = "dsh-plugin-diff-viewer";
    const inject = ["slots", "locale"];

    const zh = {
      title: "改动",
      toggle: "显示或隐藏改动与文件浏览",
      close: "关闭面板",
      tabChanges: "改动",
      tabBrowse: "文件",
      back: "返回",
      refresh: "刷新",
      loading: "加载中...",
      noChanges: "工作区与 HEAD 一致",
      noCwd: "当前会话没有工作目录",
      notGit: "当前工作目录不是 Git 仓库",
      emptyDir: "空目录",
      binary: "二进制文件，不予显示",
      truncated: "内容过长，已截断",
      tooLarge: "文件过大，不予显示",
      noDiff: "没有可显示的差异",
      files: "个文件",
      root: "仓库根目录",
      statusM: "已修改",
      statusA: "新增",
      statusD: "已删除",
      statusR: "已重命名",
      statusU: "未跟踪",
    };
    const en = {
      title: "Changes",
      toggle: "Show or hide changes and file browser",
      close: "Close panel",
      tabChanges: "Changes",
      tabBrowse: "Files",
      back: "Back",
      refresh: "Refresh",
      loading: "Loading...",
      noChanges: "Work tree matches HEAD",
      noCwd: "This session has no working directory",
      notGit: "The working directory is not a Git repository",
      emptyDir: "Empty directory",
      binary: "Binary file not shown",
      truncated: "Content truncated",
      tooLarge: "File too large to display",
      noDiff: "No differences to show",
      files: "files",
      root: "Repository root",
      statusM: "Modified",
      statusA: "Added",
      statusD: "Deleted",
      statusR: "Renamed",
      statusU: "Untracked",
    };

    const MONO = "var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)";
    const CSS = `
.dsh-dv-root{display:inline-flex;align-items:center}
.dsh-dv-trigger{height:32px;min-width:32px;color:var(--dsw-alias-label-secondary);background:transparent;border:1px solid transparent;border-radius:8px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:0 8px;font:var(--dsw-font-xs-13)}
.dsh-dv-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-dv-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.dsh-dv-badge{min-width:16px;padding:0 4px;border-radius:8px;background:var(--dsw-alias-interactive-bg-selected);color:var(--dsw-alias-label-secondary);font-size:11px;font-variant-numeric:tabular-nums;line-height:16px}
.dsh-dv-panel{position:fixed;z-index:60;top:58px;right:12px;bottom:132px;box-sizing:border-box;width:min(720px,calc(100vw - 24px));min-width:0;display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary)}
.dsh-dv-header{display:flex;align-items:center;gap:8px;min-height:48px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.dsh-dv-title{min-width:0;flex:none;font-size:14px;font-weight:600;line-height:20px}
.dsh-dv-branch{min-width:0;flex:1;overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;white-space:nowrap;text-overflow:ellipsis;display:inline-flex;align-items:center;gap:4px}
.dsh-dv-tabs{flex:none;display:inline-flex;gap:2px;padding:2px;border-radius:7px;background:var(--dsw-alias-interactive-bg-hover)}
.dsh-dv-tab{padding:4px 10px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;line-height:18px}
.dsh-dv-tab[aria-selected=true]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-shadow-lv1)}
.dsh-dv-icon{width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;display:grid;place-items:center;flex:none}
.dsh-dv-icon:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-dv-crumbs{display:flex;align-items:center;gap:6px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;min-height:34px}
.dsh-dv-crumbpath{min-width:0;flex:1;overflow:hidden;font-family:${MONO};font-size:12px;line-height:18px;white-space:nowrap;text-overflow:ellipsis;direction:rtl;text-align:left}
.dsh-dv-body{min-height:0;flex:1;overflow:auto;overscroll-behavior:contain}
.dsh-dv-list{margin:0;padding:6px;list-style:none}
.dsh-dv-item{width:100%;display:flex;align-items:center;gap:8px;margin:0;padding:6px 8px;border:0;background:transparent;text-align:left;color:var(--dsw-alias-label-secondary);cursor:pointer;border-radius:6px;font-size:13px;line-height:18px}
.dsh-dv-item:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-dv-status{flex:none;width:18px;height:18px;display:grid;place-items:center;border-radius:4px;font-size:11px;font-weight:600;line-height:18px}
.dsh-dv-status[data-kind=A]{background:color-mix(in oklab,#22c55e 22%,transparent);color:#15803d}
.dsh-dv-status[data-kind=M]{background:color-mix(in oklab,#f59e0b 22%,transparent);color:#b45309}
.dsh-dv-status[data-kind=D]{background:color-mix(in oklab,#ef4444 22%,transparent);color:#b91c1c}
.dsh-dv-status[data-kind=R]{background:color-mix(in oklab,#6366f1 22%,transparent);color:#4338ca}
.dsh-dv-name{min-width:0;flex:1;font-family:${MONO};font-size:12px;overflow-wrap:anywhere}
.dsh-dv-dim{color:var(--dsw-alias-label-tertiary)}
.dsh-dv-counts{flex:none;display:inline-flex;gap:6px;font-family:${MONO};font-size:11px;font-variant-numeric:tabular-nums}
.dsh-dv-plus{color:#16a34a}
.dsh-dv-minus{color:#dc2626}
.dsh-dv-note{padding:20px 12px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;text-align:center}
.dsh-dv-hunk{padding:3px 12px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary);font-family:${MONO};font-size:11px;line-height:18px;position:sticky;top:0}
.dsh-dv-row{display:grid;grid-template-columns:48px 48px 1fr;font-family:${MONO};font-size:12px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere}
.dsh-dv-row[data-kind=add]{background:color-mix(in oklab,#22c55e 13%,transparent)}
.dsh-dv-row[data-kind=del]{background:color-mix(in oklab,#ef4444 13%,transparent)}
.dsh-dv-no{padding:0 8px 0 0;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;text-align:right;user-select:none}
.dsh-dv-text{padding:0 12px 0 6px}
.dsh-dv-text::before{content:attr(data-marker);color:var(--dsw-alias-label-tertiary)}
@media(max-width:820px){.dsh-dv-panel{top:52px;right:8px;bottom:112px;width:min(560px,calc(100vw - 16px))}.dsh-dv-row{grid-template-columns:36px 36px 1fr}}
`;

    /**
     * GET one plugin route and parse its JSON body.
     * @param path - route path under /diff-viewer.
     * @param params - query parameters.
     * @returns the parsed payload.
     * @throws when the transport fails or the route reports an error.
     */
    async function fetchJson(path, params) {
      const query = new URLSearchParams(params).toString();
      const response = await fetch(`/diff-viewer/${path}?${query}`, { headers: { accept: "application/json" } });
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
     * Run an async loader, tracking phase and exposing a manual reload.
     * @param load - loader invoked when enabled and whenever `deps` change.
     * @param deps - dependency list, as for useEffect.
     * @param enabled - when false, no request is issued.
     * @returns `{ phase, data, error, reload }`.
     */
    function useAsync(load, deps, enabled) {
      const [state, setState] = react.useState({ phase: "idle", data: null, error: null });
      const [nonce, setNonce] = react.useState(0);
      react.useEffect(() => {
        if (!enabled) return undefined;
        let live = true;
        setState((prev) => ({ phase: "loading", data: prev.data, error: null }));
        load().then(
          (data) => {
            if (live) setState({ phase: "ready", data, error: null });
          },
          (error) => {
            if (live) setState({ phase: "error", data: null, error: String(error?.message ?? error) });
          },
        );
        return () => {
          live = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [...deps, nonce, enabled]);
      return { ...state, reload: () => setNonce((value) => value + 1) };
    }

    /** Map a git status letter to a localized label. */
    function statusLabel(status, untracked, t) {
      if (untracked) return t("statusU");
      const key = { M: "statusM", A: "statusA", D: "statusD", R: "statusR" }[status[0]];
      return key === undefined ? status : t(key);
    }

    /** Reduce a status code to one of the four badge kinds. */
    function statusKind(status, untracked) {
      if (untracked) return "A";
      const head = status.replace(/\s/g, "")[0] ?? "M";
      return ["A", "D", "R", "M"].includes(head) ? head : "M";
    }

    /** Render a short note line inside the body. */
    function note(text) {
      return jsx("div", { className: "dsh-dv-note", children: text });
    }

    /** One file's hunks, rendered with both gutters and context lines. */
    function DiffRows({ data, t }) {
      if (data === null) return null;
      if (data.binary) return note(t("binary"));
      if (!Array.isArray(data.hunks) || data.hunks.length === 0) return note(t("noDiff"));
      return jsxs("div", {
        children: [
          ...data.hunks.map((hunk, hi) => jsxs("div", {
            children: [
              jsx("div", {
                className: "dsh-dv-hunk",
                children: hunk.heading ? `${hunk.header.split("@@")[1]?.trim() ?? ""}  ${hunk.heading}` : hunk.header,
              }),
              ...hunk.rows.map((row, ri) => jsxs("div", {
                className: "dsh-dv-row",
                "data-kind": row.kind,
                children: [
                  jsx("span", { className: "dsh-dv-no", children: row.oldNo ?? "" }),
                  jsx("span", { className: "dsh-dv-no", children: row.newNo ?? "" }),
                  jsx("span", {
                    className: "dsh-dv-text",
                    "data-marker": row.kind === "add" ? "+" : row.kind === "del" ? "-" : " ",
                    children: row.text,
                  }),
                ],
              }, `${hi}:${ri}`)),
            ],
          }, hunk.header + hi)),
          data.truncated ? note(t("truncated")) : null,
        ],
      });
    }

    /** One file's plain content, line numbered. */
    function FileLines({ data, t }) {
      if (data === null) return null;
      if (data.binary) return note(t("binary"));
      if (data.tooLarge) return note(t("tooLarge"));
      return jsxs("div", {
        children: [
          ...data.lines.map((line) => jsxs("div", {
            className: "dsh-dv-row",
            children: [
              jsx("span", { className: "dsh-dv-no", children: line.no }),
              jsx("span", { className: "dsh-dv-no", children: "" }),
              jsx("span", { className: "dsh-dv-text", children: line.text }),
            ],
          }, line.no)),
          data.truncated ? note(t("truncated")) : null,
        ],
      });
    }

    /** The changed-files list for the changes tab. */
    function ChangesList({ changes, t, onOpen }) {
      const files = changes?.files ?? [];
      if (files.length === 0) return note(t("noChanges"));
      return jsx("ul", {
        className: "dsh-dv-list",
        children: files.map((file) => jsx("li", {
          children: jsxs("button", {
            type: "button",
            className: "dsh-dv-item",
            title: `${statusLabel(file.status, file.untracked, t)} - ${file.path}`,
            onClick: () => onOpen(file),
            children: [
              jsx("span", {
                className: "dsh-dv-status",
                "data-kind": statusKind(file.status, file.untracked),
                children: statusKind(file.status, file.untracked),
              }),
              jsx("span", { className: "dsh-dv-name", children: file.path }),
              jsxs("span", {
                className: "dsh-dv-counts",
                children: [
                  file.added === null ? null : jsx("span", { className: "dsh-dv-plus", children: `+${file.added}` }),
                  file.removed === null ? null : jsx("span", { className: "dsh-dv-minus", children: `-${file.removed}` }),
                ],
              }),
            ],
          }),
        }, file.path)),
      });
    }

    /** One directory listing for the browse tab. */
    function TreeList({ cwd, dir, running, t, onOpenDir, onOpenFile }) {
      const tree = useAsync(() => fetchJson("tree", { cwd, path: dir }), [cwd, dir, running], true);
      if (tree.phase === "error") return note(tree.error);
      if (tree.data === null) return note(t("loading"));
      const entries = tree.data.entries ?? [];
      if (entries.length === 0) return note(t("emptyDir"));
      return jsx("ul", {
        className: "dsh-dv-list",
        children: entries.map((entry) => jsx("li", {
          children: jsxs("button", {
            type: "button",
            className: "dsh-dv-item",
            onClick: () => (entry.dir ? onOpenDir(entry.path) : onOpenFile(entry.path)),
            children: [
              jsx("span", {
                className: "dsh-dv-dim",
                style: { display: "grid", placeItems: "center", flex: "none" },
                children: entry.dir
                  ? jsx(primitives.IconFolderClose16, { size: 16 })
                  : jsx(primitives.IconCodeOutline16, { size: 16 }),
              }),
              jsx("span", { className: "dsh-dv-name", children: entry.name }),
            ],
          }),
        }, entry.path)),
      });
    }

    /** The detail pane: a diff for a changed file, or a plain file view. */
    function Detail({ cwd, selection, running, t }) {
      const isDiff = selection.kind === "diff";
      const view = useAsync(
        () => (isDiff
          ? fetchJson("diff", { cwd, path: selection.path, untracked: selection.untracked ? "1" : "0" })
          : fetchJson("file", { cwd, path: selection.path })),
        [cwd, selection.path, selection.kind, selection.untracked, running],
        true,
      );
      if (view.phase === "error") return note(view.error);
      if (view.data === null) return note(t("loading"));
      return isDiff ? jsx(DiffRows, { data: view.data, t }) : jsx(FileLines, { data: view.data, t });
    }

    /** The whole panel: header, breadcrumb, and either a list or a detail. */
    function Panel({ cwd, running, t, onClose }) {
      const [tab, setTab] = react.useState("changes");
      const [dir, setDir] = react.useState("");
      const [selection, setSelection] = react.useState(null);
      const changes = useAsync(() => fetchJson("changes", { cwd }), [cwd, running], cwd !== undefined);

      const goBack = () => {
        if (selection !== null) {
          setSelection(null);
          return;
        }
        if (dir !== "") setDir(dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "");
      };
      const showBack = selection !== null || (tab === "browse" && dir !== "");
      const crumbPath = selection?.path ?? (dir === "" ? t("root") : dir);

      const body = () => {
        if (cwd === undefined) return note(t("noCwd"));
        if (changes.phase === "error") return note(changes.error === "not_a_git_repository" ? t("notGit") : changes.error);
        if (selection !== null) return jsx(Detail, { cwd, selection, running, t });
        if (tab === "browse") {
          return jsx(TreeList, {
            cwd,
            dir,
            running,
            t,
            onOpenDir: setDir,
            onOpenFile: (path) => setSelection({ kind: "file", path, untracked: false }),
          });
        }
        if (changes.data === null) return note(t("loading"));
        return jsx(ChangesList, {
          changes: changes.data,
          t,
          onOpen: (file) => setSelection({ kind: "diff", path: file.path, untracked: file.untracked === true }),
        });
      };

      return jsxs("aside", {
        className: "dsh-dv-panel",
        role: "dialog",
        "aria-label": t("title"),
        children: [
          jsxs("div", {
            className: "dsh-dv-header",
            children: [
              jsx("strong", { className: "dsh-dv-title", children: t("title") }),
              jsxs("span", {
                className: "dsh-dv-branch",
                children: changes.data === null ? null : [
                  jsx(primitives.IconBranchOutline16, { size: 14 }),
                  jsx("span", {
                    children: `${changes.data.branch ?? "?"}@${changes.data.head ?? "?"} · ${changes.data.files.length} ${t("files")}`,
                  }),
                ],
              }),
              jsxs("span", {
                className: "dsh-dv-tabs",
                role: "tablist",
                children: [
                  jsx("button", {
                    type: "button",
                    className: "dsh-dv-tab",
                    role: "tab",
                    "aria-selected": tab === "changes",
                    onClick: () => {
                      setTab("changes");
                      setSelection(null);
                    },
                    children: t("tabChanges"),
                  }),
                  jsx("button", {
                    type: "button",
                    className: "dsh-dv-tab",
                    role: "tab",
                    "aria-selected": tab === "browse",
                    onClick: () => {
                      setTab("browse");
                      setSelection(null);
                    },
                    children: t("tabBrowse"),
                  }),
                ],
              }),
              jsx("button", {
                type: "button",
                className: "dsh-dv-icon",
                "aria-label": t("refresh"),
                title: t("refresh"),
                onClick: () => changes.reload(),
                children: jsx(primitives.IconRefreshOutline16, { size: 16 }),
              }),
              jsx("button", {
                type: "button",
                className: "dsh-dv-icon",
                "aria-label": t("close"),
                title: t("close"),
                onClick: onClose,
                children: jsx(primitives.IconCloseOutline16, { size: 16 }),
              }),
            ],
          }),
          (showBack || selection !== null) && jsxs("div", {
            className: "dsh-dv-crumbs",
            children: [
              jsx("button", {
                type: "button",
                className: "dsh-dv-icon",
                "aria-label": t("back"),
                title: t("back"),
                onClick: goBack,
                children: jsx(primitives.IconChevronLeftOutline14, { size: 14 }),
              }),
              // Reversed direction keeps the file name visible when a deep path
              // overflows, instead of eliding the part that identifies the file.
              jsx("span", { className: "dsh-dv-crumbpath", children: crumbPath }),
            ],
          }),
          jsx("div", { className: "dsh-dv-body", children: body() }),
        ],
      });
    }

    /**
     * Header trigger plus the panel, scoped to one session.
     *
     * The workspace comes from the sessions list store, which is the only client
     * surface carrying it: the per-session conversation snapshot has no cwd.
     * `useSessions` is a standard prop on every slot component and subscribes, so
     * the panel picks the workspace up when the list resolves instead of caching
     * an early undefined (the host's own header rows read `byId[sessionId]` the
     * same way).
     */
    function DiffViewerTrigger({ sessionId, useSession, useSessions, t }) {
      const running = useSession((snapshot) => snapshot.running);
      const [open, setOpen] = react.useState(false);
      const cwd = useSessions((state) => {
        const entry = state?.byId?.[sessionId];
        return typeof entry?.cwd === "string" && entry.cwd !== "" ? entry.cwd : undefined;
      });
      return jsxs("span", {
        className: "dsh-dv-root",
        "data-diff-viewer-session": sessionId,
        children: [
          jsxs("button", {
            type: "button",
            className: "dsh-dv-trigger",
            "aria-label": t("toggle"),
            "aria-expanded": open,
            title: t("toggle"),
            onClick: () => setOpen((value) => !value),
            children: [jsx(primitives.IconCodeOutline16, { size: 16 }), open ? null : jsx("span", { children: t("title") })],
          }),
          open && jsx(Panel, { cwd, running, t, onClose: () => setOpen(false) }),
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
        id: "diff-viewer",
        order: 70,
        locale: NS,
      }, DiffViewerTrigger));
    }

    exports.name = NS;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});

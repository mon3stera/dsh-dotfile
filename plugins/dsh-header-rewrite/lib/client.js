/**
 * Browser half of dsh-header-rewrite: a "Header rewrite" section in the
 * Settings sidebar with a YAML editor for the plugin rules.
 *
 * Hand-written client bundle in the DSH client-modules format
 * (window.__ModuleLoader__.load CJS factory). Persistence goes through the
 * plugin-owned $DSH_HOME/header-rewrite/config.yaml via
 * GET/POST /header-rewrite/config; saving applies the rules immediately on
 * the host without a restart.
 */
window.__ModuleLoader__.load({
  id: "dsh-header-rewrite",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const jsx = require("react/jsx-runtime").jsx;
    const { defineStore } = require("@deepseek-ai/dsh-client-runtime/client");

    const name = "dsh-header-rewrite";
    const inject = ["slots", "locale"];
    const NS = "dsh-header-rewrite";

    const PLUGIN_CSS = [
      ".dhr-group{display:flex;flex-direction:column;gap:10px;padding:2px 2px 4px;max-width:760px}",
      ".dhr-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}",
      ".dhr-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
      ".dhr-editor{box-sizing:border-box;width:100%;min-height:300px;color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px 12px;font-size:12.5px;font-family:var(--ds-font-family-code);line-height:1.6;resize:vertical;tab-size:2;white-space:pre;overflow:auto}",
      ".dhr-editor:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}",
      ".dhr-editor::placeholder{color:var(--dsw-alias-label-tertiary)}",
      ".dhr-footer{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
      ".dhr-save{box-sizing:border-box;height:32px;padding:0 16px;color:#fff;background:var(--dsw-alias-state-business-primary);border:none;border-radius:8px;font-size:13px;cursor:pointer;font-family:inherit}",
      ".dhr-save:disabled{opacity:.5;cursor:default}",
      ".dhr-saved{color:var(--dsw-alias-state-success,#2e7d32);font-size:12px;line-height:32px}",
      ".dhr-error{color:var(--dsw-alias-state-danger,#c62828);font-size:12px;line-height:18px;white-space:pre-wrap}"
    ].join("\n");

    /** Locale dictionaries for the settings section. */
    const zh = {
      "nav": "Header 改写",
      "title": "Header 改写规则",
      "hint": "按 host / path / model / method 匹配请求并改写或删除请求头。保存后立即生效，无需重启。值为 null 表示删除该请求头。",
      "save": "保存",
      "saving": "保存中…",
      "saved": "已保存，立即生效",
      "loadError": "配置加载失败",
      "placeholder": "rules:\n  - match:\n      host: agentrouter.org\n    headers:\n      User-Agent: claude-cli/1.0.0 (external, cli)"
    };
    const en = {
      "nav": "Header rewrite",
      "title": "Header rewrite rules",
      "hint": "Match requests by host / path / model / method and set or delete request headers. Saving takes effect immediately, no restart needed. A value of null deletes the header.",
      "save": "Save",
      "saving": "Saving…",
      "saved": "Saved, active now",
      "loadError": "Failed to load config",
      "placeholder": "rules:\n  - match:\n      host: agentrouter.org\n    headers:\n      User-Agent: claude-cli/1.0.0 (external, cli)"
    };

    /** Mirror store for the section (yaml text + save status). */
    function createStore() {
      return defineStore({
        init: () => ({ yaml: "", status: "idle", error: null, revision: -1 }),
        actions: {
          sync: (d, yaml, status, error, revision) => {
            if (revision <= d.revision) return;
            d.yaml = yaml;
            d.status = status;
            d.error = error;
            d.revision = revision;
          }
        }
      });
    }

    /** Settings > sidebar section: YAML editor + save button + status. */
    function HeaderRewriteSection({ t, useStore, load, save, setYaml }) {
      const s = useStore((st) => st);
      return jsx("div", {
        className: "dhr-group",
        children: [
          jsx("div", { className: "dhr-title", children: t("title") }),
          jsx("div", { className: "dhr-hint", children: t("hint") }),
          jsx("textarea", {
            className: "dhr-editor",
            value: s.yaml,
            placeholder: t("placeholder"),
            spellCheck: false,
            onChange: (e) => { setYaml(e.target.value); }
          }),
          jsx("div", {
            className: "dhr-footer",
            children: [
              jsx("button", {
                type: "button",
                className: "dhr-save",
                onClick: save,
                disabled: s.status === "saving",
                children: s.status === "saving" ? t("saving") : t("save")
              }),
              s.status === "saved" ? jsx("span", { className: "dhr-saved", children: t("saved") }) : null,
              s.status === "error" ? jsx("span", { className: "dhr-error", children: s.error || t("loadError") }) : null
            ]
          })
        ]
      });
    }

    function apply(ctx) {
      const store = createStore();
      let bound = null;
      const state = { yaml: "", status: "idle", error: null, revision: -1 };

      const syncStore = () => {
        if (bound) bound.sync(state.yaml, state.status, state.error, state.revision);
      };
      const commit = (patch) => {
        if (patch.yaml !== undefined) state.yaml = patch.yaml;
        if (patch.status !== undefined) state.status = patch.status;
        if (patch.error !== undefined) state.error = patch.error;
        state.revision += 1;
        syncStore();
      };

      /** Fetch the current config YAML (persisted file, or the seed). */
      const load = () => {
        fetch("/header-rewrite/config")
          .then((response) => (response.ok ? response.json() : null))
          .then((data) => {
            if (!data || typeof data.yaml !== "string") {
              commit({ status: "error", error: t("loadError") });
              return;
            }
            commit({ yaml: data.yaml, status: "idle", error: null });
          })
          .catch(() => {
            commit({ status: "error", error: t("loadError") });
          });
      };

      /** POST the editor text; the host validates, persists, and applies it. */
      const save = () => {
        commit({ status: "saving", error: null });
        fetch("/header-rewrite/config", {
          method: "POST",
          headers: { "Content-Type": "text/yaml" },
          body: state.yaml
        })
          .then(async (response) => {
            if (response.ok) {
              commit({ status: "saved", error: null });
              return;
            }
            const body = await response.json().catch(() => ({}));
            commit({ status: "error", error: body.error || t("loadError") });
          })
          .catch(() => {
            commit({ status: "error", error: t("loadError") });
          });
      };

      const setYaml = (text) => {
        commit({ yaml: text, status: "idle", error: null });
      };

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-header-rewrite: section dictionaries");
      ctx.effect(() => {
        document.querySelectorAll('style[data-plugin-css="dsh-header-rewrite/ui.css"]').forEach((el) => el.remove());
        const tag = document.createElement("style");
        tag.dataset.plugin = name;
        tag.dataset.pluginCss = "dsh-header-rewrite/ui.css";
        tag.textContent = PLUGIN_CSS;
        document.head.appendChild(tag);
      }, "dsh-header-rewrite: section styles");

      const injected = (actions) => {
        bound = actions;
        syncStore();
        return { load, save, setYaml };
      };

      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "header-rewrite",
        order: 30,
        label: () => ctx.locale.bind(NS)("nav"),
        locale: NS,
        store,
        inject: injected
      }, HeaderRewriteSection));

      load();
    }

    exports.name = name;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});

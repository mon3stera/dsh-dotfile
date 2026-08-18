/**
 * Browser half of dsh-plugin-logo.
 *
 * The built-in brand is one SVG wordmark. Keep the React-owned SVG in the DOM
 * but hide it, then place a sibling replacement so React can continue to own
 * the original node without fighting the plugin.
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-logo",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const name = "dsh-plugin-logo";
    const SVG_NS = "http://www.w3.org/2000/svg";
    const FULL_VIEWBOX = "0 0 182 24";
    const COMPACT_VIEWBOX = "0 0 23.16 17.04";
    const MARK_URL = "/logo/mark";
    const WORDMARK_URL = "/logo/wordmark";
    const replacements = new Map();
    let harnessId = 0;

    const CSS = `
svg[data-dsh-logo-source]{display:none!important}
.dsh-plugin-logo-full{box-sizing:border-box;display:inline-flex;align-items:center;flex:none;min-width:0;height:24px;gap:6px;line-height:0;color:var(--dsw-alias-label-primary)}
.dsh-plugin-logo-mark{display:block;flex:none;width:26px;height:24px;object-fit:contain}
.dsh-plugin-logo-wordmark{display:block;flex:none;width:auto;max-width:98px;height:16px;object-fit:contain}
.dsh-plugin-logo-harness{display:block;flex:none;width:52px;height:24px;overflow:visible;color:var(--dsw-alias-label-primary)}
.dsh-plugin-logo-compact{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:none;width:24px;height:24px;line-height:0;color:var(--dsw-alias-label-primary)}
body:not([data-ds-dark-theme]) .dsh-plugin-logo-mark{filter:invert(1)}
`;

    function injectCss() {
      document.querySelectorAll(`style[data-plugin-css="${name}/ui.css"]`).forEach((element) => element.remove());
      const style = document.createElement("style");
      style.dataset.plugin = name;
      style.dataset.pluginCss = `${name}/ui.css`;
      style.textContent = CSS;
      document.head.appendChild(style);
      return style;
    }

    function createImage(url, className, alt) {
      const image = document.createElement("img");
      image.className = className;
      image.src = url;
      image.alt = alt;
      image.decoding = "async";
      image.draggable = false;
      return image;
    }

    /** Clone the original Harness badge paths into a small inline SVG. */
    function createHarness(source) {
      const rect = Array.from(source.children).find((child) => (
        child.localName === "rect" && child.getAttribute("x") === "129.348" && child.getAttribute("width") === "52"
      ));
      const badgeGroup = Array.from(source.children).find((child) => (
        child.localName === "g" && String(child.getAttribute("clip-path") || "").includes("badge-clip")
      ));
      const badgeClip = source.querySelector('clipPath[id*="badge-clip"]');
      if (!rect || !badgeGroup || !badgeClip) {
        const fallback = document.createElement("span");
        fallback.className = "dsh-plugin-logo-harness-fallback";
        fallback.textContent = "Harness";
        return fallback;
      }

      harnessId += 1;
      const clipId = `${name}-harness-clip-${harnessId}`;
      const svg = document.createElementNS(SVG_NS, "svg");
      svg.classList.add("dsh-plugin-logo-harness");
      svg.setAttribute("viewBox", "129.348 0 52 24");
      svg.setAttribute("aria-hidden", "true");
      svg.setAttribute("focusable", "false");
      svg.appendChild(rect.cloneNode(true));

      const group = badgeGroup.cloneNode(true);
      group.setAttribute("clip-path", `url(#${clipId})`);
      svg.appendChild(group);

      const defs = document.createElementNS(SVG_NS, "defs");
      const clip = badgeClip.cloneNode(true);
      clip.setAttribute("id", clipId);
      defs.appendChild(clip);
      svg.appendChild(defs);
      return svg;
    }

    function createFullReplacement(source) {
      const root = document.createElement("span");
      root.className = "dsh-plugin-logo-full";
      root.dataset.dshLogoReplacement = "full";
      root.setAttribute("role", "img");
      root.setAttribute("aria-label", "Mon3tr Harness");
      root.title = "Mon3tr Harness";
      root.appendChild(createImage(MARK_URL, "dsh-plugin-logo-mark", ""));
      root.appendChild(createImage(WORDMARK_URL, "dsh-plugin-logo-wordmark", ""));
      root.appendChild(createHarness(source));
      return root;
    }

    function createCompactReplacement() {
      const root = document.createElement("span");
      root.className = "dsh-plugin-logo-compact";
      root.dataset.dshLogoReplacement = "compact";
      root.setAttribute("role", "img");
      root.setAttribute("aria-label", "Mon3tr");
      root.title = "Mon3tr";
      root.appendChild(createImage(MARK_URL, "dsh-plugin-logo-mark", ""));
      return root;
    }

    function enhance(source, kind) {
      const current = replacements.get(source);
      if (current) {
        if (current.isConnected) return;
        replacements.delete(source);
      }
      const replacement = kind === "full" ? createFullReplacement(source) : createCompactReplacement();
      source.dataset.dshLogoSource = kind;
      source.parentNode?.insertBefore(replacement, source.nextSibling);
      replacements.set(source, replacement);
    }

    function scan() {
      document.querySelectorAll("svg").forEach((source) => {
        const viewBox = source.getAttribute("viewBox");
        if (viewBox === FULL_VIEWBOX) enhance(source, "full");
        else if (viewBox === COMPACT_VIEWBOX) enhance(source, "compact");
      });
      for (const [source, replacement] of replacements) {
        if (!source.isConnected || !replacement.isConnected) {
          replacement.remove();
          replacements.delete(source);
          if (source.isConnected) source.removeAttribute("data-dsh-logo-source");
        }
      }
    }

    function apply(ctx) {
      const style = injectCss();
      let observer = null;
      let started = false;
      const start = () => {
        if (started) return;
        started = true;
        scan();
        if (typeof MutationObserver === "undefined" || !document.body) return;
        observer = new MutationObserver(scan);
        observer.observe(document.body, { childList: true, subtree: true });
      };
      if (document.body) start();
      else document.addEventListener("DOMContentLoaded", start, { once: true });

      ctx.effect(() => () => {
        if (observer) observer.disconnect();
        document.removeEventListener("DOMContentLoaded", start);
        for (const [source, replacement] of replacements) {
          replacement.remove();
          if (source.isConnected) source.removeAttribute("data-dsh-logo-source");
        }
        replacements.clear();
        style.remove();
      }, `${name}: teardown`);
    }

    const inject = [];
    exports.name = name;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});

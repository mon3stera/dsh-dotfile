/**
 * Browser half of dsh-plugin-logo.
 *
 * The shell exposes branding as three declared `single` slots, so this plugin
 * registers occupants instead of rewriting the DOM:
 *
 *   sidebar.brand.mark          owner props { size }            (wide row + collapsed rail)
 *   sidebar.brand.name          owner props {}                  (occupant owns content and width)
 *   conversation.hero.brand.mark owner props { size, className } (hero headline)
 *
 * `@deepseek-ai/dsh-client-ui-brand-official` already occupies all three at the
 * default priority 0. A `single` slot rejects a second registration at the *same*
 * priority and renders the lowest priority present, so these register at -1 to
 * shadow the shipped occupant while leaving it in place as a fallback.
 *
 * This replaces an earlier DOM-scanning implementation that matched the brand
 * SVG by `viewBox` and hid it behind a sibling. That broke when the shell began
 * rendering the name through `BrandWordmark({ includeMark: false })`, whose
 * viewBox is `26 0 156 24` rather than `0 0 182 24`: the mark still matched, so
 * only the lettering reverted to the stock artwork. Slots carry no such
 * coupling to host geometry.
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-logo",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const { jsx, jsxs } = require("react/jsx-runtime");

    const name = "dsh-plugin-logo";
    const MARK_URL = "/logo/mark";
    const WORDMARK_URL = "/logo/wordmark";
    /** assets/mon3tr-logo.svg is `viewBox="0 0 809 744"`; keep that ratio at any size. */
    const MARK_ASPECT = 809 / 744;
    /** Below the shipped occupant's default 0. For a single slot the lowest priority renders. */
    const PRIORITY = -1;
    const BRAND_SLOTS = ["sidebar.brand.mark", "sidebar.brand.name", "conversation.hero.brand.mark"];

    // The mark art is white-on-transparent, so the light theme inverts it. The
    // wordmark is full-colour and must never be inverted. The badge reproduces
    // the shell's own Harness pill (a 52x14 rx=2 rect filled `currentColor`
    // with inverted lettering); it takes the fill from an explicit token rather
    // than `currentColor`, because within one rule `currentColor` resolves
    // against that same rule's `color` and would paint the pill on itself.
    const CSS = `
.dsh-plugin-logo-mark{display:block;flex:none;object-fit:contain}
body:not([data-ds-dark-theme]) .dsh-plugin-logo-mark{filter:invert(1)}
.dsh-plugin-logo-name{display:inline-flex;align-items:center;gap:6px;min-width:0;line-height:0}
.dsh-plugin-logo-wordmark{display:block;flex:none;width:auto;max-width:98px;height:16px;object-fit:contain}
.dsh-plugin-logo-badge{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:none;height:14px;padding:0 5px;border-radius:2px;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary-inverted);font-size:10px;font-weight:600;line-height:14px;letter-spacing:.02em}
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

    /**
     * The Mon3tr mark. The owner supplies the square edge it wants (24 in the
     * sidebar, 34 in the hero) and the hero also supplies a className carrying
     * its hover animation, so both are honoured.
     */
    function BrandMark({ size, className }) {
      const edge = typeof size === "number" && Number.isFinite(size) && size > 0 ? size : 24;
      return jsx("img", {
        className: className ? `dsh-plugin-logo-mark ${className}` : "dsh-plugin-logo-mark",
        src: MARK_URL,
        alt: "",
        width: Math.round(edge * MARK_ASPECT),
        height: edge,
        decoding: "async",
        draggable: false,
      });
    }

    /**
     * The Mon3tr name plus the Harness badge. The owning row supplies the flex
     * context, so this only contributes its own two children.
     */
    function BrandName() {
      return jsxs("span", {
        className: "dsh-plugin-logo-name",
        children: [
          jsx("img", {
            className: "dsh-plugin-logo-wordmark",
            src: WORDMARK_URL,
            alt: "Mon3tr",
            decoding: "async",
            draggable: false,
          }),
          jsx("span", { className: "dsh-plugin-logo-badge", children: "Harness" }),
        ],
      });
    }

    function apply(ctx) {
      const style = injectCss();
      ctx.effect(() => () => style.remove(), `${name}: styles`);
      // Registered per slot rather than as one nested set, so a shell that stops
      // declaring one of them still gets the other two branded.
      for (const slot of BRAND_SLOTS) {
        const component = slot === "sidebar.brand.name" ? BrandName : BrandMark;
        ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, priority: PRIORITY }, component));
      }
    }

    const inject = ["slots"];
    exports.name = name;
    exports.apply = apply;
    exports.inject = inject;
    exports.BrandMark = BrandMark;
    exports.BrandName = BrandName;
    exports.BRAND_SLOTS = BRAND_SLOTS;
    exports.PRIORITY = PRIORITY;
    return module.exports;
  }
});

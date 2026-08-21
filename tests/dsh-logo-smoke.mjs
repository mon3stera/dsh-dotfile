// Smoke test for dsh-plugin-logo: the asset routes plus the brand-slot contract.
//
// The client half used to find the brand by SVG `viewBox` and hide it behind a
// sibling. That silently half-broke on a DSH update, so the interesting checks
// here are the cross-checks against the installed host: the slots must still be
// declared, and the shipped occupant must still sit at a priority this plugin
// can shadow.
import { readFileSync, globSync } from "node:fs";
import vm from "node:vm";

let checks = 0;
function ok(condition, message) {
  checks += 1;
  if (!condition) throw new Error(`FAIL: ${message}`);
}
function eq(actual, expected, message) {
  ok(actual === expected, `${message} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

const HOST_PACKAGES = "/home/mon3tr/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai";

// ------------------------------------------------------------------ node half
const host = await import("../plugins/dsh-plugin-logo/lib/index.js");
eq(host.name, "dsh-plugin-logo", "host plugin name");
ok(typeof host.apply === "function", "host exports apply");
ok(typeof host.handleLogoAsset === "function", "host exports the asset handler");

function serve(method, url) {
  const captured = { status: 0, headers: {}, body: undefined, ended: false };
  const res = {
    writeHead(status, headers) { captured.status = status; captured.headers = headers ?? {}; },
    end(body) { captured.body = body; captured.ended = true; },
  };
  host.handleLogoAsset({ method, url }, res);
  return captured;
}

for (const [path, alt] of [["/logo/mark", "mark"], ["/logo/wordmark", "wordmark"]]) {
  const served = serve("GET", path);
  eq(served.status, 200, `${alt} route responds 200`);
  eq(served.headers["content-type"], "image/svg+xml", `${alt} served as SVG`);
  ok(Number(served.headers["content-length"]) > 0, `${alt} declares a length`);
  ok(served.body.includes("<svg"), `${alt} body is an SVG document`);
  ok(served.headers["cache-control"].includes("immutable"), `${alt} is immutably cacheable`);
}
const head = serve("HEAD", "/logo/mark");
eq(head.status, 200, "HEAD is allowed");
eq(head.body, undefined, "HEAD sends no body");
eq(serve("GET", "/logo/nope").status, 404, "unknown asset is 404");
eq(serve("POST", "/logo/mark").status, 405, "writes are refused");

// Asset expectations the client's styling depends on: the mark is
// white-on-transparent (inverted in the light theme), the wordmark is not.
const markSvg = readFileSync(new URL("../plugins/dsh-plugin-logo/assets/mon3tr-logo.svg", import.meta.url), "utf8");
const wordmarkSvg = readFileSync(new URL("../plugins/dsh-plugin-logo/assets/mon3tr-wordmark.svg", import.meta.url), "utf8");
ok(markSvg.includes('viewBox="0 0 809 744"'), "mark viewBox matches the aspect ratio the client applies");
ok(markSvg.includes('fill="white"'), "mark art is white, so light-theme inversion is required");
ok(!wordmarkSvg.includes('fill="white"'), "wordmark is full-colour and must not be inverted");

// ---------------------------------------------------------------- client half
const raw = readFileSync(new URL("../plugins/dsh-plugin-logo/lib/client.js", import.meta.url), "utf8");
let captured;
globalThis.window = { __ModuleLoader__: { load: (entry) => { captured = entry; } } };
const styleTags = [];
globalThis.document = {
  head: { appendChild: (tag) => styleTags.push(tag) },
  createElement: () => ({ dataset: {}, textContent: "", remove() {} }),
  querySelectorAll: () => [],
};
vm.runInThisContext(raw, { filename: "dsh-plugin-logo/lib/client.js" });
eq(captured?.id, "dsh-plugin-logo", "client module id");

const client = captured.factory((spec) => {
  if (spec === "react/jsx-runtime") {
    return { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) };
  }
  throw new Error(`unexpected require: ${spec}`);
});
eq(client.name, "dsh-plugin-logo", "client plugin name");
eq(JSON.stringify(client.inject), JSON.stringify(["slots"]), "client injects the slot registry");
ok(!raw.includes("MutationObserver"), "the DOM-scanning implementation is gone");
ok(!raw.includes('getAttribute("viewBox")'), "no longer identifies the brand by host geometry");
ok(!raw.includes('querySelectorAll("svg")'), "no longer sweeps the document for SVGs");
ok(!raw.includes("insertBefore"), "no longer injects a sibling next to a React-owned node");

const registrations = [];
const ctx = {
  effect(callback) { callback(); },
  slots: {
    inject(name, callback) { callback(); },
    register(options, component) { registrations.push({ ...options, component }); return () => {}; },
  },
};
client.apply(ctx);
eq(styleTags.length, 1, "one style tag injected");
eq(styleTags[0].dataset.plugin, "dsh-plugin-logo", "style tag attributed to the plugin");

eq(registrations.length, 3, "all three brand slots are occupied");
const bySlot = new Map(registrations.map((entry) => [entry.name, entry]));
for (const slot of ["sidebar.brand.mark", "sidebar.brand.name", "conversation.hero.brand.mark"]) {
  ok(bySlot.has(slot), `registers ${slot}`);
  eq(bySlot.get(slot).priority, -1, `${slot} registered below the shipped occupant`);
}
eq(bySlot.get("sidebar.brand.mark").component, client.BrandMark, "sidebar mark uses the mark component");
eq(bySlot.get("conversation.hero.brand.mark").component, client.BrandMark, "hero mark uses the mark component");
eq(bySlot.get("sidebar.brand.name").component, client.BrandName, "name slot uses the name component");

// The mark must honour the owner's requested edge and keep the art's ratio.
const sidebarMark = client.BrandMark({ size: 24 });
eq(sidebarMark.type, "img", "the mark renders an image");
eq(sidebarMark.props.height, 24, "sidebar mark honours size 24");
eq(sidebarMark.props.width, Math.round(24 * (809 / 744)), "sidebar mark keeps the art aspect ratio");
eq(sidebarMark.props.src, "/logo/mark", "mark points at the served asset");
eq(sidebarMark.props.alt, "", "the mark is decorative; the owning row labels it");
const heroMark = client.BrandMark({ size: 34, className: "pXSMma_fish" });
eq(heroMark.props.height, 34, "hero mark honours size 34");
ok(heroMark.props.className.includes("pXSMma_fish"), "hero className is forwarded so its animation still applies");
ok(heroMark.props.className.includes("dsh-plugin-logo-mark"), "plugin class kept alongside the owner's");
eq(client.BrandMark({}).props.height, 24, "a missing size falls back to 24");
eq(client.BrandMark({ size: 0 }).props.height, 24, "a nonsense size falls back to 24");
eq(client.BrandMark({ size: Number.NaN }).props.height, 24, "NaN size falls back to 24");

const brandName = client.BrandName();
const nameChildren = brandName.props.children;
eq(nameChildren.length, 2, "the name is the wordmark plus the badge");
eq(nameChildren[0].props.src, "/logo/wordmark", "wordmark points at the served asset");
eq(nameChildren[0].props.alt, "Mon3tr", "the wordmark carries the accessible brand name");
eq(nameChildren[1].props.children, "Harness", "the Harness badge is reproduced locally");

// Light-theme inversion applies to the mark only.
const css = styleTags[0].textContent;
ok(/body:not\(\[data-ds-dark-theme\]\) \.dsh-plugin-logo-mark\{filter:invert\(1\)\}/.test(css), "mark inverted in the light theme");
ok(!/\.dsh-plugin-logo-wordmark\{[^}]*invert/.test(css), "wordmark never inverted");
// `background: currentColor` in the same rule as `color` would paint the pill on
// itself, so the badge fill must come from an explicit token.
ok(/\.dsh-plugin-logo-badge\{[^}]*background:var\(--dsw-alias-label-primary\)/.test(css), "badge fill uses an explicit token");
ok(/\.dsh-plugin-logo-badge\{[^}]*color:var\(--dsw-alias-label-primary-inverted\)/.test(css), "badge lettering is inverted, like the shell's own pill");
ok(!/\.dsh-plugin-logo-badge\{[^}]*background:currentColor/.test(css), "badge avoids the currentColor self-reference");

// ------------------------------------------------- installed-host cross-checks
// These are the checks that would have caught the regression: the plugin depends
// on host declarations, so a rename or a kind change must fail here.
const sidebarSource = readFileSync(`${HOST_PACKAGES}/dsh-client-ui-sidebar/lib/client.js`, "utf8");
const conversationSource = readFileSync(`${HOST_PACKAGES}/dsh-client-ui-conversation/lib/client.js`, "utf8");
for (const [slot, source, label] of [
  ["sidebar.brand.mark", sidebarSource, "sidebar"],
  ["sidebar.brand.name", sidebarSource, "sidebar"],
  ["conversation.hero.brand.mark", conversationSource, "conversation"],
]) {
  const declaration = new RegExp(`"${slot.replace(/\./g, "\\.")}":\\s*\\{\\s*kind: "single"`);
  ok(declaration.test(source), `${label} still declares ${slot} as a single slot`);
  ok(source.includes(`renderSlot("${slot}"`), `${label} still renders ${slot}`);
}
ok(sidebarSource.includes('renderSlot("sidebar.brand.mark", { size: 24 }'), "sidebar still passes size 24 to the mark");
ok(/renderSlot\("conversation\.hero\.brand\.mark", \{\s*size: 34/.test(conversationSource), "hero still passes size 34 to the mark");

// The shipped occupant must stay at the default priority, or -1 would no longer
// shadow it (and an equal priority throws instead of winning).
const officialSource = readFileSync(`${HOST_PACKAGES}/dsh-client-ui-brand-official/lib/client.js`, "utf8");
for (const slot of ["sidebar.brand.mark", "sidebar.brand.name", "conversation.hero.brand.mark"]) {
  ok(officialSource.includes(`{ name: "${slot}" }`), `the shipped occupant registers ${slot} without a priority`);
}
ok(!officialSource.includes("priority"), "the shipped occupant sets no priority, so it stays at the default 0");

// And the runtime rule this plugin relies on: a second registration at the same
// priority throws, and the lowest priority renders.
const bundlePaths = globSync(`${HOST_PACKAGES}/dsh-web-frontend/dist/assets/index-*.js`);
ok(bundlePaths.length > 0, "installed frontend bundle located");
const bundle = readFileSync(bundlePaths[0], "utf8");
ok(bundle.includes("register at a different priority to shadow it (lowest renders)"), "shadowing by priority is still the documented rule");
ok(/single slot "\$\{[a-zA-Z$_.]+\}" already has a registration/.test(bundle), "an equal-priority single registration still throws");
ok(/priority\?\?0\)-\([a-zA-Z$_]+\.options\.priority\?\?0\)/.test(bundle), "entries are still ordered ascending by priority");

// The wordmark viewBox that the old DOM-scanning implementation matched is now
// conditional, which is exactly how that approach broke. Pin the shape so the
// comment in the client stays true.
ok(bundle.includes('viewBox:l?"0 0 182 24":"26 0 156 24"'), "BrandWordmark still swaps viewBox on includeMark");
ok(officialSource.includes("includeMark: false"), "the shipped name occupant still renders the mark-less wordmark");

console.log(`logo ok (${checks} checks)`);

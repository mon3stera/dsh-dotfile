// Smoke test for dsh-plugin-diff-viewer: host git routes plus the client contract.
//
// The host half is exercised against a real throwaway git repository, so the
// parsing is checked against actual `git diff` output rather than a fixture that
// could drift from what git emits.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync, globSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

let checks = 0;
function ok(condition, message) {
  checks += 1;
  if (!condition) throw new Error(`FAIL: ${message}`);
}
function eq(actual, expected, message) {
  ok(actual === expected, `${message} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

const host = await import("../plugins/dsh-plugin-diff-viewer/lib/index.js");
eq(host.name, "dsh-plugin-diff-viewer", "host plugin name");
ok(typeof host.apply === "function", "host exports apply");

// ---------------------------------------------------------------- diff parsing
const sample = [
  "diff --git a/src/a.js b/src/a.js",
  "index 111..222 100644",
  "--- a/src/a.js",
  "+++ b/src/a.js",
  "@@ -1,4 +1,4 @@ function head()",
  " keep one",
  "-old line",
  "+new line",
  " keep two",
  "\\ No newline at end of file",
  "diff --git a/bin/blob b/bin/blob",
  "Binary files a/bin/blob and b/bin/blob differ",
  "diff --git a/fresh.txt b/fresh.txt",
  "--- /dev/null",
  "+++ b/fresh.txt",
  "@@ -0,0 +1,2 @@",
  "+alpha",
  "+beta",
].join("\n");
const parsed = host.parseUnifiedDiff(sample);
eq(parsed.length, 3, "three files parsed");
eq(parsed[0].path, "src/a.js", "first path stripped of a// b/ prefix");
eq(parsed[0].hunks.length, 1, "one hunk");
eq(parsed[0].hunks[0].heading, "function head()", "hunk section heading captured");
const rows = parsed[0].hunks[0].rows;
eq(rows.length, 4, "no-newline marker dropped, four real rows");
eq(rows.map((r) => r.kind).join(","), "ctx,del,add,ctx", "row kinds in order");
eq(rows[0].oldNo, 1, "context keeps old number");
eq(rows[0].newNo, 1, "context keeps new number");
eq(rows[1].oldNo, 2, "deletion advances old only");
eq(rows[1].newNo, null, "deletion has no new number");
eq(rows[2].oldNo, null, "addition has no old number");
eq(rows[2].newNo, 2, "addition advances new only");
eq(rows[3].oldNo, 3, "context after edit resyncs old");
eq(rows[3].newNo, 3, "context after edit resyncs new");
eq(parsed[1].binary, true, "binary stanza flagged");
eq(parsed[1].hunks.length, 0, "binary file has no rows");
eq(parsed[2].path, "fresh.txt", "new file takes the +++ path");
eq(parsed[2].hunks[0].rows.every((r) => r.kind === "add"), true, "new file is all additions");

// ------------------------------------------------------- real git repository
const repo = mkdtempSync(join(tmpdir(), "dsh-dv-"));
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
try {
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/keep.js"), "one\ntwo\nthree\n");
  writeFileSync(join(repo, "src/gone.js"), "bye\n");
  writeFileSync(join(repo, ".gitignore"), "ignored.txt\nnode_modules/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");

  // Three kinds of change plus one ignored file that must stay invisible.
  writeFileSync(join(repo, "src/keep.js"), "one\ntwoX\nthree\n");
  writeFileSync(join(repo, "src/new.js"), "fresh\nlines\n");
  writeFileSync(join(repo, "ignored.txt"), "noise\n");
  mkdirSync(join(repo, "node_modules"));
  writeFileSync(join(repo, "node_modules/dep.js"), "dep\n");
  rmSync(join(repo, "src/gone.js"));

  const root = await host.resolveRoot(repo);
  ok(root !== null, "repo resolves to a root");
  eq(await host.resolveRoot("/proc"), null, "non-git directory rejected");
  eq(await host.resolveRoot("relative/path"), null, "relative cwd rejected");
  eq(await host.resolveRoot(""), null, "empty cwd rejected");

  // Confinement: traversal, absolute escape, and .git are all refused.
  eq(await host.confine(root, "../etc/passwd"), null, "parent traversal refused");
  eq(await host.confine(root, "/etc/passwd"), null, "absolute path outside root refused");
  eq(await host.confine(root, ".git/config"), null, "git internals hidden");
  eq((await host.confine(root, "src/keep.js"))?.rel, "src/keep.js", "in-repo path accepted");
  eq((await host.confine(root, `${root}/src/keep.js`))?.rel, "src/keep.js", "absolute in-repo path accepted");
  eq((await host.confine(root, ""))?.rel, "", "empty path means the root");
  // A symlink escaping the repository must fail on its realpath, not its name.
  symlinkSync("/etc", join(repo, "escape"));
  eq(await host.confine(root, "escape/passwd"), null, "symlink escape refused");

  const changes = await host.collectChanges(root);
  ok(changes.head !== null && changes.head.length > 0, "head short hash present");
  eq(changes.branch, "main", "branch reported");
  const byPath = new Map(changes.files.map((f) => [f.path, f]));
  ok(byPath.has("src/keep.js"), "modified file listed");
  ok(byPath.has("src/new.js"), "untracked file listed");
  ok(byPath.has("src/gone.js"), "deleted file listed");
  eq(byPath.get("src/new.js").untracked, true, "new file marked untracked");
  eq(byPath.get("src/new.js").added, 2, "untracked file gets a counted line total");
  eq(byPath.get("src/new.js").removed, null, "untracked file reports no removals");
  eq(byPath.get("src/keep.js").added, 1, "modified file added count");
  eq(byPath.get("src/keep.js").removed, 1, "modified file removed count");
  eq(byPath.get("src/gone.js").status, "D", "deletion status letter");
  ok(!byPath.has("ignored.txt"), "gitignored file absent from changes");
  ok(![...byPath.keys()].some((p) => p.startsWith("node_modules")), "ignored directory absent from changes");

  const diff = await host.collectDiff(root, "src/keep.js", 3, false);
  eq(diff.binary, false, "text diff not binary");
  ok(diff.hunks.length >= 1, "modified file yields a hunk");
  const kinds = diff.hunks[0].rows.map((r) => r.kind);
  ok(kinds.includes("ctx"), "real git diff carries context rows");
  ok(kinds.includes("add") && kinds.includes("del"), "real git diff carries add and del rows");

  const untrackedDiff = await host.collectDiff(root, "src/new.js", 3, true);
  ok(untrackedDiff.hunks.length === 1, "untracked file diffs against empty");
  eq(untrackedDiff.hunks[0].rows.every((r) => r.kind === "add"), true, "untracked diff is all additions");

  const tree = await host.collectTree(root, root);
  const names = tree.entries.map((e) => e.name);
  ok(!names.includes(".git"), "tree hides .git");
  ok(!names.includes("ignored.txt"), "tree hides gitignored file");
  ok(!names.includes("node_modules"), "tree hides ignored directory");
  ok(names.includes("src"), "tree lists tracked directory");
  eq(tree.entries[0].dir, true, "directories sort first");

  const file = await host.collectFile(join(repo, "src/keep.js"), "src/keep.js");
  eq(file.binary, false, "text file not binary");
  eq(file.totalLines, 3, "line count excludes the trailing empty split");
  eq(file.lines[1].text, "twoX", "line content preserved");
  eq(file.lines[1].no, 2, "line numbers are 1-based");
  eq(file.lang, "javascript", "language inferred from extension");

  writeFileSync(join(repo, "blob.bin"), Buffer.from([0x1, 0x0, 0x2, 0x3]));
  const blob = await host.collectFile(join(repo, "blob.bin"), "blob.bin");
  eq(blob.binary, true, "NUL byte marks a binary file");
  eq(await host.collectFile(repo, ""), null, "directory refused by collectFile");
} finally {
  rmSync(repo, { recursive: true, force: true });
}

// -------------------------------------------------------------- client half
const raw = readFileSync(new URL("../plugins/dsh-plugin-diff-viewer/lib/client.js", import.meta.url), "utf8");
let captured;
globalThis.window = { __ModuleLoader__: { load: (entry) => { captured = entry; } } };
const styleTags = [];
globalThis.document = {
  head: { appendChild: (tag) => styleTags.push(tag) },
  createElement: () => ({ dataset: {}, textContent: "", remove() {} }),
};
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
vm.runInThisContext(raw, { filename: "dsh-plugin-diff-viewer/lib/client.js" });
eq(captured?.id, "dsh-plugin-diff-viewer", "client module id");

const react = {
  useState: (value) => [typeof value === "function" ? value() : value, () => {}],
  useMemo: (factory) => factory(),
  useRef: (value) => ({ current: value }),
  useEffect: () => {},
};
const icon = (props) => ({ type: "icon", props });
const client = captured.factory((spec) => {
  if (spec === "react") return react;
  if (spec === "react/jsx-runtime") {
    return { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) };
  }
  if (spec === "@deepseek-ai/dsh-client-ui-primitives") {
    return {
      IconCodeOutline16: icon,
      IconCloseOutline16: icon,
      IconRefreshOutline16: icon,
      IconBranchOutline16: icon,
      IconChevronLeftOutline14: icon,
      IconFolderClose16: icon,
      IconFolderOpen16: icon,
      ReadBlock: (props) => ({ type: "ReadBlock", props }),
    };
  }
  throw new Error(`unexpected require: ${spec}`);
});
eq(client.name, "dsh-plugin-diff-viewer", "client plugin name");
eq(JSON.stringify(client.inject), JSON.stringify(["slots", "locale"]), "client inject contract");

// Mirrors the real SessionListState store: ids/byId/current, never an `items`
// array. The previous double invented `{ items: [...] }`, so the test passed
// while the panel could never resolve a workspace in the browser.
const sessionListState = {
  ids: ["s1", "s2"],
  byId: { s1: { sessionId: "s1", cwd: "/work/repo" }, s2: { sessionId: "s2", cwd: "" } },
  current: "s1",
  phase: "ready",
};
const useSessions = (selector) => selector(sessionListState);
const ctx = {
  entry: null,
  slotName: null,
  locales: null,
  effect(callback) { callback(); },
  get: () => undefined,
  locale: { register: (_ns, dictionaries) => { ctx.locales = dictionaries; } },
  slots: {
    inject(name, callback) { ctx.slotName = name; callback(); },
    register(options, component) { ctx.entry = { ...options, component }; return () => {}; },
  },
};
client.apply(ctx);
eq(ctx.slotName, "conversation.session.header.utilities", "registers on the session header slot");
eq(ctx.entry.id, "diff-viewer", "slot entry id");
eq(ctx.entry.order, 70, "slot order sits before the outline entry at 80");
eq(styleTags.length, 1, "one style tag injected");
eq(styleTags[0].dataset.plugin, "dsh-plugin-diff-viewer", "style tag tagged with the plugin name");

// Locale parity: a missing translation would render a raw key in one language.
const zhKeys = Object.keys(ctx.locales.zh).sort().join(",");
const enKeys = Object.keys(ctx.locales.en).sort().join(",");
eq(zhKeys, enKeys, "zh and en dictionaries cover the same keys");
ok(Object.keys(ctx.locales.zh).length >= 20, "locale dictionary is populated");

// The workspace must come from the sessions list store through the standard
// `useSessions` prop, which is how the host's own header rows read it. A private
// `inject` would freeze whatever the store held at mount.
eq(ctx.entry.inject, undefined, "no private cwd injection; the standard prop carries it");
ok(/useSessions\(\(state\) =>/.test(raw), "component subscribes through useSessions");
ok(/byId\?\.\[sessionId\]/.test(raw), "reads the session entry by id");
ok(!raw.includes('get("sessions")'), "never reaches for the sessions service directly");
ok(!/getSnapshot\(\)\?\.\.?items|\.items\b/.test(raw), "never assumes an items array");

// Cross-check the shape against the installed host UI, which is the contract
// this plugin depends on: a host rename must fail here, not silently in a panel.
const hostHeaderSource = readFileSync(
  new URL("file:///home/mon3tr/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js"),
  "utf8",
);
ok(hostHeaderSource.includes("byId[sessionId]?.cwd"), "host UI still reads cwd from byId[sessionId]");

// The trigger renders closed: a button and no panel.
const t = (key) => ctx.locales.en[key] ?? key;
const tree = ctx.entry.component({
  sessionId: "s1",
  useSession: () => false,
  useSessions,
  t,
});
eq(tree.props.className, "dsh-dv-root", "trigger root class");
eq(tree.props["data-diff-viewer-session"], "s1", "trigger carries the session id");
eq(tree.props.children[0].props["aria-expanded"], false, "panel starts closed");
eq(tree.props.children[1], false, "no panel rendered while closed");

// The selector must resolve exactly what the panel needs, including absence.
eq(useSessions((state) => state.byId.s1.cwd), "/work/repo", "list store carries the workspace");
const readCwd = (sessionId) => {
  const entry = sessionListState.byId?.[sessionId];
  return typeof entry?.cwd === "string" && entry.cwd !== "" ? entry.cwd : undefined;
};
eq(readCwd("s1"), "/work/repo", "resolves the workspace for a listed session");
eq(readCwd("s2"), undefined, "empty cwd is treated as absent");
eq(readCwd("missing"), undefined, "unknown session has no workspace");

// Every route the client calls must exist in the host half.
for (const route of ["changes", "diff", "tree", "file"]) {
  ok(raw.includes(`fetchJson("${route}"`), `client calls the ${route} route`);
  ok(
    readFileSync(new URL("../plugins/dsh-plugin-diff-viewer/lib/index.js", import.meta.url), "utf8")
      .includes(`"/diff-viewer/${route}"`),
    `host registers the ${route} route`,
  );
}

// ------------------------------------------------- file view: host highlighting
// The file view renders through the host's own `ReadBlock`, which highlights via
// the shared `css-variables` Shiki theme. Two contracts must hold: the plugin
// must feed it the shape it destructures, and it must not inherit the collapsing
// default (`maxLines = 16`) that would hide all but 16 lines of every file.
ok(raw.includes("primitives.ReadBlock"), "file view renders the host read block");
ok(/number: line\.no, text: line\.text/.test(raw), "line shape mapped from {no} to {number}");
ok(/maxLines: lines\.length/.test(raw), "maxLines is the served line count, never the collapsing default");
ok(!raw.includes('className: "dsh-dv-no", children: line.no'), "the hand-rolled unhighlighted file rows are gone");

const frontendBundle = globSync(
  "/home/mon3tr/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-*.js",
);
ok(frontendBundle.length > 0, "installed web frontend bundle located");
const frontendSource = readFileSync(frontendBundle[0], "utf8");
// Prop names survive minification because they are destructured from our object.
for (const prop of ["label:", "lines:", "totalLines:", "lang:", "maxLines:"]) {
  ok(frontendSource.includes(prop), `host still destructures ReadBlock's ${prop} prop`);
}
ok(/maxLines:[a-zA-Z$_]+=16/.test(frontendSource), "host ReadBlock still defaults maxLines to 16");

// Which languages actually highlight is host data, not a plugin promise: the
// alias table is the gate, and an unlisted language falls back to plain text
// instead of throwing. Assert the split so a shrinking host table is visible
// here rather than as silently unhighlighted files.
const aliasKeys = new Set([...frontendSource.matchAll(/\["([a-z]+)","([a-z]+)"\]/g)].map((m) => m[1]));
ok(aliasKeys.has("typescript") && aliasKeys.has("python"), "host language alias table found");
const hostSource = readFileSync(new URL("../plugins/dsh-plugin-diff-viewer/lib/index.js", import.meta.url), "utf8");
const langTable = hostSource.slice(
  hostSource.indexOf("const LANG_BY_EXT = {"),
  hostSource.indexOf("};", hostSource.indexOf("const LANG_BY_EXT = {")),
);
const emitted = [...new Set([...langTable.matchAll(/: *"([a-z]+)"/g)].map((m) => m[1]))];
ok(emitted.length >= 30, "language table is populated");
const degrades = emitted.filter((lang) => !aliasKeys.has(lang)).sort();
eq(degrades.join(","), "diff,graphql,svelte,vue", "only the grammars the host does not ship degrade to plain text");
for (const lang of ["typescript", "javascript", "python", "markdown", "bash", "csharp", "mdx"]) {
  ok(emitted.includes(lang) && aliasKeys.has(lang), `${lang} is emitted and highlightable`);
}

// ------------------------------------------------------- panel legibility CSS
// `--dsw-alias-bg-base` is forced to `transparent` by dsh-plugin-background
// while a wallpaper is on, so a panel painted with it disappears. The floating
// surface token stays opaque and the wallpaper plugin never overrides it.
const css = styleTags[0].textContent;
ok(/\.dsh-dv-panel\{[^}]*backdrop-filter:blur\(/.test(css), "panel frosts its backdrop");
ok(/\.dsh-dv-panel\{[^}]*color-mix\(in oklab,var\(--dsw-alias-bg-layer-1\)/.test(css), "panel fill is the floating surface token, not bg-base");
ok(!/\.dsh-dv-panel\{[^}]*background:var\(--dsw-alias-bg-base\)/.test(css), "panel no longer depends on the wallpaper-neutralized token");
ok(css.includes("@supports not (backdrop-filter:blur(1px))"), "opaque fallback where backdrop-filter is unsupported");
ok(/\.dsh-dv-tab\[aria-selected=true\]\{background:var\(--dsw-alias-bg-layer-1\)/.test(css), "selected tab keeps a fill over a wallpaper");
// The sticky hunk header carried only a 6-8% tint, so diff rows scrolled
// visibly through it.
ok(/\.dsh-dv-hunk\{[^}]*background-color:var\(--dsw-alias-bg-layer-1\)/.test(css), "sticky hunk header sits on an opaque base");
ok(/\.dsh-dv-hunk\{[^}]*linear-gradient\(var\(--dsw-alias-interactive-bg-hover\)/.test(css), "hunk tint composited over that base");
ok(css.includes(".dsh-dv-read{margin:0}"), "read block starts flush in the scrolling body");

console.log(`diff-viewer ok (${checks} checks)`);

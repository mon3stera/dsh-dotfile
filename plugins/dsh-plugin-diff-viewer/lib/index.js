/**
 * Node half of dsh-plugin-diff-viewer: read-only git-backed browsing routes.
 *
 *   GET /diff-viewer/changes?cwd=      - files differing from HEAD, with counts
 *   GET /diff-viewer/diff?cwd=&path=   - one file's hunks against HEAD
 *   GET /diff-viewer/tree?cwd=&path=   - one directory listing, git-ignored aside
 *   GET /diff-viewer/file?cwd=&path=   - one file's text, line-numbered
 *
 * The baseline is deliberately HEAD, not a session snapshot: a commit is the
 * natural review boundary, so committing resets the view instead of letting a
 * long-lived session accumulate unbounded noise.
 *
 * Nothing here writes. Every route is a GET, no handler mutates the work tree,
 * and the git invocations are all read-only queries.
 *
 * Confinement: `cwd` must resolve inside a git repository, and the repository
 * root becomes the only reachable subtree. `path` is always resolved through
 * `realpath` and re-checked against that root, so neither `..` nor a symlink
 * can escape it, and `.git` itself stays hidden. The DSH web server is
 * localhost-only and unauthenticated, exactly like the existing plugin routes;
 * requiring a git repository keeps this from becoming a general file-read API,
 * but it is not an authorization boundary - see docs/diff-viewer.md.
 */
import { execFile } from "node:child_process";
import { readFile, realpath, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const name = "dsh-plugin-diff-viewer";

/** Hard ceiling on any single git invocation's stdout. */
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
/** Hard ceiling on a file served to the viewer. */
const FILE_MAX_BYTES = 2 * 1024 * 1024;
/** Rows kept per file view before truncation is reported. */
const FILE_MAX_LINES = 6000;
/** Rows kept per diff before truncation is reported. */
const DIFF_MAX_ROWS = 8000;
/** Entries returned for one directory. */
const TREE_MAX_ENTRIES = 2000;
/** Untracked files whose line counts are computed per changes request. */
const UNTRACKED_COUNT_LIMIT = 200;
/** Default context lines around each hunk. */
const DEFAULT_CONTEXT = 3;

/** Extension -> highlighter language id understood by the client primitives. */
const LANG_BY_EXT = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  json: "json", jsonc: "json", md: "markdown", markdown: "markdown",
  yml: "yaml", yaml: "yaml", toml: "toml", ini: "ini",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  py: "python", rb: "ruby", rs: "rust", go: "go", java: "java",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cxx: "cpp",
  css: "css", scss: "scss", less: "less", html: "html", xml: "xml",
  sql: "sql", lua: "lua", php: "php", swift: "swift", kt: "kotlin",
  vue: "vue", svelte: "svelte", graphql: "graphql", diff: "diff",
};

/**
 * Infer a highlighter language from a path.
 * @param path - repository-relative or absolute path.
 * @returns a language id, or undefined when unknown.
 */
function langOf(path) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (base === "Dockerfile" || base.startsWith("Dockerfile.")) return "dockerfile";
  if (base === "Makefile") return "makefile";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return LANG_BY_EXT[base.slice(dot + 1).toLowerCase()];
}

/**
 * Run one read-only git command.
 * @param root - working directory for the invocation.
 * @param args - argv after `git`.
 * @returns `{ ok, stdout, stderr, code }`; `ok` is false only on a real
 *   failure, because `git diff` uses exit code 1 to mean "differences found".
 */
function git(root, args) {
  return new Promise((done) => {
    execFile(
      "git",
      ["--no-optional-locks", ...args],
      { cwd: root, maxBuffer: GIT_MAX_BUFFER, encoding: "utf8", timeout: 20000 },
      (error, stdout, stderr) => {
        const code = error?.code;
        if (error !== null && code !== 1) done({ ok: false, stdout: stdout ?? "", stderr: stderr ?? String(error), code });
        else done({ ok: true, stdout: stdout ?? "", stderr: stderr ?? "", code: code ?? 0 });
      },
    );
  });
}

/**
 * Resolve a caller-supplied cwd to its git repository root.
 * @param cwd - absolute path from the request.
 * @returns the repository root, or null when absent or not a repository.
 */
export async function resolveRoot(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0 || !isAbsolute(cwd)) return null;
  let real;
  try {
    real = await realpath(cwd);
    if (!(await stat(real)).isDirectory()) return null;
  } catch {
    return null;
  }
  const top = await git(real, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return null;
  const line = top.stdout.trim();
  if (line.length === 0) return null;
  try {
    return await realpath(line);
  } catch {
    return null;
  }
}

/**
 * Resolve a repository-relative path and prove it stays inside the root.
 *
 * The check runs on the realpath, so a symlink pointing outside is rejected
 * even though its lexical path looks contained. A path that does not exist yet
 * is resolved lexically instead, which is enough for the deleted-file case.
 * @param root - repository root, already canonical.
 * @param rel - untrusted repository-relative path ("" means the root).
 * @returns `{ abs, rel }`, or null when the path escapes or is inside `.git`.
 */
export async function confine(root, rel) {
  if (typeof rel !== "string") return null;
  if (rel.split("/").includes("..")) return null;
  // An absolute path is resolved as given, never reinterpreted as relative, so
  // /etc/passwd fails the containment check below instead of silently becoming
  // <root>/etc/passwd. Relative input is joined onto the root as usual.
  const lexical = isAbsolute(rel) ? resolve(rel) : rel.length === 0 ? root : resolve(root, rel);
  let abs = lexical;
  try {
    abs = await realpath(lexical);
  } catch {
    // Missing path (a deletion): keep the lexical resolution.
  }
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  const inside = abs === root ? "" : relative(root, abs);
  if (inside === ".git" || inside.startsWith(`.git${sep}`)) return null;
  return { abs, rel: inside.split(sep).join("/") };
}

/**
 * Parse `git diff` unified output into per-file hunk rows.
 *
 * Row kinds are `ctx`, `add` and `del`; line numbers are carried on each row so
 * the client renders a gutter without recomputing anything. A `\ No newline`
 * marker is dropped, and a binary stanza yields `binary: true` with no rows.
 * @param text - raw `git diff` stdout, possibly covering several files.
 * @returns one entry per file in the order git emitted them.
 */
export function parseUnifiedDiff(text) {
  const files = [];
  let file = null;
  let hunk = null;
  let oldNo = 0;
  let newNo = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = { path: "", oldPath: null, binary: false, hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (file === null) continue;
    if (line.startsWith("--- ")) {
      const p = line.slice(4);
      file.oldPath = p === "/dev/null" ? null : p.replace(/^a\//, "");
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4);
      if (p !== "/dev/null") file.path = p.replace(/^b\//, "");
      else if (file.oldPath !== null) file.path = file.oldPath;
      continue;
    }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      file.binary = true;
      continue;
    }
    if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
      if (m === null) continue;
      oldNo = Number(m[1]);
      newNo = Number(m[3]);
      hunk = { header: line, heading: m[5].trim(), oldStart: oldNo, newStart: newNo, rows: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (hunk === null) continue;
    if (line.startsWith("\\")) continue;
    const marker = line[0];
    const text_ = line.slice(1);
    if (marker === " ") hunk.rows.push({ kind: "ctx", text: text_, oldNo: oldNo++, newNo: newNo++ });
    else if (marker === "-") hunk.rows.push({ kind: "del", text: text_, oldNo: oldNo++, newNo: null });
    else if (marker === "+") hunk.rows.push({ kind: "add", text: text_, oldNo: null, newNo: newNo++ });
  }
  // A file whose only difference is its mode carries no +++/--- pair.
  for (const f of files) if (f.path === "" && f.oldPath !== null) f.path = f.oldPath;
  return files;
}

/** Cap a file's hunk rows, reporting how many were dropped. */
function capHunks(hunks, limit) {
  let budget = limit;
  const kept = [];
  for (const hunk of hunks) {
    if (budget <= 0) break;
    if (hunk.rows.length <= budget) {
      kept.push(hunk);
      budget -= hunk.rows.length;
      continue;
    }
    kept.push({ ...hunk, rows: hunk.rows.slice(0, budget) });
    budget = 0;
  }
  const total = hunks.reduce((n, h) => n + h.rows.length, 0);
  return { hunks: kept, truncated: total > limit, totalRows: total };
}

/**
 * Collect the work tree's difference from HEAD.
 * @param root - repository root.
 * @returns `{ head, branch, files }`; `files` merges tracked changes with
 *   untracked files, which git's numstat omits.
 */
export async function collectChanges(root) {
  const [headRes, branchRes, statusRes, numstatRes] = await Promise.all([
    git(root, ["rev-parse", "--short", "HEAD"]),
    git(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    git(root, ["diff", "--numstat", "HEAD", "--"]),
  ]);
  const counts = new Map();
  for (const line of numstatRes.stdout.split("\n")) {
    if (line.length === 0) continue;
    const [added, removed, ...rest] = line.split("\t");
    const path = rest.join("\t");
    if (path.length === 0) continue;
    counts.set(path, {
      added: added === "-" ? null : Number(added),
      removed: removed === "-" ? null : Number(removed),
      binary: added === "-",
    });
  }
  const files = [];
  const seen = new Set();
  const fields = statusRes.stdout.split("\0");
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    let path = entry.slice(3);
    // A rename carries its source path in the next NUL-separated field.
    if (code[0] === "R" || code[0] === "C") i += 1;
    if (seen.has(path)) continue;
    seen.add(path);
    const stats = counts.get(path);
    const untracked = code === "??";
    files.push({
      path,
      status: untracked ? "A" : code.trim() || "M",
      untracked,
      added: stats?.added ?? null,
      removed: stats?.removed ?? null,
      binary: stats?.binary ?? false,
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  await countUntracked(root, files);
  return {
    head: headRes.ok ? headRes.stdout.trim() : null,
    branch: branchRes.ok ? branchRes.stdout.trim() : null,
    files,
  };
}

/**
 * Fill in added-line counts for untracked files.
 *
 * `git diff --numstat HEAD` only knows about tracked paths, so a brand new file
 * would otherwise show no counts at all in the list. The work is bounded by
 * UNTRACKED_COUNT_LIMIT and by the per-file size cap, and `removed` stays null
 * so the row renders a lone `+N` instead of a meaningless `-0`.
 * @param root - repository root.
 * @param files - change entries, mutated in place.
 */
async function countUntracked(root, files) {
  const pending = files.filter((file) => file.untracked && file.added === null).slice(0, UNTRACKED_COUNT_LIMIT);
  await Promise.all(pending.map(async (file) => {
    try {
      const abs = join(root, file.path);
      const info = await stat(abs);
      if (!info.isFile() || info.size > FILE_MAX_BYTES) return;
      const buf = await readFile(abs);
      if (buf.subarray(0, 8000).includes(0)) {
        file.binary = true;
        return;
      }
      let lines = 0;
      for (const byte of buf) if (byte === 10) lines += 1;
      if (buf.length > 0 && buf[buf.length - 1] !== 10) lines += 1;
      file.added = lines;
    } catch {
      // Raced with a deletion: leave the counts unknown rather than failing.
    }
  }));
}

/**
 * Produce one file's diff against HEAD.
 * @param root - repository root.
 * @param rel - repository-relative path.
 * @param context - context lines per hunk.
 * @param untracked - when true, diff against an empty file instead of HEAD.
 * @returns `{ path, binary, hunks, truncated, totalRows }`.
 */
export async function collectDiff(root, rel, context, untracked) {
  const args = untracked
    ? ["diff", "--no-index", `--unified=${context}`, "--", "/dev/null", rel]
    : ["diff", `--unified=${context}`, "HEAD", "--", rel];
  const res = await git(root, args);
  if (!res.ok) return { path: rel, binary: false, hunks: [], truncated: false, totalRows: 0, error: res.stderr.trim() };
  const parsed = parseUnifiedDiff(res.stdout);
  const file = parsed.find((f) => f.path === rel) ?? parsed[0] ?? null;
  if (file === null) return { path: rel, binary: false, hunks: [], truncated: false, totalRows: 0 };
  const capped = capHunks(file.hunks, DIFF_MAX_ROWS);
  return { path: rel, binary: file.binary, ...capped };
}

/**
 * List one directory, hiding `.git` and anything git ignores.
 * @param root - repository root.
 * @param dir - absolute directory inside the root.
 * @returns `{ entries, truncated }` with directories first.
 */
export async function collectTree(root, dir) {
  const names = await readdir(dir, { withFileTypes: true });
  const candidates = names.filter((e) => !(dir === root && e.name === ".git"));
  const rels = candidates.map((e) => relative(root, join(dir, e.name)).split(sep).join("/"));
  // One batched query instead of a per-entry `check-ignore`: `--directory`
  // collapses an ignored directory to a single entry, so a tree carrying
  // node_modules stays cheap. The pathspec keeps the answer scoped to this
  // directory rather than the whole repository.
  const scope = relative(root, dir).split(sep).join("/");
  const listed = await git(root, [
    "ls-files", "--ignored", "--exclude-standard", "--others", "--directory", "-z",
    "--", scope.length === 0 ? "." : scope,
  ]);
  const ignored = new Set();
  for (const p of listed.stdout.split("\0")) {
    if (p.length > 0) ignored.add(p.replace(/\/$/, ""));
  }
  const entries = [];
  for (const [i, e] of candidates.entries()) {
    if (ignored.has(rels[i])) continue;
    entries.push({ name: e.name, path: rels[i], dir: e.isDirectory() });
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return { entries: entries.slice(0, TREE_MAX_ENTRIES), truncated: entries.length > TREE_MAX_ENTRIES };
}

/**
 * Read one file as numbered lines.
 * @param abs - absolute path inside the repository root.
 * @param rel - repository-relative path, used for language inference.
 * @returns `{ lines, totalLines, truncated, lang, binary, bytes }`.
 */
export async function collectFile(abs, rel) {
  const info = await stat(abs);
  if (info.isDirectory()) return null;
  if (info.size > FILE_MAX_BYTES) {
    return { lines: [], totalLines: 0, truncated: true, lang: langOf(rel), binary: false, bytes: info.size, tooLarge: true };
  }
  const buf = await readFile(abs);
  // A NUL byte in the head is the same heuristic git uses for "binary".
  const binary = buf.subarray(0, 8000).includes(0);
  if (binary) return { lines: [], totalLines: 0, truncated: false, lang: undefined, binary: true, bytes: info.size };
  const all = buf.toString("utf8").split("\n");
  if (all.length > 0 && all[all.length - 1] === "") all.pop();
  const kept = all.slice(0, FILE_MAX_LINES);
  return {
    lines: kept.map((text, i) => ({ no: i + 1, text })),
    totalLines: all.length,
    truncated: all.length > FILE_MAX_LINES,
    lang: langOf(rel),
    binary: false,
    bytes: info.size,
  };
}

/** End a JSON response. */
function writeJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
}

/** Parse the query string of a request URL. */
function query(req) {
  const i = (req.url ?? "").indexOf("?");
  return new URLSearchParams(i === -1 ? "" : req.url.slice(i + 1));
}

/**
 * Shared entry: reject non-GET, resolve the root, and hand off.
 * @param handler - receives `(root, params, res)`.
 * @returns an HTTP handler.
 */
function route(handler) {
  return async (req, res) => {
    if (req.method !== "GET") {
      writeJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    const params = query(req);
    const root = await resolveRoot(params.get("cwd") ?? "");
    if (root === null) {
      writeJson(res, 404, { error: "not_a_git_repository" });
      return;
    }
    try {
      await handler(root, params, res);
    } catch (error) {
      writeJson(res, 500, { error: "internal", detail: String(error?.message ?? error) });
    }
  };
}

const handleChanges = route(async (root, _params, res) => {
  writeJson(res, 200, { root, ...(await collectChanges(root)) });
});

const handleDiff = route(async (root, params, res) => {
  const target = await confine(root, params.get("path") ?? "");
  if (target === null || target.rel === "") {
    writeJson(res, 400, { error: "bad_path" });
    return;
  }
  const rawContext = Number(params.get("context") ?? DEFAULT_CONTEXT);
  const context = Number.isFinite(rawContext) ? Math.min(Math.max(Math.trunc(rawContext), 0), 32) : DEFAULT_CONTEXT;
  const untracked = params.get("untracked") === "1";
  writeJson(res, 200, await collectDiff(root, target.rel, context, untracked));
});

const handleTree = route(async (root, params, res) => {
  const target = await confine(root, params.get("path") ?? "");
  if (target === null) {
    writeJson(res, 400, { error: "bad_path" });
    return;
  }
  writeJson(res, 200, { path: target.rel, ...(await collectTree(root, target.abs)) });
});

const handleFile = route(async (root, params, res) => {
  const target = await confine(root, params.get("path") ?? "");
  if (target === null || target.rel === "") {
    writeJson(res, 400, { error: "bad_path" });
    return;
  }
  const payload = await collectFile(target.abs, target.rel);
  if (payload === null) {
    writeJson(res, 400, { error: "is_a_directory" });
    return;
  }
  writeJson(res, 200, { path: target.rel, ...payload });
});

/**
 * Register the viewer routes when the optional Host HTTP service is composed.
 * @param ctx - plugin context.
 */
export function apply(ctx) {
  ctx.inject(["webServer"], (httpCtx) => {
    for (const [path, handler] of [
      ["/diff-viewer/changes", handleChanges],
      ["/diff-viewer/diff", handleDiff],
      ["/diff-viewer/tree", handleTree],
      ["/diff-viewer/file", handleFile],
    ]) {
      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: "exact", path, handler }),
        `dsh-plugin-diff-viewer: ${path}`,
      );
    }
  });
}

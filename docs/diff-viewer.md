# Diff Viewer

`dsh-plugin-diff-viewer` adds a read-only view of the working set to a DSH Web
session: what differs from the last commit, and what any file in the repository
currently contains. It is display-only by design - no editing, no staging, no
revert.

## Why git, and why HEAD

Two design choices shape everything else.

**Git is the source of truth, not the tool calls.** Reconstructing changes from
`edit` and `write` tool calls would miss every change made another way: `sed -i`,
a heredoc, `rsync`, a build script, a `git checkout`. Those edits are exactly the
ones a reviewer most wants to see, because no diff card was ever rendered for
them. Git sees all of them.

**The baseline is HEAD, not session start.** A session-start baseline grows
without bound in the workflow this profile is built for, where one session is
deliberately reused across many commits. Diffing against HEAD instead means the
panel always answers "what have I not committed yet", and each commit re-bases
the view automatically.

## Routes

All four are `GET`, live under `/diff-viewer/`, and take `cwd` (the session's
working directory):

| Route | Extra parameters | Returns |
| --- | --- | --- |
| `changes` | - | `{ root, head, branch, files[] }` |
| `diff` | `path`, `context`, `untracked` | `{ path, binary, hunks[], truncated }` |
| `tree` | `path` | `{ path, entries[], truncated }` |
| `file` | `path` | `{ path, lines[], totalLines, truncated, lang, binary }` |

`changes` merges two sources, because neither is complete on its own:
`git status --porcelain -z -uall` supplies the file list and status letters,
while `git diff --numstat HEAD` supplies the counts. Untracked files are absent
from numstat, so their added-line totals are counted directly, bounded by
`UNTRACKED_COUNT_LIMIT` and the per-file size cap. Their `removed` stays `null`
so a row shows a lone `+N` rather than a meaningless `-0`.

`diff` parses `git diff` output into rows of kind `ctx`, `add`, or `del`, each
carrying its old and new line number. Context rows are the reason this does not
reuse `DiffBlock` from `dsh-client-ui-primitives`: that component's `buildRows`
emits only `path`, `gap`, `del`, and `add`, so it cannot show unchanged
surroundings. An untracked file is diffed with `--no-index` against `/dev/null`,
which is also why a non-zero git exit code of 1 is treated as success - for
`git diff` it means "differences found", not failure.

## Confinement

The web server is localhost-only and unauthenticated, exactly like the existing
plugin routes, so these routes are written to be uninteresting to abuse:

- `cwd` must resolve, through `realpath`, to a directory inside a git
  repository. The repository root becomes the only reachable subtree. This is
  what keeps the plugin from being a general file-read API.
- `path` is rejected if it contains a `..` segment, and is then resolved with
  `realpath` and re-checked against the root. The check runs on the resolved
  path, so a symlink pointing outside the repository fails even though its
  lexical path looks contained.
- An absolute `path` is resolved as given rather than reinterpreted as
  repository-relative, so `/etc/passwd` fails containment instead of silently
  becoming `<root>/etc/passwd`.
- `.git` itself is hidden.
- Sizes are capped: git stdout, bytes per file, lines per file view, rows per
  diff, and entries per directory.

This is a blast-radius limit, not an authorization boundary. Anyone who can
already reach the DSH web port can also drive the agent, which has full
filesystem access through its own tools.

`tree` additionally hides anything git ignores, resolved with one batched
`git ls-files --ignored --exclude-standard --others --directory` per request.
`--directory` collapses an ignored directory to a single entry, so a repository
containing `node_modules` stays cheap; the pathspec scopes the answer to the
directory being listed rather than the whole repository.

## Client

The browser half follows `dsh-plugin-outline`: a trigger in
`conversation.session.header.utilities` (order 70, before the outline's 80) plus
a `position: fixed` panel, rather than taking over `shell.overlay`. The panel
has a changes tab and a files tab, and a selected file replaces the list with a
detail view reached through a breadcrumb with a back button.

One non-obvious dependency: the per-session snapshot exposed to slot components
carries no `cwd`. It lives in the sessions *list* store, read with the standard
`useSessions` prop:

```js
const cwd = useSessions((state) => state?.byId?.[sessionId]?.cwd);
```

`useSessions` reaches session-scope slot components because the renderer builds
their props as `standard = { ...cache.root }`, so every slot inherits the root
scope's `useSessions`/`useWorkspaces` — the host's own header rows
(`AgentPresetLabel`, `JobListAction`) read their session fields exactly this way.

This was originally written as a private `resolveCwd` callback reading
`ctx.get("sessions").getSnapshot().items`, which is wrong twice: the service has
no top-level `getSnapshot`, and `SessionListState` is `{ ids, byId, current,
phase, ... }` with no `items` array. The panel therefore always reported "this
session has no working directory". Reading through the selector hook also fixes a
latent race: a callback memoized on mount froze whatever the store held before
the session list resolved, while the hook re-renders when it arrives.

Both views refetch when the session's `running` flag changes, so the change list
refreshes on its own when the agent finishes a turn.

## Deployment notes

The loader entry must be the bare package name:

```yaml
- id: dsh-plugin-diff-viewer
  name: dsh-plugin-diff-viewer
```

A subpath entry such as `dsh-plugin-diff-viewer/client` does not work. The
client bundle is located by resolving `<name>/package.json`, which a subpath
cannot satisfy, so the browser half would never register - and the entry would
also try to load the browser file in Node, where `window` is undefined.

Because the host half is loaded package code, a new DSH process is required
after installing or changing it; a browser refresh alone only picks up client
changes.

# Repository Agent Guide

## Purpose

This repository contains DSH profile overlays and local plugins. The workspace source is the source of truth. Runtime copies under `$DSH_HOME/profiles/node_modules/` are deployment artifacts, not editing targets.

The repository currently has no root `package.json` or unified test runner. Most smoke tests are standalone Node ESM files and intentionally import the installed runtime plugin copy.

## Bootstrap Order

1. Read this file and `docs/context-management.md`.
2. Inspect `git status --short --branch` before changing anything.
3. For context work, read `plugins/dsh-magic-context/lib/engine.js`, `db.js`, `dreamer.js`, `memory.js`, and the relevant smoke test.
4. Check the active profile composition in `profile/agent-presets/context-compact/agent.cordis.yml` and `profile/cordis.patch.example.yml`.
5. Treat files under `plugins/` as canonical. Do not edit the installed copy directly.
6. After plugin changes, mirror the changed plugin to the runtime directory with the documented `rsync` procedure, then run tests against the mirrored copy.

## Repository Layout

```text
docs/
  context-management.md       Context Compact, memory, retrieval, and Dreamer design
  session-outline.md          Outline plugin behavior notes
  diff-viewer.md              Diff viewer routes, confinement, and baseline choice

plugins/
  dsh-magic-context/         Compaction, memories, retrieval, provenance, Dreamer
  dsh-plugin-background/      Wallpaper/background settings and upload routes
  dsh-plugin-font/            Font settings and font discovery
  dsh-plugin-hide-session-titles/  Session-title visibility toggle
  dsh-plugin-outline/         Browser-only session outline panel
  dsh-plugin-diff-viewer/     Read-only git diff and file browser panel
  dsh-plugin-session-id/      Session id label in the session header
  dsh-plugin-logo/            Custom Mon3tr brand mark and name
  dsh-header-rewrite/         Header rewrite for LLM provider requests

profile/
  cordis.patch.example.yml    Example Web profile loader patch
  agent-presets/context-compact/   Context Compact agent composition

tests/
  dsh-context-*.mjs           Context plugin component and integration smoke tests
  dsh-context-bundle-smoke.mjs Bundle manifest and host patch smoke test
  dsh-bg-smoke.mjs            Background plugin smoke test
  dsh-font-smoke.mjs          Font plugin smoke test
  dsh-session-titles-smoke.mjs  Session title plugin smoke test
  dsh-outline-smoke.mjs       Outline client smoke test
  dsh-diff-viewer-smoke.mjs   Diff viewer host routes and client contract test
  dsh-session-id-smoke.mjs    Session id header label client contract test
  dsh-logo-smoke.mjs          Logo asset routes and brand-slot contract test
```

## Plugin Structure

All plugins use ESM and normally have this shape:

```text
plugins/<plugin>/
  package.json                Package name, exports, and DSH bundle/client manifests
  cordis.patch.yml            Profile bundle layer when the package is installable
  preset/                     Packaged user preset assets when the plugin provides one
  scripts/                    Explicit package setup commands
  lib/index.js                Node/plugin entry point
  lib/client.js               Browser/client half when the plugin has UI
```

The `package.json` `dsh.client.inject` list declares the client runtime packages and must remain compatible with the target Web profile. `lib/index.js` owns host-side services/routes or exports the service class. A browser-only plugin may have a no-op Node entry.

### `dsh-magic-context`

This is the main system plugin and an installable DSH bundle. `cordis.patch.yml` mounts the host-side settings bridge and startup guidance; `scripts/install-preset.mjs` installs the packaged `context-compact` preset without changing the default. `lib/index.js` exports `ContextEngine`, which replaces `compaction-basic` in `context-compact`. The engine must remain inside an isolated agent-preset compaction group.

```text
lib/
  index.js                 ContextEngine export and plugin name
  engine.js                Main engine: compaction, triggers, memory injection, Dreamer
  db.js                    node:sqlite schema, migrations, FTS5, sqlite-vec, storage API
  memory.js                ctx_memory/ctx_search, scoring, injection, scope-aware retrieval
  retrieval.js             OpenAI-compatible and local embedding/rerank clients, RRF
  dreamer.js               Auxiliary Dreamer loop, read-only tools, action summaries, archival
  session-context.js       Bounded original-session projection and memory provenance ranges
  context-tool-guidance.js Main Agent system-prompt guidance for the four ctx tools
  paragraphs.js             Paragraph numbering and model-message injection
  tools.js                 ctx_reduce and ctx_expand implementations
  range.js                  Compaction range selection
  summarizer.js             Organizer LLM call, bounded repair, and fact extraction
  organizer-xml.js          Organizer XML/schema validation, local escaping repair, repair prompt
  aux-llm.js                Bounded retry/backoff for auxiliary (non-agent-loop) LLM calls
  landing.js                Stable checkpoint landing and surface replacement
  commands.js               /dream, /ctx-search, and /inject-memory commands
  notifications.js          Model-invisible activity rows and the model-facing notice
  scope.js                  Git-worktree/session scope resolution
  usage.js                  Context usage projection for the UI
  settings.js               File-backed settings schema, HTTP bridge, provider/model catalog
  notice.js                 Startup setup guidance for the bundle/preset boundary
  client.js                 Web settings UI, organizer/Dreamer model pickers, ContextMeter rows
```

Important context behavior:

- Database: `$DSH_HOME/magic-context/context.db`.
- Tables include `memories`, `memories_fts`, optional `memories_vec`, `paragraphs`, `skip_marks`, `compartments`, and `session_facts`.
- `sqlite-vec` and `@huggingface/transformers` are optional at runtime; FTS5 remains the fallback, and Transformers.js is only needed for local embedding/rerank models.
- Dreamer is an auxiliary `ctx.llm.stream()` loop, not a new agent/session. It reads bounded source context with `session_context`, performs dedicated memory/fact/compartment actions, and reports through one activity row per pass.
- Status reporting uses activity rows, never context notices: `notifications.js` appends a `command/run` + `command/done` pair that the client folds into one collapsible card (running until settled, red on `kind: "error"`). Both types are log-only and non-surface, so the model never sees them and nothing enters the agent inbox. The previous `agent.inject()` notices were model-visible by construction (only `user/message`, `assistant/message`, and `tool/result` are surface-eligible, and `deriveEventMessage` projects each unconditionally) and cost one extra whole-context LLM request per row, because `inject()` writes to `inbox.nextStep` and the loop only ends a turn while that queue is empty. A plugin-owned event type is not an option: `Session.append()` cannot set the envelope `ignorable` marker, and `dsh-session-persistence` refuses to interpret a log carrying an unknown unmarked type, which would make the session unloadable. `createContextNotice()` stays only for deliberately model-facing content such as `/inject-memory`.
- Dreamer idle triggering is per session and is deduplicated to one run per interaction round. Background notices must not create another run without a new `turn/start`.
- Organizer and Dreamer calls are auxiliary: the harness retry plugin never sees them, so they go through `aux-llm.js` for bounded backoff retry of `RATE_LIMIT`/`SERVER`/`TIMEOUT`/`TRANSPORT`/`EMPTY_RESPONSE`. A failed generation stores its reason in `compartments.error`, settles its activity row as an error, and arms a doubling per-session cooldown, because each attempt re-sends the whole range.
- Organizer and Dreamer targets are configured independently (`summarizationProvider`/`summarizationModel`/`summarizationReasoningEffort` and the `dreamer*` trio); provider and model must both be set to override the session route, while the effort applies either way. The settings panel populates its pickers from `GET /magic-context/models/catalog`, which reuses the host `llm` registry (`listProviders`/`listModels`/`resolveModelInfo`); that route only exists where the registry does, and the panel degrades to manual entry without it.
- Auxiliary output budgets are configurable and self-correcting: `summarizationMaxTokens` (32768) and `dreamerMaxTokens` (16384) are clamped to the target model's `defaultMaxTokens`, and `streamAux` grows the cap once on `MAX_TOKENS` instead of retrying an identical request. A reasoning model spends this budget on thinking first, so an under-sized cap truncates deterministically before any output.
- Image content never blocks a text-only organizer: `stripImageContent()` replaces image blocks with a text placeholder, proactively when `resolveModelInfo().inputModalities` excludes `image` (deepseek declares `["text"]`), and as a one-shot recovery when an undeclared route answers `UNSUPPORTED_CONTENT`.
- Provider failure text is normalized by `describeAuxFailure()` before it reaches `compartments.error` or any activity row. This mattered most while failures were injected as conversation content (a raw HTML error page rode every later request and fed the next attempt its own error page), and still bounds what a hostile provider string can write into the log.
- `compactNow` distinguishes a busy agent (the maintenance task never started) from a work failure (`summary`, with the normalized reason) and an abort (`cancelled`). Reporting every failure as `busy` previously hid deterministic summarization failures.
- Organizer XML stays fail-closed. When validation fails, one local schema-aware pass (`sanitizeOrganizerOutput`) may re-classify unescaped text as text and strip a markdown fence, but its result must pass the unchanged validator; otherwise the single bounded model repair call runs as before.
- New memory writes and fact promotions carry source session/compartment provenance when available. Old memories may have no recoverable source provenance.
- The main Agent receives `context-tool-guidance` for `ctx_reduce`, `ctx_expand`, `ctx_memory`, and `ctx_search`.

### `dsh-plugin-background`

- `lib/index.js`: host-side `ui-background` settings namespace, `/background/upload`, and wallpaper serving routes; persists under `$DSH_HOME/background/`.
- `lib/client.js`: browser settings row, wallpaper selection, opacity, theme variant, and upload UI.
- `package.json`: Web client injection and package exports.

### `dsh-plugin-font`

- `lib/index.js`: `/font/config` route, validated font settings, `fc-list` discovery, and persistence under `$DSH_HOME/font/config.json`.
- `lib/client.js`: browser settings row and font application.
- `package.json`: Web client injection and package exports.

### `dsh-plugin-hide-session-titles`

- `lib/index.js`: `/session-titles/config` route and persisted hidden-title toggle under `$DSH_HOME/session-titles/config.json`.
- `lib/client.js`: browser toggle button and UI behavior.
- `package.json`: Web client injection and package exports.

### `dsh-plugin-outline`

- `lib/index.js`: no-op Node entry; the browser half does the work.
- `lib/client.js`: right-side outline panel for jumping between user messages in long sessions.
- `package.json`: Web conversation/primitives client injection and package exports.

### `dsh-plugin-diff-viewer`

- `lib/index.js`: read-only git routes `/diff-viewer/changes`, `/diff-viewer/diff`, `/diff-viewer/tree`, and `/diff-viewer/file`. Every route resolves the caller's `cwd` to a git repository root and confines `path` to that root through `realpath`, so `..`, an absolute path, a symlink escape, and `.git` internals are all rejected. Nothing writes; `git` runs only read-only queries.
- `lib/client.js`: session-header trigger plus a fixed panel with a changes tab (files differing from HEAD) and a files tab (directory browse). Diff rows carry context lines and both gutters; the panel is display-only, with no editing or revert. The workspace comes from the sessions list store via the standard `useSessions` prop (`state.byId[sessionId]?.cwd`) — the per-session conversation snapshot has no `cwd`, and the service exposes no top-level `getSnapshot`/`items`.
- `package.json`: Web runtime/locale/conversation/primitives client injection and package exports.
- The file view renders through `primitives.ReadBlock`, the host's own read card, so it gets Shiki highlighting from the shared `css-variables` theme for free. Lines must be remapped `{no}` to `{number}`, and `maxLines` must be the served line count because the prop defaults to 16 and would otherwise collapse every file. `lang` comes from `langOf()` server-side and is only a hint: an unknown language degrades to plain text instead of throwing, and `diff`/`graphql`/`svelte`/`vue` have no shipped grammar.
- The panel paints `--dsw-alias-bg-layer-1`, never `--dsw-alias-bg-base`, which `dsh-plugin-background` forces to `transparent` while a wallpaper is on; it adds `backdrop-filter` for a frosted surface with an opaque `@supports` fallback. That filter is safe here only because the panel has no `position: fixed` descendants. The selected tab and the sticky hunk header needed the same token swap, the latter because a 6-8% tint let diff rows scroll visibly through it.
- Baseline is HEAD, not session start, so committing re-bases the view. See `docs/diff-viewer.md`.

### `dsh-plugin-session-id`

- `lib/index.js`: no-op Node entry; the browser half does all the work.
- `lib/client.js`: registers one entry in the `conversation.session.header.actions` list slot at `order: -9`, so the chip renders immediately after the agent-preset label (`order: -10`) and ahead of the interactive entries (`subagent-catalog` 10, `job-list` 20). Negative orders are the contract's reserved band for static session context, which is what an id is. The chip displays the id's distinguishing head (`session-` stripped, first 8 characters), carries the full id in `title`/`aria-label`/`data-dsh-session-id`, and copies the **full** id on click (async clipboard, hidden-textarea fallback).
- `package.json`: Web runtime/locale/conversation client injection and package exports.
- Purpose is diagnosis: the session id ties a UI symptom to durable evidence (session logs, `compartments` rows, Dreamer notices) and is otherwise only visible in the URL.

### `dsh-plugin-logo`

- `lib/index.js`: serves the bundled SVGs under the `/logo` prefix (`/logo/mark`, `/logo/wordmark`) as immutable `image/svg+xml`.
- `lib/client.js`: occupies the three declared brand slots - `sidebar.brand.mark` (wide row and collapsed rail, owner prop `size: 24`), `sidebar.brand.name` (the occupant owns its content and width), and `conversation.hero.brand.mark` (`size: 34` plus a `className` carrying the hero hover animation, so it must be forwarded).
- All three are `kind: "single"` and already occupied by `@deepseek-ai/dsh-client-ui-brand-official` at the default priority 0. A single slot **throws** on a second registration at the same priority and renders the **lowest** priority present, so this plugin registers at `priority: -1`. `entriesOfSlot` de-duplicates a single slot to its first sorted entry, and a component that throws is marked abdicated, which makes the shipped occupant a live fallback.
- Each slot is registered independently rather than as one nested `slots.inject` chain, so a shell that stops declaring one of them still brands the other two.
- `assets/mon3tr-logo.svg` is white-on-transparent, so the light theme applies `filter: invert(1)`; `assets/mon3tr-wordmark.svg` is full-colour and must never be inverted. The Harness pill is reproduced in CSS from `--dsw-alias-label-primary` on `--dsw-alias-label-primary-inverted` text; it cannot use `background: currentColor`, because in the same rule `currentColor` resolves against that rule's own `color`.
- This replaced a DOM-scanning implementation that matched the brand SVG by `viewBox` and hid it behind an inserted sibling. It half-broke on a DSH update that began rendering the name through `BrandWordmark({ includeMark: false })`, whose viewBox is `26 0 156 24` instead of `0 0 182 24`: the mark still matched, so only the lettering reverted to the stock artwork. Prefer a declared slot over host geometry.

### `dsh-header-rewrite`

- `lib/index.js`: wraps the global `fetch` once and applies configurable header rules (set/delete) matched by host, path, body model, and method. Rules come from the persisted `$DSH_HOME/header-rewrite/config.yaml` (validated, applied immediately) or the patch config as seed; the `/header-rewrite/config` route reads and writes that file. Use it to adapt to gateways with strict client policies (e.g. a User-Agent allowlist that rejects the harness attribution header).
- `lib/client.js`: a "Header rewrite" section in the Settings sidebar with a YAML editor that loads/saves the config through the host route.
- `package.json`: Web client injection and package exports.

## Profile Composition

`profile/cordis.patch.example.yml` is an example overlay for the Web profile. It loads the auxiliary Node/client plugins and sets `context-compact` as the default preset for newly created Web sessions; the dsh-magic-context bundle supplies its own host settings row.

`profile/agent-presets/context-compact/agent.cordis.yml` is the agent-plane composition. Important sections include:

- `compaction` group: mounts `dsh-magic-context` instead of `compaction-basic`, plus the compact command and result pruner.
- Other groups mount shell, filesystem, skills, goals, planning, delegation, and UI tools.
- Isolated group realms are intentional. Do not move services between realms without checking host/preset ownership and collision behavior.

`profile/cordis.patch.example.yml` also pins the **browse** directory picker. The shipped `directory-picker` row is adaptive and resolves `native` whenever the bind is loopback, a display is present, a chooser binary exists, and no SSH env is set — signals that cannot see a browser arriving through an SSH tunnel. In that setup the native dialog opens on an unwatched desktop, `host.pickDirectory` hangs on an orphan `zenity --file-selection`, and `host.listDirectory` refuses with `directory-picker-unavailable`. Pinning browse keeps selection in the browser. Note that `name` on an id-targeted patch row is an assertion, not a rename, so the adaptive row must be disabled and the browse pair inserted.

After changing profile composition or plugin manifests, a new DSH process is required. Do not restart the primary service directly.

## Syncing Runtime Plugins

Use the workspace plugin as the source and preserve runtime dependencies:

```bash
# Preview first.
rsync -ani --delete --exclude 'node_modules/' \
  plugins/dsh-magic-context/ \
  /home/mon3tr/.dsh/profiles/node_modules/dsh-magic-context/

# Apply after reviewing the preview.
rsync -a --delete --exclude 'node_modules/' \
  plugins/dsh-magic-context/ \
  /home/mon3tr/.dsh/profiles/node_modules/dsh-magic-context/
```

Use the same pattern with another plugin directory when needed. The target `node_modules/` is excluded and must remain intact. Confirm with a final dry-run or `diff`.

Do not directly restart the currently running DSH service. A bad plugin can disconnect the service and prevent recovery. Start an isolated instance on another port first:

```bash
dsh web --host 127.0.0.1 --port 3081
curl -fsS -o /tmp/dsh-alt-health.html \
  -w '%{http_code} %{content_type}\\n' \
  http://127.0.0.1:3081/
```

Stop the isolated instance after verification. Only consider the primary service after the alternate instance is healthy. Ordinary client-only changes may be checked with a browser refresh, but loaded package changes still require a new process.

## Tests

Run the focused test first, then the related context suite. Tests import installed plugin copies, so sync before running them.

```bash
node tests/dsh-context-db-smoke.mjs
node tests/dsh-context-dreamer-smoke.mjs
node tests/dsh-context-engine-smoke.mjs
node tests/dsh-context-memory-smoke.mjs
```

Other useful context tests:

- `dsh-context-bundle-smoke.mjs`: bundle manifest and host patch
- `dsh-context-retrieval-smoke.mjs`: embedding, rerank, RRF, and degradation behavior
- `dsh-context-local-models-smoke.mjs`: local embedding/rerank preset clients
- `dsh-context-settings-smoke.mjs`: settings schema, model routes, and config merge
- `dsh-context-command-smoke.mjs`: `/dream` and `/ctx-search`
- `dsh-context-paragraphs-smoke.mjs`: paragraph numbering and injection
- `dsh-context-tools-smoke.mjs`: `ctx_reduce` / `ctx_expand`
- `dsh-context-landing-smoke.mjs`: checkpoint landing and surface stability
- `dsh-context-scope-smoke.mjs`: Git-worktree scope isolation
- `dsh-context-notifications-smoke.mjs`: activity-row lifecycle, model-invisibility guard, and the model-facing notice contract
- `dsh-context-preset-smoke.mjs`: profile default and preset wiring
- `dsh-context-meter-rows-smoke.mjs`: ContextMeter row injection (suffix selectors, clone contract, cleanup)
- `dsh-context-aux-retry-smoke.mjs`: auxiliary-call retry classification, local organizer-XML repair, durable failure reason, generation cooldown, and organizer/Dreamer target resolution
- `dsh-context-model-picker-smoke.mjs`: settings-panel provider/model/effort pickers, catalog wire contract, and manual-entry degradation

For non-context plugins, run the matching `dsh-bg-smoke.mjs`, `dsh-font-smoke.mjs`, `dsh-session-titles-smoke.mjs`, `dsh-outline-smoke.mjs`, `dsh-diff-viewer-smoke.mjs`, `dsh-session-id-smoke.mjs`, or `dsh-logo-smoke.mjs` test. `dsh-diff-viewer-smoke.mjs` builds a throwaway git repository under `$TMPDIR`, so it needs a working `git` binary.

## Git and Editing Rules

- Inspect existing changes before editing and do not revert unrelated user work.
- Keep changes scoped to the plugin or profile layer being worked on.
- Use ASCII for new files unless non-ASCII is necessary.
- Use concise, unprefixed one-line commit messages; do not use Conventional Commit prefixes.
- Run `git diff --check` before committing.
- Do not commit runtime `node_modules` or generated DSH home data.

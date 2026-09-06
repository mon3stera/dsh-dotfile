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
  image-model.md              Image-generation adapter, prompt selection, storage limits
  session-outline.md          Outline plugin behavior notes
  diff-viewer.md              Diff viewer routes, confinement, and baseline choice
  computer-use.md             Desktop tools: coordinate systems, pointer client, deployment
  session-repair.md           Session repair plugin behavior and companion data rules
  session-seq-corruption-report.md  Upstream Discussion draft for the seq-collision corruption
  usage-dashboard.md          Usage dashboard: exact accounting, composition estimate, routes

plugins/
  dsh-magic-context/         Compaction, memories, retrieval, provenance, Dreamer
  dsh-plugin-background/      Wallpaper/background settings and upload routes
  dsh-plugin-font/            Font settings and font discovery
  dsh-plugin-hide-session-titles/  Session-title visibility toggle
  dsh-plugin-outline/         Browser-only session outline panel
  dsh-plugin-diff-viewer/     Read-only git diff and file browser panel
  dsh-plugin-session-id/      Session id label in the session header
  dsh-plugin-usage/           Token-usage dashboard: per-request accounting and composition
  dsh-plugin-mobile/          Phone-viewport ergonomics for the Web shell
  dsh-plugin-logo/            Custom Mon3tr brand mark and name
  dsh-plugin-image-model/     Image-generation endpoints as selectable models
  dsh-plugin-scheduler/       Scheduled tasks that spawn a session per run
  dsh-plugin-computer-use/    Computer-use tools for the niri/Wayland desktop
  dsh-header-rewrite/         Header rewrite for LLM provider requests
  dsh-plugin-session-repair/  Offline repair for backward-seq-corrupted session logs

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
  dsh-mobile-smoke.mjs        Mobile stylesheet, drawer scrim, and host anchor checks
  dsh-logo-smoke.mjs          Logo asset routes and brand-slot contract test
  dsh-image-model-smoke.mjs   Image adapter contract, prompt selection, admission limits
  dsh-scheduler-smoke.mjs     Scheduler math, routes, run-now, and panel contract test
  dsh-computer-use-smoke.mjs  Desktop tools: wire encoding, key mapping, tree render, live handshakes
  dsh-session-repair-smoke.mjs Session repair: core repair passes, real decoder cross-check, host routes
  dsh-usage-smoke.mjs         Usage dashboard: collector exactness, host routes, client contract
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
  commands.js               /dream, /ctx-search, /inject-memory, and /organize-memories commands
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
- Status reporting uses activity rows, never context notices: `notifications.js` appends a `command/run` + `command/done` pair that the client folds into one collapsible card (running until settled, red on `kind: "error"`). Both types are log-only and non-surface, so the model never sees them and nothing enters the agent inbox. The previous `agent.inject()` notices were model-visible by construction (only `user/message`, `assistant/message`, and `tool/result` are surface-eligible, and `deriveEventMessage` projects each unconditionally) and cost one extra whole-context LLM request per row, because `inject()` writes to `inbox.nextStep` and the loop only ends a turn while that queue is empty. A plugin-owned event type is not an option: `Session.append()` cannot set the envelope `ignorable` marker, and `dsh-session-persistence` refuses to interpret a log carrying an unknown unmarked type, which would make the session unloadable. `createContextNotice()` stays only for deliberately model-facing content such as `/inject-memory` and `/organize-memories`.
- Dreamer idle triggering is per session and is deduplicated to one run per interaction round. Background notices must not create another run without a new `turn/start`.
- The sessionFilter config gates both background subsystems per session: `organizer`/`dreamer` hard switches, `minSurfaceEvents` (short drive-by sessions skip), `includeCwdGlobs`/`excludeCwdGlobs` (matched against the raw cwd and the resolved memory scope root), `excludeSessionIdPrefixes` (the spawn-side naming contract — dsh-plugin-scheduler names its sessions `session-sched-*`), and `respectArchived` (archived sessions drop out via the host workspace registry). Overflow-forced compaction deliberately bypasses the gate: it is context management, not memory curation. The shipped preset enables `minSurfaceEvents: 4` and the scheduler prefix.
- Organizer and Dreamer calls are auxiliary: the harness retry plugin never sees them, so they go through `aux-llm.js` for bounded backoff retry of `RATE_LIMIT`/`SERVER`/`TIMEOUT`/`TRANSPORT`/`EMPTY_RESPONSE`. A failed generation stores its reason in `compartments.error`, settles its activity row as an error, and arms a doubling per-session cooldown, because each attempt re-sends the whole range.
- Organizer and Dreamer targets are configured independently (`summarizationProvider`/`summarizationModel`/`summarizationReasoningEffort` and the `dreamer*` trio); provider and model must both be set to override the session route, while the effort applies either way. The settings panel populates its pickers from `GET /magic-context/models/catalog`, which reuses the host `llm` registry (`listProviders`/`listModels`/`resolveModelInfo`); that route only exists where the registry does, and the panel degrades to manual entry without it.
- Auxiliary output budgets are configurable and self-correcting: `summarizationMaxTokens` (32768) and `dreamerMaxTokens` (16384) are clamped to the target model's `defaultMaxTokens`, and `streamAux` grows the cap once on `MAX_TOKENS` instead of retrying an identical request. A reasoning model spends this budget on thinking first, so an under-sized cap truncates deterministically before any output.
- Image content never blocks a text-only organizer: `stripImageContent()` replaces image blocks with a text placeholder, proactively when `resolveModelInfo().inputModalities` excludes `image` (deepseek declares `["text"]`), and as a one-shot recovery when an undeclared route answers `UNSUPPORTED_CONTENT`.
- Provider failure text is normalized by `describeAuxFailure()` before it reaches `compartments.error` or any activity row. This mattered most while failures were injected as conversation content (a raw HTML error page rode every later request and fed the next attempt its own error page), and still bounds what a hostile provider string can write into the log.
- `compactNow` distinguishes a busy agent (the maintenance task never started) from a work failure (`summary`, with the normalized reason) and an abort (`cancelled`). Reporting every failure as `busy` previously hid deterministic summarization failures.
- Organizer XML stays fail-closed. When validation fails, one local schema-aware pass (`sanitizeOrganizerOutput`) may re-classify unescaped text as text and strip a markdown fence, but its result must pass the unchanged validator; otherwise the single bounded model repair call runs as before.
- New memory writes and fact promotions carry source session/compartment provenance when available. Old memories may have no recoverable source provenance.
- The main Agent receives `context-tool-guidance` for `ctx_reduce`, `ctx_expand`, `ctx_memory`, and `ctx_search`. It must `ctx_search` before writing a memory: update a duplicate, delete a stale row, and write only when neither applies.
- Dreamer `promote_fact` always inserts a new memory; duplicate or one-off pending facts go through `discard_fact`. A successful `memory_update` stamps `verified_at`, and a settled pass stamps remaining live memories from that verification list.

### `dsh-plugin-background`

- `lib/index.js`: host-side `ui-background` settings namespace, `/background/upload`, and wallpaper serving routes; persists under `$DSH_HOME/background/`.
- `lib/client.js`: browser settings row, wallpaper selection, opacity, theme variant, and upload UI.
- `package.json`: Web client injection and package exports.

### `dsh-plugin-font`

- `lib/index.js`: `/font/config` route, validated font settings, `fc-list` discovery, and persistence under `$DSH_HOME/font/config.json`.
- `lib/client.js`: browser settings row and font application.
- Sizes drive the theme's own content-size axis (`--dsh-content-font-size` inline on body) in addition to the markdown overrides, so the user-message bubble (which sizes off that axis in the chat package) and the assistant content scale together. The theme presenter rewrites the axis on every theme apply, so a MutationObserver on the body style attribute re-asserts the explicit value; the follow state (no configured size) never touches the axis. The weight delta stays scoped to the markdown composites — the bubble inherits the body weight.
- `package.json`: Web client injection and package exports.

### `dsh-plugin-hide-session-titles`

- `lib/index.js`: `/session-titles/config` route and persisted hidden-title toggle under `$DSH_HOME/session-titles/config.json`.
- `lib/client.js`: browser toggle button and UI behavior.
- `package.json`: Web client injection and package exports.

### `dsh-plugin-outline`

- `lib/index.js`: no-op Node entry; the browser half does the work.
- `lib/client.js`: right-side outline panel for jumping between user messages in long sessions.
- `package.json`: Web locale/conversation client injection and package exports. The 0.1.2 primitives removal is why the trigger and close icons are inline SVGs: the removed package resolved to an empty module whose undefined components killed the header entry at render time.

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

### `dsh-plugin-usage`

- `lib/collect.js`: pure core. `assistant/message` events carry the exact per-request usage (`inputTokens` is uncached input, `totalTokens` = input + cacheRead + output); `request/header` carries the assembled system prompt and tool definitions; message events carry the conversation material. The composition estimate buckets message characters by `source.kind` with a CJK-aware heuristic (CJK ≈ 0.85 tokens/char, other ≈ 3.8 chars/token) and normalizes the shares to the last request's exact `totalTokens`. Tool-result rows are bucketed by row type, not envelope role: some envelopes carry `role: "user"`. Spliced inserts and their surface rows share a message id, so counting happens on the spliced row and the id set dedupes.
- `lib/index.js`: `GET /usage/overview?cwd=` (summary row per session) and `GET /usage/session?id=&cwd=` (full detail). Parsed logs are cached in memory keyed by path and invalidated by (mtimeMs, size); the cache entry must actually carry the stat pair (a version that stored `{header, collected}` alone missed on every request and re-scanned 4 s per call). zstd through the CLI, as in session-repair.
- `lib/client.js`: session-header trigger plus a fixed panel with three tabs — composition (exact totals + estimated category bar/table with the deviation note), requests (exact per-request rows with full/partial prefix-rewrite flags: a later request with `cacheReadTokens === 0` is a full rewrite; under 50% of the previous context above 20k is a suspected rewrite), and sessions (workspace overview, click to copy the id). Polls the detail route every 15 s while open. The panel paints `--dsw-alias-bg-layer-1`, never `--dsw-alias-bg-base`.
- `package.json`: Web runtime/locale/conversation/primitives client injection and package exports.
- `jsx(Component)` without a second argument crashes the jsx runtime with `Cannot read properties of undefined (reading 'key')` and the slot host marks the entry abdicated — always pass `{}`.
- See `docs/usage-dashboard.md`.

### `dsh-plugin-mobile`

- `lib/index.js`: no-op Node entry; the browser half does all the work.
- `lib/client.js`: one stylesheet in two media blocks — the phone block (`@media (max-width: 640px)`) and the details block (`@media (max-width: 995px)`) — plus one entry in the declared `shell.overlay` list slot rendering the drawer scrim, a viewport-meta fix, and a layout-service wrapper for details tracking. Nothing above the two bounds is touched.
- The host is already responsive: `dsh-client-ui-layout` watches the frame with a ResizeObserver and auto-collapses the sidebar to its 56px rail below `SIDEBAR_AUTO_COLLAPSE` (1024px). What it does not do is change *how* the columns share the width, because all three stay in grid flow at every size. The plugin's 640px breakpoint is a deliberate strict subset of that 1024px narrow mode, which is what lets the drawer rules treat a missing `data-sidebar-collapsed` as "the user opened the sidebar on a phone" rather than a width preference.
- The drawer is the substantive fix. With the sidebar open at 390px the host computes `grid-template-columns: 280px 110px 0` (`computeColumns` clamps an open sidebar to at least 264px), so the transcript reflows into 110px and wraps text one character per line; every open/close reflows the whole message list. The plugin collapses the track to `0 minmax(0,1fr) 0` and lets the sidebar paint over the conversation instead.
- That override must keep the sidebar column **in** grid flow. `position: absolute` on it looked correct and measured wrong: removing it from flow shifts the remaining items one track left, so the conversation lands in the 0px track and the details column takes the `1fr` — Chrome at 390px reported a 0px conversation. `position: relative` with `overflow: visible` and `z-index: 25` keeps placement, lets the 280px content paint outside its 0px track, and still creates the stacking context that puts the drawer above the scrim.
- The scrim occupies `shell.overlay` (declared `kind: "list"`, `scope: "root"`, rendered into `div[data-shell-overlay]` at `z-index: 20`, `pointer-events: none`). Its visibility is pure CSS keyed on the same `data-sidebar-collapsed` attribute, so no layout state is mirrored into the plugin and no MutationObserver is needed. It dismisses through the `layout` service (`toggleSidebar`), whose only surface is `toggleSidebar`/`openDetails`/`closeDetails` — occupants do **not** receive the declaring entry's store, because `storeOf` is per entry. `toggleSidebar` throws until the root entry attaches its actions, so the tap is guarded. `tabIndex: -1` keeps a viewport-sized element out of the tab order; the sidebar's own toggle stays the keyboard path.
- Also drops the column drag handles (`div[data-side]`, `cursor: col-resize` with `touch-action: none`, unusable without a pointer but still eating vertical swipes) and sets `overscroll-behavior: contain` on `[data-conversation-scroll]`.
- The details panel is promoted to a right-hand overlay below **995px**. `computeColumns` keeps an open details track inline only while `56 (rail) + 300 (details min) + 640 (centre min)` fits the viewport; below that bound it always returns `details: 0`, and the details column has `overflow: hidden`, so an open panel is clipped invisible with its close button off-screen (measured at x=411 on a 390px viewport). The overlay uses `position: absolute`, which is safe here and only here: the details column is the **last in-flow grid item** (the overlay outlet after it is itself `position: absolute`), so nothing reflows when it leaves grid flow — the exact opposite of the sidebar constraint above. Width is `min(360px, 100vw)`, the same 360px the host's `openDetails` stores as the preference.
- The details overlay is keyed on a `data-dsh-plugin-mobile-details="open"` attribute set on `<html>` by a wrapper around `ctx.layout.openDetails`/`closeDetails`. The frame's own `data-details-collapsed` attribute cannot drive it: the host writes `cols.details === 0 || void 0`, which is always true below the bound whether the user opened details or not. The wrapper is sound because the `layout` service is a shared singleton (`ctx.reflect.provide`) and every host caller goes through it — a probe patch on the plugin's reference caught the host's own rail toggle, and the conversation bundle calls `layout.openDetails()` on that same object. Caveat: after a reload with details already open in the store, the attribute is unset until the next open/close action, which re-syncs it; `openDetails` no-ops in the store but the wrapper still marks. A layout face without the two actions (older host) is skipped, not fatal.
- The settings dialog stacks single-column inside the phone block. The host panel is an 800px flex row — a 188px nav plus a `flex: 1` content pane — inside `max-width: calc(100vw - 48px)`, so at 390px the content gets 154px and CJK text wraps one character per line. The dialog is selected through the declared `sidebar.settings` slot outlet plus its `[role="dialog"]` panel; the attribute selector's specificity (0,2,0) beats every host rule (0,1,0), so no `!important` is needed. The nav becomes a horizontally scrollable chip strip (`nav > div+div` is the nav list; the title div is untouched), and the panel height switches `100vh` (the large-viewport height on Android Chrome, which overflows under the URL bar) to `100dvh` — on engines without `dvh` the declaration drops and the host value survives. Same-page A/B by disabling the plugin stylesheet: content pane 154px -> 342px.
- Wide transcript tables scroll within themselves: the scrollport clips at `overflow: hidden`, so a probe table measured 872px wide inside a 326px scrollport with the right-hand columns unreachable. `display: block; width: fit-content; max-width: 100%; overflow-x: auto` on `[data-conversation-scroll] table` keeps narrow tables natural and turns wide ones into their own scrollers; the selector deliberately does not reach the details panel, which lives outside the scrollport and already scrolls its own panes.
- The keyboard fix is JS, not CSS: the served viewport meta carries no `interactive-widget` key, and Android Chrome's default `resizes-visual` overlays the virtual keyboard on the layout viewport, hiding a bottom-anchored composer while typing. The plugin appends `interactive-widget=resizes-content` at boot (Chrome 108+), only when absent, so an explicit host choice wins. It is global rather than phone-scoped because it only takes effect while a virtual keyboard is open.
- Three rules that a bundle read seemed to justify were **measured away and must not be re-added without new measurement**: an iOS focus-zoom fix (the composer input is `font-size: inherit` and its whole ancestor chain already computes 16px; the 13px `--dsw-font-xs-13` in the same bundle belongs to a different editor), a horizontal-inset reclaim (`--dsh-composer-side-clearance` is not defined anywhere in this build, and the padded node is a hashed composer class with a hardcoded `padding: 0 24px`), and hover-gated message actions (every raw `:hover` rule in the conversation bundle is a colour change, and the only hover-gated reveal — message timestamps — is already wrapped in `@media (hover:hover)`, so touch users lose nothing). The smoke test asserts the first two are absent.
- The frame is selected as `div:has(> [data-shell-overlay])` — the element whose direct child is the declared overlay outlet, which is what the frame is by construction. Hashed CSS-module class names (`pI_x6G_frame`) change per build and are never selected.
- Verified by driving Chrome (Playwright, real touchscreen taps) against an isolated `dsh web --port 3081` instance at 390x844 with touch emulation, toggling `CSSStyleSheet.disabled` on the plugin's own style tag for a same-page before/after: conversation column 110px -> 390px with the sidebar open, drag handles 1 shown -> 0, overscroll `auto` -> `contain`, scrim `pointer-events` `none` -> `auto`, and a scripted scrim tap restoring `[56, 334, 0]`. The new fixes were measured the same way: settings content pane 154px -> 342px with the nav strip switching column -> row; a 872px probe table gaining `display: block`/`overflow-x: auto` with `scrollWidth > clientWidth` (and reverting to `display: table` with the plugin disabled, proving causality); the viewport meta gaining `interactive-widget=resizes-content`; and the details column measuring x=30/width=360/right=390 with a tap-reachable close button once the wrapper attribute is present on `<html>`. The shared-singleton service was proven by a temporary probe wrapper that caught the host's own rail toggle through the plugin's reference.

### `dsh-plugin-logo`

- `lib/index.js`: serves the bundled SVGs under the `/logo` prefix (`/logo/mark`, `/logo/wordmark`) as immutable `image/svg+xml`.
- `lib/client.js`: occupies the three declared brand slots - `sidebar.brand.mark` (wide row and collapsed rail, owner prop `size: 24`), `sidebar.brand.name` (the occupant owns its content and width), and `conversation.hero.brand.mark` (`size: 34` plus a `className` carrying the hero hover animation, so it must be forwarded).
- All three are `kind: "single"` and already occupied by `@deepseek-ai/dsh-client-ui-brand-official` at the default priority 0. A single slot **throws** on a second registration at the same priority and renders the **lowest** priority present, so this plugin registers at `priority: -1`. `entriesOfSlot` de-duplicates a single slot to its first sorted entry, and a component that throws is marked abdicated, which makes the shipped occupant a live fallback.
- Each slot is registered independently rather than as one nested `slots.inject` chain, so a shell that stops declaring one of them still brands the other two.
- `assets/mon3tr-logo.svg` is white-on-transparent, so the light theme applies `filter: invert(1)`; `assets/mon3tr-wordmark.svg` is full-colour and must never be inverted. The Harness pill is reproduced in CSS from `--dsw-alias-label-primary` on `--dsw-alias-label-primary-inverted` text; it cannot use `background: currentColor`, because in the same rule `currentColor` resolves against that rule's own `color`.
- This replaced a DOM-scanning implementation that matched the brand SVG by `viewBox` and hid it behind an inserted sibling. It half-broke on a DSH update that began rendering the name through `BrandWordmark({ includeMark: false })`, whose viewBox is `26 0 156 24` instead of `0 0 182 24`: the mark still matched, so only the lettering reverted to the stock artwork. Prefer a declared slot over host geometry.

### `dsh-plugin-image-model`

- `lib/index.js`: validates the configured provider routes and registers one `LlmAdapter` for them through `ctx.llm.registerAdapter()`. A route with no id, `baseURL`, or usable model is dropped rather than registered, since it would appear in the selector and fail on first use. The registration is created on first use rather than at boot, because `registerAdapter` rejects an empty initial route set while a fresh install has no providers until the panel adds one; afterwards `handle.replace()` swaps the whole set atomically.
- `lib/config.js`: route normalization shared by the loader patch and the settings file, plus the seed/file merge.
- `lib/settings.js`: file-backed settings under `$DSH_HOME/image-model/config.json` and the `/image-model/config` + `/image-model/credential` routes. Writes are atomic (temporary file plus rename), and a corrupt file reads as empty because refusing to load would take the only repair surface down with it.
- `lib/client.js`: the **Image models** settings section — providers, per-provider models, generation options, the refinement toggle, and the credential field. A save re-registers the routes in the running process, so no restart is needed.
- `lib/adapter.js`: the adapter. `listModels`/`resolveModel` advertise the declared models; `stream()` performs one images request, commits the bytes through `attachments.saveImage()`, and yields a single `image` block plus a `stop` finish.
- `lib/images-api.js`: the two endpoint encodings (`/images/generations` as JSON, `/images/edits` as multipart), media-type sniffing, and failure classification onto harness codes.
- `lib/request.js`: prompt selection, source-image selection, and per-model option shaping.
- The panel is its own `settings.section` entry, not a host provider row. `registerConfigurableProviders()` would list an image provider on the host's Models page, but that page picks its form by settings namespace (`layoutOf`: `llm-deepseek`, `llm-pi-ai`, else `unknown`) and `layout === "unknown"` is part of `submitDisabled`, so the row would be visible and permanently uneditable. Writing into `llm-pi-ai` instead would hand the routes to pi-ai, which speaks a chat protocol to an images endpoint. The smoke test pins `layoutOf` and the slot's `kind`, so a host change that makes reuse viable fails the test rather than going unnoticed.
- `apiKeyRef` is a credential *reference* (a POSIX identifier such as `OPENAI_API_KEY`) resolved through the host `credentials` service per call. That service already layers the process environment with its own storage, so the panel can save a key and an environment variable of the same name still works. Values never enter the plugin's config file, its route responses, or the log. `apiKeyEnv` is accepted as the older name.
- An image endpoint is not reachable through `settings.yaml`: a configured provider's `api` field selects a pi-ai *chat* protocol, and model metadata has `inputModalities` but no output-modality field. The adapter seam is public and `image` is already a declared content-block type the client renders, so no host change is needed. Generate-only is a consequence of emitting no tool call, not an added restriction — the loop ends the turn when a step produces none.
- The prompt is the newest message whose `source.kind` is `user`, **not** the newest user-role message. The harness delivers workspace instructions, the skill catalog, and the runtime-context snapshot as user-role messages; selecting by role sent the repository guide and the sandbox policy to the endpoint as the subject of the picture. `<system-reminder>` framing is stripped as a second line of defence.
- Auxiliary purposes are refused with a non-retryable `INVALID_REQUEST` before the credential check. `dsh-session-title-llm` requests a title on every new session through the session's own route, so without this an image route silently generated a billed image per session; its callers already tolerate a failed call.
- The local attachment store enforces 2000 px per side, 3.5 MiB encoded, and 40 M decoded pixels by default. These are reachable for real generations, so an admission refusal is rewritten to name the limit, the actual value, and the fix (smaller `size`, or `outputFormat: jpeg`). Media type comes from the bytes' signature, because `saveImage()` verifies the declared type against the decoded raster.
- See `docs/image-model.md`.

### `dsh-header-rewrite`

- `lib/index.js`: wraps the global `fetch` once and applies configurable header rules (set/delete) matched by host, path, body model, and method. Rules come from the persisted `$DSH_HOME/header-rewrite/config.yaml` (validated, applied immediately) or the patch config as seed; the `/header-rewrite/config` route reads and writes that file. Use it to adapt to gateways with strict client policies (e.g. a User-Agent allowlist that rejects the harness attribution header).
- `lib/client.js`: a "Header rewrite" section in the Settings sidebar with a YAML editor that loads/saves the config through the host route.
- `package.json`: Web client injection and package exports.

### `dsh-plugin-session-repair`

- `lib/repair.js`: pure core. Rows are parsed from the decompressed JSONL; the exact contiguity scan mirrors the persistence reader's invariant, with packed chunk rows (`text-chunks` / `reasoning-chunks` / `tool-call-chunks` carrying `seq0`) expanded to `data.texts.length` / `data.args.length` events. The fixed repair pattern locates the first backward seq transition, deletes the synthetic `interrupted-tool-result` batch when present (renumbering the remaining committed rows down by three) and lets the rescanned gap shift the late tail up by one uniform delta; `seq`, `seq0`, and `sourceEventSeqs` all shift. Also ports `projectKey` / `encodeSegment` from the persistence backend for path resolution.
- `lib/index.js`: `GET /session-repair/scan`, `POST /session-repair/repair` (`dryRun` supported; atomic write with a `.bak-<ts>` backup and post-write re-verification), and `POST /session-repair/restore` (newest backup back). zstd through the CLI because DSH writes many concatenated frames per log, which the one-shot zlib zstd functions do not decode.
- `lib/client.js`: a "会话修复 / Session repair" settings section — workspace path (localStorage; empty scans every project directory), scan, per-session dry run / repair / restore.
- The plugin is generic and does not touch `dsh-magic-context`'s database; after a real repair its seq references must be shifted by the same rule (see `docs/session-repair.md`).
- See `docs/session-repair.md` and `docs/session-seq-corruption-report.md` (upstream Discussion draft).

### `dsh-plugin-scheduler`

- `lib/index.js`: durable scheduled tasks in `$DSH_HOME/scheduler/tasks.json`. Each task has a name, a prompt, an optional cwd / agent preset, and either a fixed interval (minutes ≥ 5) or a daily server-local `HH:MM`. The self-rearming timer fires due tasks through the host `sessionController` service: `create({cwd, agentPreset})` spawns a fresh session, then `prompt({sessionId, requestId, content})` submits the prompt, so every run is an ordinary session in the sidebar list. Routes: `GET/POST /scheduler/tasks` (validated full-document save, atomic write, re-arms the timer) and `POST /scheduler/run` (run one task now). An overdue interval task runs one catch-up when found overdue at boot or after a save; daily tasks wait for their next occurrence. Failures land on the task's `lastError` and surface in the panel.
- `lib/client.js`: a "定时任务 / Scheduled tasks" entry occupying the `sidebar.footer.action` list slot — the seat renders directly above the Settings entry — toggling a fixed side panel (create/edit/delete, enable toggle, run-now, last run + session id + error). No icon package: the entry draws its own inline clock SVG.
- `package.json`: Web client injection (locale, slots, sidebar) and package exports.
- The scheduler deliberately does not use `dsh-schedule`: that host package delivers reminders into an existing conversation, while this plugin's contract is one fresh session per run.
- Per-task model: tasks may carry `provider`/`model`; when both are set the runner resolves the route through the host `llm.resolveCallConfig` and commits it with `controller.agents.selectForNextRequest(agent, selection)` before prompting. `sessionController.selectModel()` is deliberately avoided — beyond the session-local selection it also saves the deployment-global default model (`agentDefaultModel.saveSelection`), which a task must never hijack. A failed selection records `lastError` and skips the prompt instead of running on the wrong model.

### `dsh-plugin-computer-use`

- Five agent tools over the niri/Wayland desktop the DSH process runs in: `desktop_windows` (niri IPC list/focus/close/fullscreen), `desktop_tree` (AT-SPI2 accessibility tree with desktop-global pixel extents, via the spawned `lib/atspi-tree.py` helper over `gi.repository.Atspi` — the `python-atspi` package is not needed), `desktop_screenshot` (grim; window capture tries `niri msg action screenshot-window` and falls back to focus + full-screen grim), `desktop_mouse` (absolute move/click/drag over a dependency-free raw Wayland `zwlr_virtual_pointer_v1` client in `lib/wayland-pointer.js`; wheel via ydotool), and `desktop_key` (wtype text/keysyms with a ydotool keycode fallback).
- `lib/wayland-pointer.js` exists because ydotool 1.0.4's daemon creates a relative-only uinput device (`capabilities/abs: 0`), so `mousemove -a` cannot target pixels; niri implements `wlr-virtual-pointer-unstable-v1` natively and the needed subset (registry walk, bind, create, `motion_absolute`, `button`, `frame`, destroy) fits a small wire-protocol client. Wheel axis is deliberately absent — REL_WHEEL detents through ydotool are unambiguous.
- `niri msg action screenshot-window` has been observed to return success while producing no file and no clipboard image on this build; the screenshot tool polls `screenshotDir` for a new image and falls back to focus + grim, stating the fallback in its result.
- All coordinates are desktop-global logical pixels: the tree reports them directly, and the screenshot result states the scale mapping (grim downscales to fit the 2000 px attachment limit). Multi-monitor bounding boxes with negative origins are normalized via `niri msg --json outputs`.
- A pure tool registrar (inject: `tools`, `systemPrompt`) mounted as a plain preset row with no isolate realm. The preset is deployed as a copy under `~/.dsh/.agent-presets/context-compact/` — unlike plugins, which live under `profiles/node_modules/`. The tools execute real desktop input with no permission surface; mount only in trusted presets. See `docs/computer-use.md`.

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
- `dsh-context-command-smoke.mjs`: `/dream`, `/ctx-search`, `/inject-memory`, and `/organize-memories`
- `dsh-context-paragraphs-smoke.mjs`: paragraph numbering and injection
- `dsh-context-tools-smoke.mjs`: `ctx_reduce` / `ctx_expand`
- `dsh-context-landing-smoke.mjs`: checkpoint landing and surface stability
- `dsh-context-scope-smoke.mjs`: Git-worktree scope isolation
- `dsh-context-notifications-smoke.mjs`: activity-row lifecycle, model-invisibility guard, and the model-facing notice contract
- `dsh-context-preset-smoke.mjs`: profile default and preset wiring
- `dsh-context-meter-rows-smoke.mjs`: ContextMeter row injection (suffix selectors, clone contract, cleanup)
- `dsh-context-aux-retry-smoke.mjs`: auxiliary-call retry classification, local organizer-XML repair, durable failure reason, generation cooldown, and organizer/Dreamer target resolution
- `dsh-context-model-picker-smoke.mjs`: settings-panel provider/model/effort pickers, catalog wire contract, and manual-entry degradation

For non-context plugins, run the matching `dsh-bg-smoke.mjs`, `dsh-font-smoke.mjs`, `dsh-session-titles-smoke.mjs`, `dsh-outline-smoke.mjs`, `dsh-diff-viewer-smoke.mjs`, `dsh-session-id-smoke.mjs`, `dsh-usage-smoke.mjs`, `dsh-mobile-smoke.mjs`, `dsh-logo-smoke.mjs`, `dsh-image-model-smoke.mjs`, `dsh-scheduler-smoke.mjs`, or `dsh-computer-use-smoke.mjs` test. `dsh-diff-viewer-smoke.mjs` builds a throwaway git repository under `$TMPDIR`, so it needs a working `git` binary. `dsh-mobile-smoke.mjs` reads the installed host bundles directly to re-check every attribute, slot, and inline style its rules depend on, so it fails loudly when a DSH update moves one. `dsh-computer-use-smoke.mjs` includes two live checks that skip cleanly when their socket is absent: a raw Wayland handshake against the real compositor and an AT-SPI dump against the session bus.

## Git and Editing Rules

- Inspect existing changes before editing and do not revert unrelated user work.
- Keep changes scoped to the plugin or profile layer being worked on.
- Use ASCII for new files unless non-ASCII is necessary.
- Use concise, unprefixed one-line commit messages; do not use Conventional Commit prefixes.
- Run `git diff --check` before committing.
- Do not commit runtime `node_modules` or generated DSH home data.

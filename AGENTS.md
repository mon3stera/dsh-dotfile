# Repository Agent Guide

## Purpose

This repository contains DSH profile overlays and local plugins. The workspace source is the source of truth. Runtime copies under `$DSH_HOME/profiles/node_modules/` are deployment artifacts, not editing targets.

The repository currently has no root `package.json` or unified test runner. Most smoke tests are standalone Node ESM files and intentionally import the installed runtime plugin copy.

## Bootstrap Order

1. Read this file and `docs/context-management.md`.
2. Inspect `git status --short --branch` before changing anything.
3. For context work, read `plugins/dsh-plugin-context/lib/engine.js`, `db.js`, `dreamer.js`, `memory.js`, and the relevant smoke test.
4. Check the active profile composition in `profile/agent-presets/my-compact/agent.cordis.yml` and `profile/cordis.patch.example.yml`.
5. Treat files under `plugins/` as canonical. Do not edit the installed copy directly.
6. After plugin changes, mirror the changed plugin to the runtime directory with the documented `rsync` procedure, then run tests against the mirrored copy.

## Repository Layout

```text
docs/
  context-management.md       Context Compact, memory, retrieval, and Dreamer design
  session-outline.md          Outline plugin behavior notes

plugins/
  dsh-plugin-context/         Compaction, memories, retrieval, provenance, Dreamer
  dsh-plugin-background/      Wallpaper/background settings and upload routes
  dsh-plugin-font/            Font settings and font discovery
  dsh-plugin-hide-session-titles/  Session-title visibility toggle
  dsh-plugin-outline/         Browser-only session outline panel

profile/
  cordis.patch.example.yml    Example Web profile loader patch
  agent-presets/my-compact/   Context Compact agent composition and bootstrap preset

tests/
  dsh-context-*.mjs           Context plugin component and integration smoke tests
  dsh-bg-smoke.mjs            Background plugin smoke test
  dsh-font-smoke.mjs          Font plugin smoke test
  dsh-session-titles-smoke.mjs  Session title plugin smoke test
  dsh-outline-smoke.mjs       Outline client smoke test
```

## Plugin Structure

All plugins use ESM and normally have this shape:

```text
plugins/<plugin>/
  package.json                Package name, exports, and DSH client injection
  lib/index.js                Node/plugin entry point
  lib/client.js               Browser/client half when the plugin has UI
```

The `package.json` `dsh.client.inject` list declares the client runtime packages and must remain compatible with the target Web profile. `lib/index.js` owns host-side services/routes or exports the service class. A browser-only plugin may have a no-op Node entry.

### `dsh-plugin-context`

This is the main system plugin. `lib/index.js` exports `ContextEngine`, which replaces `compaction-basic` in `my-compact`.

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
  summarizer.js             Organizer LLM call and fact extraction
  landing.js                Stable checkpoint landing and surface replacement
  commands.js               /dream and /ctx-search commands
  notifications.js          Durable ContextInjectionRow notices
  scope.js                  Git-worktree/session scope resolution
  usage.js                  Context usage projection for the UI
  settings.js               File-backed settings schema and HTTP bridge
  client.js                 Web settings UI and model download controls
```

Important context behavior:

- Database: `$DSH_HOME/context/context.db`.
- Tables include `memories`, `memories_fts`, optional `memories_vec`, `paragraphs`, `skip_marks`, `compartments`, and `session_facts`.
- `sqlite-vec` is optional at runtime; FTS5 remains the fallback.
- Dreamer is an auxiliary `ctx.llm.stream()` loop, not a new agent/session. It reads bounded source context with `session_context`, performs dedicated memory/fact/compartment actions, and emits started/completed/failed UI notices.
- Dreamer idle triggering is per session and is deduplicated to one run per interaction round. Background notices must not create another run without a new `turn/start`.
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

## Profile Composition

`profile/cordis.patch.example.yml` is an example overlay for the Web profile. It loads the Node/client plugins and sets `my-compact` as the default preset for newly created Web sessions.

`profile/agent-presets/my-compact/agent.cordis.yml` is the agent-plane composition. Important sections include:

- `tool-bootstrap.mjs`: first-request tool and context-injection gate; keep it first.
- `compaction` group: mounts `dsh-plugin-context` instead of `compaction-basic`, plus the compact command and result pruner.
- Other groups mount shell, filesystem, skills, goals, planning, delegation, and UI tools.
- Isolated group realms are intentional. Do not move services between realms without checking host/preset ownership and collision behavior.

After changing profile composition or plugin manifests, a new DSH process is required. Do not restart the primary service directly.

## Syncing Runtime Plugins

Use the workspace plugin as the source and preserve runtime dependencies:

```bash
# Preview first.
rsync -ani --delete --exclude 'node_modules/' \
  plugins/dsh-plugin-context/ \
  /home/mon3tr/.dsh/profiles/node_modules/dsh-plugin-context/

# Apply after reviewing the preview.
rsync -a --delete --exclude 'node_modules/' \
  plugins/dsh-plugin-context/ \
  /home/mon3tr/.dsh/profiles/node_modules/dsh-plugin-context/
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

- `dsh-context-retrieval-smoke.mjs`: embedding, rerank, RRF, and degradation behavior
- `dsh-context-local-models-smoke.mjs`: local embedding/rerank preset clients
- `dsh-context-settings-smoke.mjs`: settings schema, model routes, and config merge
- `dsh-context-command-smoke.mjs`: `/dream` and `/ctx-search`
- `dsh-context-paragraphs-smoke.mjs`: paragraph numbering and injection
- `dsh-context-tools-smoke.mjs`: `ctx_reduce` / `ctx_expand`
- `dsh-context-landing-smoke.mjs`: checkpoint landing and surface stability
- `dsh-context-scope-smoke.mjs`: Git-worktree scope isolation
- `dsh-context-notifications-smoke.mjs`: UI notice contract
- `dsh-context-preset-smoke.mjs`: profile default and preset wiring

For non-context plugins, run the matching `dsh-bg-smoke.mjs`, `dsh-font-smoke.mjs`, `dsh-session-titles-smoke.mjs`, or `dsh-outline-smoke.mjs` test.

## Git and Editing Rules

- Inspect existing changes before editing and do not revert unrelated user work.
- Keep changes scoped to the plugin or profile layer being worked on.
- Use ASCII for new files unless non-ASCII is necessary.
- Use concise, unprefixed one-line commit messages; do not use Conventional Commit prefixes.
- Run `git diff --check` before committing.
- Do not commit runtime `node_modules` or generated DSH home data.

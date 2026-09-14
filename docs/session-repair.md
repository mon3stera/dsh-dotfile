# Session repair plugin

`dsh-plugin-session-repair` repairs session logs whose event sequence
numbering collided — the log fails to load with:

```
corrupt session log: seq gap in committed region at line N (expected E, got G)
```

## The corruption

DSH persists sessions as append-only multi-frame zstd JSONL logs where every
event carries a dense `seq`. The observed failure (six real logs across three
workspaces, 2026-08-17 .. 2026-09-06, always after a turn was interrupted
while a tool call was pending):

1. the tool call is interrupted; the interrupt path persists a synthetic
   `interrupted-tool-result` batch (`tool/result` with an
   `interrupted-tool-result-…` message id + `step/end` + interrupted
   `turn/end`), advancing the persisted counter;
2. the original in-flight session object later commits the real tool result
   (or a queued prompt splice) with its **pre-interrupt** event counter,
   writing a backward seq transition;
3. every later event follows the stale counter, so the whole tail is numbered
   several below the committed prefix.

Two shapes were observed: the late **real tool result** for the interrupted
call (four logs), and a late **`agent/inbox/spliced`** append for a prompt
queued during the interruption (two logs). The direct defect is a
session-lifecycle/persistence race, not concurrent reads: restarting the
service only exposed it.

## The fixed repair pattern

1. locate the first backward seq transition (expected `E`, got `G`);
2. if the committed rows in `[G, E)` contain the synthetic interrupt batch,
   delete those three rows and renumber the remaining committed rows down by
   three (avoids two tool results for one tool call, which providers reject);
3. rescanning then isolates the late tail, which shifts up by one uniform
   delta (`shift-tail` pass); without a batch this is the first and only pass;
4. repeat while the exact contiguity scan still fails.

Streaming-chunk runs are stored as packed `text-chunks` / `reasoning-chunks` /
`tool-call-chunks` rows carrying `seq0` (expanding to `data.texts.length` /
`data.args.length` events); repairs shift `seq`, `seq0`, and every stored
reference into the event numbering: the `sourceEventSeqs` provenance list and
the replacement range of a landed `surfaceOp` marker. A marker whose range stops
tracking the surface makes restore fail with "surface replace: end seq ... not
found in surface" even though the contiguity scan passes. History loss is
limited to the three synthetic events; the real tool result (with its actual
content) survives.

**Marker shape is versioned.** A v0 log carries `{op:"replace",start,end}`; a v3
log (DSH 0.1.5's migrated format) carries `{op:"replace",startSeq,endSeq}`, which
is the only shape 0.1.5's `isReplaceOp` accepts. `shiftRow` shifts both, keyed on
which of the four keys is present, because a v3 marker left in place after a
renumber fails the same way a v0 one does. v3 logs also have no chunk rows at
all (the v2→v3 edge folds them away), so the chunk-row rules are v0-only by
construction and simply find nothing to do on a v3 log. The two companion
consequences live outside this plugin: `dsh-magic-context`'s
`replaceSurfaceOp()` probes which key names the installed reader accepts before
writing a marker, and its `lib/coordinates.js` rebuilds a session's seq-keyed
rows after a format migration, because that migration renumbers every event
(see `docs/context-management.md` §3.3.1).

## Routes

- `GET /session-repair/scan?cwd=<abs path>` — scan one workspace (omit `cwd`
  to scan every project directory). Reports corrupted logs with their gap,
  whether the synthetic batch marker is present, and existing backups.
- `POST /session-repair/repair` — body `{sessionId, dryRun?}`. Repairs the
  log atomically; the original is kept as `session.jsonl.zstd.bak-<ts>`. The
  written file is re-scanned before success is reported.
- `POST /session-repair/restore` — body `{sessionId}`. Restores the newest
  backup (the current file is kept as `.pre-restore-<ts>`).

The zstd codec is the `zstd` CLI: DSH writes many concatenated frames per
log, which the one-shot zlib zstd functions do not decode.

## Second corruption class: broken container framing (2026-09-06)

A session log compressed as **one whole-file zstd frame** keeps its seq
numbering perfectly healthy but bricks every profile at boot: the workspace
init fail-closes on `assertZstdHeaderFrame` ("first frame is not exactly one
header line") while listing artifacts, so one bad file stops DSH from
starting at all. See `docs/session-framing-incident-2026-09-06.md`. The scan
and repair now cover both classes:

- `scanSessionFile` decodes only the first frame (located by zstd magic) and
  asserts it is exactly the header line + newline; the result is reported as
  `containerBroken: true`, and such a log counts as corrupted even with a
  clean seq scan.
- `repairLogFile` (shared by the route and the CLI) re-containerizes whenever
  the framing is broken: `compressLog` always emits the two-frame layout, so a
  container-only incident is fixed with byte-identical event content
  (`recontainerizeOnly: true`, empty passes), while a combined seq + container
  incident is fixed in the same write. Post-write verification now checks the
  seq scan **and** the container contract.

## Third corruption class: stale provenance (2026-09-07)

The 2026-09-06 repair batch left a follow-up defect in the logs it fixed. A
renumbered row's provenance list (`sourceEventSeqs`, stored as bare seqs plus
inclusive `[start, end]` pairs) was shifted with a flat `Array.map` that
compared each element to the renumber threshold — always false for a nested
pair, so range-encoded refs silently kept their pre-shift positions while
every `seq` around them moved. Only long streamed answers used pair encoding,
so three `assistant/message` rows in the affected tail cited `user/message` +
`turn/start` + `step/start` instead of their own chunks.

The token meter re-assembles provider output through those refs and throws
`token meter: assistant/message at seq N source seq M is not assistant/chunk`
on every measurement. That kills all three compaction paths at once — the 65%
generation trigger, the 80% landing trigger, and manual `/compact` (which the
host command renders as the generic "could not produce a useful summary") —
while the context meter keeps climbing. The session stays otherwise healthy.

The repair now covers the class:

- `shiftRow` shifts range-encoded pairs element-wise (no future repair can
  reintroduce the bug).
- `scanProvenance` decodes every `assistant/message`'s stored provenance and
  resolves each cited seq through the row spans: a cited seq must be strictly
  earlier than the message and land on an `assistant/chunk` slot (explicit
  chunk rows and all three packed chunk-row tags — the reader expands every
  packed member to an `assistant/chunk` event). Issues make the scan report
  `staleProvenance` and count the log as corrupted.
- `repairStaleProvenance` realigns each stale list onto the contiguous chunk
  run ending immediately before its message (`delta = run end - stale end`)
  and accepts the shift only when **every** realigned seq lands on a chunk
  slot; a wrong alignment fails loudly instead of writing a wrong row.
- Post-write verification also re-runs the provenance scan.

## Fourth class: released-v0 schema violations (2026-09-14, 0.1.5 migration gate)

This one is not corruption at all: the 0.1.2 line loads such logs happily. It is
an **upgrade** blocker, found by dry-running the 0.1.5 session-format catalog over
a copy of the whole store (380 logs): **309 refused to migrate**, i.e. those
sessions stay listed and readable but cannot be resumed on the newer line. The
catalog audits a stored v0 log against its frozen member inventory *before*
migrating, so a single unexpected member refuses the whole session:

| shape | what wrote it | why it refuses | fix |
| --- | --- | --- | --- |
| `command/run.data.source = {kind:"plugin",plugin:...}` | `dsh-magic-context` activity rows (this plugin's own sibling) | the released inventory types `source` as **exactly** `{kind:"user"}` | rewrite to `{kind:"user"}` |
| `command/done.data.source` | same family | the type declares no `source` member | drop it |
| `model/selection.data.maxTokens` | the 0.1.2 host: `selectForNextRequest` appends its argument verbatim, and `resolveCallConfig()` returns `maxTokens` | the inventory declares provider/model/reasoningEffort only | drop the extras |
| `subagent/descriptor.data.version = 2` | the 0.1.2 host subagent writer | the inventory requires the literal `3` | bump to 3, only when the rest of the row already matches the v3 member set |
| `session/title.messageSeqs` (and the `session/title-llm-request` twin) | the 0.1.2 title writer: it stored the prompt text correctly but an off-by-N seq that lands on a `turn/start` | the frozen codec resolves every citation against an **earlier human** `user/message` (`assertTitleSources`), and demands an empty list exactly for a user-set title | realign onto the message the row's own record cites |

Counts on the real store: 202 sessions carried the `command/run` shape (1928
rows), 93 the `model/selection` shape, 76 the descriptor shape (the 67 that
reported it first, plus rows hidden behind an earlier class), and 1 session a
title citation; 148 of the refusals named the `command/run` row first because a
log reports only its first violation.

After normalization the rehearsal store migrates **378 of 380** sessions (was
71). The two holdouts are not schema violations and are deliberately left alone:

- A **5-event abandoned fork** (`session-01f47341…`, cwd `/home/mon3tr`) whose
  header declares `seedLength: 481`: its `inheritedEventCount` genuinely exceeds
  its event count, so the only "fix" would be to lie about the seed. Archive or
  delete it.
- A **landing range that names consumed chunk slots**
  (`session-dc85e119…`): `compaction/summary.shadowedRange.end` and 64 of its 300
  `shadowedSeqs` are `assistant/chunk` positions that the v1→v2 assistant-stream
  edge consumes, so the migration refuses rather than trimming the recorded
  shadow span. Rewriting that span would change what the log says was compacted;
  the session stays readable on 0.1.2 and listed on 0.1.5, it just cannot be
  resumed there.

`lib/normalize.js` implements the audit and the rewrite. Four properties matter:

- **Nothing is renumbered.** No event seq moves, so the seq-keyed references
  `dsh-magic-context` stores for a session (paragraph numbers, compartment spans,
  memory provenance) stay valid — unlike the backward-seq repair, which shifts the
  tail and therefore does need the companion-data rule below.
- **Structurally healthy logs are not called corrupt.** `scan` reports
  `legacyShapes` / `legacyShapeSample` / `legacyUnfixable` / `migrationReady`, and
  `scan-all` adds `legacyShapedCount` + `needsNormalization`; `corrupted` keeps
  meaning seq gap, container framing, or stale provenance.
- **Unfixable rows refuse the write.** A descriptor that cannot reach v3 by a
  version bump alone (unknown mode, foreign member, unpaired agent route) makes
  `repair` answer 422 and leave the file untouched instead of guessing.
- **`repair` fixes it in the same write** as the other three classes, with the
  usual `.bak-<unix-ms>` backup and post-write verification (which now re-runs the
  schema scan too).

The forward fix lives in the writers: `dsh-magic-context`'s activity rows pass
`{kind:"user"}` (attribution stays in the `commandId` namespace and the row
title), and both the Dreamer child driver and the scheduler project a resolved
call config onto the declared `model/selection` members before committing it. The
notifications smoke test asserts the emitted rows against this plugin's scanner,
so re-introducing an undeclared member fails a test instead of stranding sessions
at the next upgrade.

## Offline CLI

The HTTP routes need a running DSH, but a container-broken log makes DSH
unbootable — the web tool is unreachable exactly when it is needed. Run the
CLI against the installed copy (so its `@deepseek-ai/*` imports resolve):

```bash
node ~/.dsh/profiles/node_modules/dsh-plugin-session-repair/lib/cli.mjs \
  scan <path/to/session.jsonl.zstd>
node ~/.dsh/profiles/node_modules/dsh-plugin-session-repair/lib/cli.mjs \
  repair <path/to/session.jsonl.zstd> [--dry-run]
node ~/.dsh/profiles/node_modules/dsh-plugin-session-repair/lib/cli.mjs scan-all
node ~/.dsh/profiles/node_modules/dsh-plugin-session-repair/lib/cli.mjs \
  normalize-all [--dry-run]
```

`scan`/`repair` take a direct log path (backups included); `scan-all` sweeps
every project directory under `$DSH_HOME/sessions`; `normalize-all` is the
pre-upgrade sweep — it walks the same directories and rewrites **only** the logs
whose rows a newer line's catalog would refuse, leaving structurally healthy logs
untouched (`--dry-run` reports without writing). Point it at a copy first
(`DSH_HOME=<copy>`), verify the migration, then run it against the live home.
Write-path discipline: all log rewrites must go through this plugin (routes or
CLI) — a manual `zstd -f file` recompression produces exactly the single-frame
incident, and backup names must keep the `.bak-<unix-ms>` convention.

## Client UI

A "会话修复 / Session repair" section in the Settings sidebar: workspace path
(persisted in localStorage; empty scans everything), scan, per-session dry
run / repair / restore.

Plus a "修复 / Repair" trigger in the session header's utilities band. It
targets exactly the session it is mounted on (`cwd` comes from the sessions
list store) and shows a small anchored panel: the dry run doubles as the
status probe — HTTP 200 means the log is damaged and the response carries the
repair preview, HTTP 409 means the contiguity scan is clean — then the panel
offers repair, and afterwards restore-from-backup. The sidebar row menu
(rename/fork/archive) is hardcoded in the host workspace bundle with no
extension slot, which is why the entry lives in the header band.

## Companion data: magic-context seq references

The repair renumbers events, so `dsh-magic-context`'s database
(`$DSH_HOME/magic-context/context.db`) references must shift with them for
`ctx_expand` provenance and compaction ranges to stay correct. The plugin is
deliberately generic and does not touch that database; after a real repair,
shift by the same rule the log used:

- `shift-tail` sessions: every reference `≥ G` moves by `+(E-G)`;
- batch sessions: every reference `≥ G` (the batch start) moves by the tail
  delta `+(E-3-G)` — references to the deleted synthetic seqs would dangle,
  but magic-context only references surface events, and the real tool result
  that replaced the synthetic one sits in the tail band.

Tables/columns: `paragraphs.seq`, `skip_marks.seq` (by `session_id`);
`compartments.start_seq/end_seq/landing_seq` (by `session_id`);
`memories.source_start_seq/source_end_seq` (by `source_session_id`). Update
rows in **descending** seq order (or by rowid), because each row moves up into
space a not-yet-shifted row may still occupy.

## Incident record (2026-09-06)

All six corrupted logs were repaired through the isolated-instance route
(dry-run first, then repair; automatic `.bak-<ts>` backups), the full rescan
reported 245 healthy / 0 corrupted, every repaired file passes the real DSH
storage decoder, and 428 magic-context reference rows were shifted by the rule
above. See `docs/session-seq-corruption-report.md` for the upstream report.

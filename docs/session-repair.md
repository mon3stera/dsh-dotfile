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
the replacement range of a landed `surfaceOp` marker (`{op: "replace", start,
end}`, written by checkpoint landing). A marker whose range stops tracking the
surface makes restore fail with "surface replace: end seq ... not found in
surface" even though the contiguity scan passes. History loss is
limited to the three synthetic events; the real tool result (with its actual
content) survives.

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

## Settings UI

A "会话修复 / Session repair" section in the Settings sidebar: workspace path
(persisted in localStorage; empty scans everything), scan, per-session dry
run / repair / restore.

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

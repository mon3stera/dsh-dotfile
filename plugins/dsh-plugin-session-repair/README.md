# dsh-plugin-session-repair

Offline repair for session logs whose event sequence numbering collided.

## The corruption

DSH persists sessions as append-only multi-frame zstd JSONL logs where every
event carries a dense `seq`. A harness-side race (a turn interrupted while a
tool call is pending: the interrupt path persists a synthetic
`interrupted-tool-result` batch, and the original in-flight session object
later commits the real tool result — or a queued prompt splice — with its
pre-interrupt event counter) leaves a *backward* seq transition in the log.
The persistence reader fails closed on load:

```
corrupt session log: seq gap in committed region at line N (expected E, got G)
```

Observed on six real logs (2026-08-17 .. 2026-09-06) across three workspaces;
every occurrence followed an interrupted turn with a pending tool call.

## The fixed repair pattern

1. locate the first backward seq transition (expected `E`, got `G`);
2. if the committed rows in `[G, E)` contain the synthetic interrupt batch
   (`interrupted-tool-result` + `step/end` + interrupted `turn/end`), delete
   those three rows and shift every later row down by three — avoiding two
   tool results for one tool call, which providers reject;
3. otherwise shift every row from the gap onward up by `(E - G)`;
4. repeat while the exact contiguity scan still fails.

Streaming-chunk runs are stored as packed `text-chunks` / `reasoning-chunks` /
`tool-call-chunks` rows carrying `seq0`; repairs shift `seq`, `seq0`, and
`sourceEventSeqs` provenance references. History loss is limited to the three
synthetic events in batch mode; the late tool result (with its real content)
survives.

## Routes

- `GET /session-repair/scan?cwd=<abs path>` — scan one workspace (omit `cwd`
  to scan every project directory). Reports corrupted logs with their gap,
  whether the synthetic batch marker is present, and existing backups.
- `POST /session-repair/repair` — body `{sessionId, dryRun?}`. Repairs the
  log atomically; the original is kept as `session.jsonl.zstd.bak-<ts>`.
  A post-write verification re-scans the written file and reports failure
  otherwise.
- `POST /session-repair/restore` — body `{sessionId}`. Restores the newest
  backup (keeping the current file as `.pre-restore-<ts>`).

The zstd codec is the `zstd` CLI: DSH writes many concatenated frames per
log, which the one-shot zlib zstd functions do not decode.

## Settings UI

A "会话修复 / Session repair" section in the Settings sidebar: workspace path
(persisted in localStorage; empty scans everything), scan, per-session dry
run / repair / restore.

# Upstream report: backward seq transition after an interrupted tool call

Draft for a GitHub Discussion (the repository does not accept Issues). Written
2026-09-06 from six corrupted production logs on one deployment (DSH on Linux,
a second browser client attached over SSH port forwarding, several
reconnects/restarts in the window).

---

## Title

Session log becomes unloadable: backward seq transition when an in-flight tool
result (or queued prompt splice) commits through a stale pre-interrupt session
object

## Summary

When a turn is interrupted while a tool call is still pending, DSH persists a
synthetic `interrupted-tool-result` batch and advances the persisted seq
counter. If the original in-flight session object later commits the real tool
result — or an `agent/inbox/spliced` append for a prompt queued during the
interruption — it writes with its **pre-interrupt** event counter. The log
then contains a backward seq transition, and the persistence reader fails
closed forever after:

```
corrupt session log: seq gap in committed region at line 10820 (expected 75314, got 75305)
failed to observe session "session-c5876cf6-…"
```

The session never loads again; the corruption is permanent without offline
surgery.

## Affected sessions (one deployment, three workspaces)

| session | gap (expected → got) | late writer |
|---|---|---|
| `session-8b0ba0d9-…` | 182759 → 182755 | real tool result |
| `session-a81e937b-…` | 314116 → 314113 | `agent/inbox/spliced` |
| `session-0f88a97d-…` | 33912 → 33906 | real tool result |
| `session-b1818d68-…` | 54475 → 54469 | real tool result |
| `session-b9b19665-…` | 8 → 5 | `agent/inbox/spliced` |
| `session-c5876cf6-…` | 75314 → 75305 | real tool result |

Every case follows an interrupted turn with a pending tool call. In the four
tool-result cases, the real result for the same `callId` lands seconds after
the synthetic interrupted copy, with the pre-interruption seq — e.g.
`session-0f88a97d`: synthetic result at seq 33906, real result for the same
callId also numbered 33906 seven seconds later.

## Reproduction sequence

1. A turn starts a long-running tool call.
2. The turn is interrupted (stop button / client disconnect mid-stream). The
   interrupt path persists the synthetic `interrupted-tool-result` batch
   (`tool/result` with an `interrupted-tool-result-…` message id +
   `step/end` + `turn/end {reason:{kind:"interrupted"}}`) and the counter
   advances by three.
3. The original session object that owned the pending tool call is still
   alive (open second client, reconnect, or restart race) and later commits
   the real tool result through `Session.append()` with its stale
   pre-interruption counter.
4. All subsequent events follow the stale counter; the tail is numbered
   several events below the committed prefix.
5. The next full log scan (`SessionLogScanner.consumeEventLine`) rejects the
   log permanently.

Contributing trigger on this deployment: a second browser client attached
through SSH port forwarding and service restarts with sessions open — both
keep a second/restored session object alive across the interrupt. The direct
defect is still single-writer correctness: the stale object must not be able
to commit with an old counter.

## Why the reader cannot recover

`SessionLogScanner` treats the committed prefix as authoritative and rejects
any backward transition. That fail-closed behavior is correct for detecting
real corruption, but combined with the race above it turns a recoverable
writer bug into permanent data loss.

## Suggested upstream fixes (any one would have prevented this)

1. **Reject stale commits at the seq level**: persist a per-log
   writer-generation/monotonic append token; `append()` from a session object
   whose counter is behind the log's committed count is refused (or forced to
   renumber) instead of written.
2. **Invalidate in-flight tool results on interrupt**: when the synthetic
   interrupted batch is persisted, mark the pending `callId` aborted in the
   session state so the late real result is dropped or logged as ignorable
   rather than appended.
3. **Detect and heal at load**: on a backward transition whose collision
   region contains the synthetic batch, skip those three rows and renumber
   (this is exactly what the offline repair does).

## Offline repair (what we shipped)

A local plugin (`dsh-plugin-session-repair`) implements the fixed pattern:
delete the synthetic batch and renumber the committed rows down by three,
then shift the late tail up by one uniform delta (or shift the tail up
directly when no batch exists); `seq`, packed-chunk `seq0`, and
`sourceEventSeqs` provenance all shift; the original log is backed up and the
rewritten file is re-verified against the exact contiguity scan. All six
logs above were repaired this way and load again; history loss was limited to
the three synthetic events per log.

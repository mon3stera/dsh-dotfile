# dsh-plugin-usage — Token Usage Dashboard

A session-header panel that shows what a session actually cost in tokens.
Built for consumption optimization: the numbers you optimize against should
not be estimates.

## What is exact and what is estimated

The session log (`$DSH_HOME/sessions/<project>/<session-id>/session.jsonl.zstd`)
carries everything the panel needs:

| Log event            | Used for                                                              |
| -------------------- | --------------------------------------------------------------------- |
| `assistant/message`  | `data.usage` per request: `inputTokens` (uncached), `outputTokens`, `totalTokens` (= input + cacheRead + output), plus `cacheReadTokens` / `cacheWriteTokens` when the provider reports them. **Exact billing data.** |
| `request/header`     | The assembled request: `config` (provider/model/effort), the full `system` prompt text, and the `tools` array. Feeds the composition estimate. |
| `request/context`    | `contextWindow`, so the current-context card can show a real percentage. |
| Message events       | Conversation material (`user/message`, `assistant/message`, `tool/result`, `agent/inbox/spliced`), deduplicated by message id and bucketed by source kind. |

Exact: every per-request row, all cumulative totals, cache hit rate, prefix
rewrite flags, current context size.

Estimated: the per-category composition. The log stores the material but not
a tokenizer, so `lib/collect.js` applies a CJK-aware character heuristic
(CJK ≈ 0.85 tokens/char, other ≈ 3.8 chars/token), then normalizes the
shares to the last request's exact `totalTokens`. The panel shows the raw
estimate's deviation from the exact total (typically -15% to -35% on
mixed CJK/English traffic) so the reader can judge the error. On this
workspace the shares land around: tool results ~42%, assistant ~28%,
workspace instructions ~15%, tool definitions ~12%, system prompt ~3%.

## Categories

- `system` — system prompt (from `request/header`)
- `tools` — tool definitions (from `request/header`)
- `instructions` — workspace/agent instructions (`source.kind: agent-instructions`)
- `skills` — skill catalog (`source.kind: skill-catalog`)
- `memory` — plugin-injected context (`source.kind: plugin`)
- `user` — user messages (`source.kind: user`)
- `assistant` — assistant messages
- `tool` — tool results (bucketed by row type `tool/result`; some envelopes
  carry `role: "user"`, so the envelope role is deliberately ignored)

## Panel

The trigger sits in `conversation.session.header.utilities` (order 72, next
to the diff-viewer entry). Three tabs:

- **构成 / Composition** — summary cards (current context vs window, session
  total, billed input incl. cache, output, cache hit rate, rewrites) plus the
  stacked composition bar and per-category table. Polls every 15 s while open.
- **请求 / Requests** — the exact per-request table (turn.step, time, input,
  cache read, output, context size), newest first. A later request with
  `cacheReadTokens: 0` is flagged 全量重写 (full prefix rewrite); one reading
  under 50% of the previous context size (when that exceeded 20k) is flagged
  疑似重写 (suspected partial rewrite). These flags are what typically
  explain billed-input explosions on pooled upstreams.
- **会话 / Sessions** — one summary row per session of the workspace (via
  `/usage/overview`), click an id to copy it.

## Host routes

- `GET /usage/overview?cwd=<abs>` — summary row per session, narrowed to one
  workspace when `cwd` is given; scans every project directory otherwise.
- `GET /usage/session?id=<id>&cwd=<abs>` — full detail: exact request rows,
  turn rollups, aggregates, composition.

Parsed logs are cached in memory keyed by path and invalidated by
(mtimeMs, size); a cold workspace scan costs ~1 s, warm scans are ~0 ms.
Decompression goes through the `zstd` CLI because DSH writes many
concatenated frames per log, which the one-shot zlib zstd functions do not
decode.

## Known limitations

- The composition reflects the material still present in the log. Events
  already compacted away by dsh-magic-context are not in the log anymore
  (compaction rewrites the projected context, not the log — historical
  request rows keep the sizes they had when they were served).
- Token estimates are heuristic by design; only the shares after
  normalization are meaningful.
- `cacheWriteTokens` is present only when the provider reports it; the
  DeepSeek/zai route used here reports cache reads but not writes.

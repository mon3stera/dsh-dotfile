# dsh-plugin-tool-gate — Progressive Tool Loading

A host-plane plugin that keeps heavy tools out of the request's `tools` array
until they are needed. Motivated by the usage dashboard: on this deployment
36 tool definitions cost ~10k tokens of fixed prefix, and the top offenders
(desktop control ~1.1k, context7 ~1.2k, workflow ~1.0k, delegation ~1.3k)
are rarely needed in a single session. Gating shrinks the fixed prefix to a
resident set plus a compact catalog (~2-3k), which also shrinks every cache
rewrite's full-price section.

## Mechanism

- **Hide** — for every session's agent, `agent.ctx.tools.restrict({ deny })`
  removes the configured hidden names from that agent's view. The request
  assembler reads `view(scope).visible` (`wireSchemas`), so the next request
  simply carries fewer tools. Gated tools stay registered and executable;
  a model call to one is denied as `UNKNOWN_TOOL`, the same failure an absent
  definition produces, so the failure mode is benign and recoverable.
- **Catalog** — a `tool-gate:catalog` system-prompt section lists every gated
  tool as `name - summary`, plus the expand contract. Summaries come from the
  curated map in `lib/summaries.js`; a name missing from the map falls back to
  the first sentence of the tool's own description, read from the pre-gate
  view. The section text is empty until the first gate fills it.
- **Expand** — one real tool, `tool_expand({tools: string[]})`, re-restricts
  the caller's agent without the requested names (dispose old restriction,
  apply the reduced deny; an empty deny is not re-applied). Expansion is
  per-agent by construction (`exec.agent.ctx`) and takes effect on the next
  step of the same turn. Calls that free nothing (already loaded / unknown
  names) do not touch the restriction — no cache churn without a change.

The ctx_* tools (dsh-magic-context) are deliberately resident: the model uses
them constantly and their guidance section would be dead weight if they were
hidden. read/write/edit/bash/glob/grep and the other small utilities stay
resident for the same reason.

## Lifecycle hooks

Three idempotent hooks converge on `gate(sessionId, agentHint)`:

- `agent/session-start` — primary. The agent-loop emits it with the agent
  object on fresh start and resume, before the first request assembly.
- `session/created` — primes fresh sessions; the agent may not be composed
  yet, so this often no-ops.
- `session/event` on `turn/start` / `user/message` — fallback when neither
  hook found a live agent; both events precede the first request of a turn.

A resumed session gets a NEW agent object whose layer has no restriction, so
`gate()` compares agent identity and re-gates, disposing the stale disposer.
`session/disposed` disposes and drops the entry. Every seam fails open: if
the `agents` service is missing or the agent is unreachable, the session
keeps all tools.

## Configuration

`enabled` (true), `hidden` (DEFAULT_HIDDEN: desktop five, context7 pair,
workflow, ralph, subagent family five, goal trio, jobs trio), `sectionOrder`
(1615), `expandToolName` (`tool_expand`). Configured names are pre-filtered
against the agent's `restrictableNames` — the registry throws on unknown
names, so drift across DSH updates degrades to "fewer tools gated" (logged)
instead of a broken session.

## Cache behavior

The gated prefix is stable per session (same catalog, same deny set), so
caching works normally. Two deliberate rewrite points: the first request of
a session (smaller prefix than before the plugin existed) and each expand
call (the tool block changes, rewriting the cache from that block onward).
The catalog tells the model to batch expansions for exactly this reason.

## Verification

`tests/dsh-tool-gate-smoke.mjs` covers the pure math (normalization,
visible-deny intersection, expand transitions, catalog text) and the plugin
wiring against stubs (lifecycle hooks, idempotency, resume re-gate, disposal,
fail-open paths, disabled config). The live path was verified end to end on
an isolated instance: request 1 carried 17 tools (was 36) with the catalog in
the system prompt; a real model turn called `tool_expand(["workflow",
"subagent"])` and the next request (reason `change`) carried 19 tools with
workflow/subagent present and the rest still gated.

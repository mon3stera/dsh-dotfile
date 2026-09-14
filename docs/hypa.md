---
description: "How dsh-plugin-hypa runs bash commands through the Hypa compression runtime: the per-agent shadow seam, the rewrite decision, the skip rules, and the sandbox caveat."
kind: "plugin-reference"
---

# dsh-plugin-hypa

Runs every foreground `bash` call through [Hypa](https://github.com/Hypabolic/Hypa),
a local command runner that buffers output, reduces it with deterministic
reducers and DSL filters, and appends a footer when it actually saved tokens:

```text
[hypa: 363->206 tok, -43%, reducer=git-status]
```

The model's command string is untouched. Hypa is transparent: the model writes
`git status`, the harness executes `hypa -c 'git status'`, and the tool result
carries the reduced output plus the footer.

## Why a shadow registration, not a hook

DSH's `tools/pre-execute` is the Claude-Code `PreToolUse` analogue, and it can
only allow/deny/ask — it **deliberately cannot rewrite `exec.arguments`**
(`dsh-tools` README: "logged and rendered args would desync from what ran; the
rewrite design is a proposed Agent Note"). `dsh-hooks-claude-code` parses
`hookSpecificOutput.updatedInput` but logs it without honoring it, so Hypa's own
`hypa hook --agent claude` bridge is a silent no-op here. Mutating
`exec.arguments` inside a `tools/execute` wrapper would work mechanically and is
exactly the desync the design forbids.

The supported seam is a **per-agent shadow**: `ToolRuntime.view(scope)` applies
the agent's own layer last (`visible.set(name, definition)`), and the registry's
duplicate-name error points at it — "for a per-agent variant, register through
that agent's `agent.ctx` instead". So on `agent/session-start` the plugin reads
the base `bash` definition, registers a copy under the same name through
`agent.ctx.tools.register`, and replaces only `execute`. The description,
parameters, output schema, and presentation callbacks are reused by reference,
so the wire schema is byte-identical and the prompt prefix does not change.

The base definition is captured **before** registering, because afterwards the
agent's own view resolves to the shadow. The global view (`ctx.tools.get`) is
preferred and the agent view is the fallback, since the agent preset mounts
`tool-bash` into its own layer rather than the global one. A resumed session
composes a new agent object: the plugin re-shadows it and disposes the stale
registration (the same lifecycle `dsh-plugin-tool-gate` uses). This is a
host-plane patch row, not a preset row: a registration made from a preset row
lands in the global layer, where the name already exists.

## Per-call decision

1. Pure skip rules first (no process spawn): disabled, empty command, an
   existing `hypa` command, `run_in_background: true`, or a bare shell builtin.
2. The sandbox gate: Hypa records metrics and artifacts under `~/.hypa`, so a
   confined mode would deny its writes and turn a working command into a Hypa
   failure. Only `sandboxModes` (default `["danger-full-access"]`) wrap.
3. `hypa rewrite --json <command>` decides. `Rewritten` and `GenericWrapper`
   wrap; `Passthrough`, `Deny`, and `Ask` run the original — compression is not
   a policy layer, and DSH has its own approval surface. Decisions are cached
   per command string for `decisionTtlMs` (default 5 min), which saves one
   process spawn per repeated command (~90 ms each).
4. The executed command is built as `hypa --timeout-ms <ms> -c '<command>'`.

Two details in step 4 and 3 are deliberate:

- **Hypa's own rewritten string is not used.** `hypa rewrite` emits
  `hypa -c "grep -n '$foo' file"` — double-quoted, so the outer shell expands
  `$foo` before Hypa ever sees it and the literal pattern is lost. The plugin
  single-quotes the original command itself (`'` becomes `'\''`), so `$`,
  backticks, and quotes reach Hypa verbatim. Hypa still applies its reducers to
  the generic wrapper path: `hypa -c 'git status'` produced the same
  `reducer=git-status` footer as `hypa git status`.
- **`--timeout-ms` is always passed.** Hypa's own default is 30 s (10 min for
  package managers), which would kill long commands far earlier than the
  harness would. The model's `timeoutMs` wins; otherwise `defaultTimeoutMs`
  (default 10 min) applies, and the harness's own timeout still kills the
  process tree first when it is smaller.

`hypa rewrite` exits 0/1/2/3 for Rewritten+GenericWrapper/Passthrough/Deny/Ask,
so `execFile` rejects on three of the four decisions **with a valid JSON payload
on stdout**; the plugin parses the rejection payload before treating it as a
failure.

## Skip rules and sharp edges

- **Bare shell builtins are never wrapped.** Hypa spawns a simple command as
  argv directly, so `type ls`, `time make`, `exit 1`, and `cd /tmp` (no shell
  metacharacters) fail with `hypa: An error occurred trying to start process
  'type'` and exit 1 instead of running. Commands carrying shell syntax (pipe,
  `&&`, `;`, redirect, `$`, backticks, parens) go through a shell and are
  unaffected, so `cd /tmp && pwd` wraps fine. `lib/wrap.js` therefore skips any
  command with no shell syntax whose first word is a builtin/keyword.
- **Background jobs are never wrapped.** `run_in_background` returns a process
  handle that the model reads incrementally with `job_output`; buffering it
  would break streaming.
- **Small outputs are unchanged anyway.** Hypa passes output below its small
  output threshold straight through, so the only cost on a quiet command is the
  ~90 ms process spawn.
- Every failure path fails open: a missing binary (probed once, then remembered),
  a timeout, an unparseable payload, a throwing decision, or a sandbox-mode
  resolution error leaves the command exactly as the model wrote it.

## Configuration

```yaml
- id: dsh-plugin-hypa
  name: dsh-plugin-hypa
  config:
    enabled: true
    hypaBin: hypa
    defaultTimeoutMs: 600000
    rewriteTimeoutMs: 5000
    decisionTtlMs: 300000
    sandboxModes: ["danger-full-access"]
    systemPromptNote: true
    sectionOrder: 1620
```

`systemPromptNote` adds one static sentence to the system prompt explaining that
the `[hypa: ...]` footer is compression metadata and that the `[exit code: N]`
marker still describes the command. It is worth the tokens: a model that reads
the footer as command output misreports results.

## Deployment

Install Hypa (a release asset, or `npm install -g @hypabolic/hypa`), mirror the
plugin into the runtime profile, and add the patch row. A loaded package needs a
new DSH process: verify on an isolated `dsh web --port 3081` before considering
the primary service.

## Verification

- `node tests/dsh-hypa-smoke.mjs` covers the wrapping math, every skip and
  fail-open path, the decision cache, the identical-schema shadow, resume
  re-shadowing, and a stub `hypa` binary driven through the real `execFile`
  path.
- Live end to end on this deployment (`dsh --profile headless --patch` with the
  row, one prompt asking for `git status` verbatim): the tool result carried
  `[hypa: 363->206 tok, -43%, reducer=git-status]`, the model quoted the
  system-prompt note when reasoning about the footer, and Hypa's own
  `~/.hypa/hypa.db` recorded `command_metrics` for `git status` with
  `original_tokens 363`, `compressed_tokens 206`, `reducer_id git-status`.

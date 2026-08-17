# dsh-magic-context

Magic Context-inspired context management for DeepSeek Harness (DSH), implemented
on DSH and Cordis APIs. It provides asynchronous compartment compaction,
paragraph numbering, workspace-scoped project memory, hybrid retrieval, and the
Dreamer background maintainer.

This package is an installable DSH profile bundle. It is not a source-level or
behavior-for-behavior copy of another project.

## Install

After publishing to npm:

```sh
dsh plugin --profile web add dsh-magic-context
```

From a local checkout, build a tarball first so peer dependencies resolve from the profile:

```sh
cd plugins/dsh-magic-context
npm pack
dsh plugin --profile web add ./dsh-magic-context-0.1.0.tgz
```

The bundle adds the host-side settings bridge and the browser settings panel.
It does not change the user's default agent preset. On the next DSH startup it
prints a setup notice explaining this boundary and the required preset rows.

## Enable the ContextEngine

`ContextEngine` is intentionally an agent-plane service. Mount it inside an
isolated `compaction` group in the preset used by your sessions. The repository
contains a complete example at
`profile/agent-presets/context-compact/agent.cordis.yml`.

The compaction group must retain the command and tool-result-pruner rows:

```yaml
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
    toolResultPruner: true
  config:
    - id: context-engine
      name: dsh-magic-context
    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'
    - id: tool-result-pruner
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
```

Copy the complete example into a user-owned preset before editing it. Do not
put the ContextEngine in the host root: compaction providers and their session
state belong to an isolated agent-preset realm.

## Storage and HTTP

The plugin stores its database, settings, and local model cache under:

```text
$DSH_HOME/magic-context/
```

The settings bridge exposes:

- `/magic-context/config`
- `/magic-context/usage`
- `/magic-context/models/status`
- `/magic-context/models/ensure`

## Commands and tools

The ContextEngine adds `/dream`, `/ctx-search`, and `/inject-memory`, plus the
`ctx_reduce`, `ctx_expand`, `ctx_memory`, and `ctx_search` tools when mounted in
an agent preset.

## Development

The repository smoke tests import the mirrored runtime copy. After changing the
plugin, sync it with:

```sh
rsync -a --delete --exclude 'node_modules/' \
  plugins/dsh-magic-context/ \
  "$DSH_HOME/profiles/node_modules/dsh-magic-context/"
```

Run the focused tests from the repository root:

```sh
node tests/dsh-context-db-smoke.mjs
node tests/dsh-context-engine-smoke.mjs
node tests/dsh-context-memory-smoke.mjs
node tests/dsh-context-preset-smoke.mjs
```

## License

MIT

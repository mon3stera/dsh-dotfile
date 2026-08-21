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

The bundle adds one `host: true` bare-package shell that mounts the settings
bridge and startup guidance. That row also makes the browser panel available from
the first Web page load. It does not change the user's default agent preset. If
the packaged preset is missing, the next DSH startup prints this command:

```sh
dsh plugin --profile web exec dsh-magic-context-install-preset
```

The command copies `context-compact` to `$DSH_HOME/.agent-presets/` without
changing the default preset or overwriting an existing user preset. Once it is
installed, the startup notice is suppressed.

Local Transformers.js embedding and rerank models are optional. The core bundle
uses FTS5 and external-compatible retrieval without `@huggingface/transformers`.
Install the optional peer with explicit native-build approval only when local
model support is needed:

```sh
dsh plugin --profile web add \
  --allow-build=onnxruntime-node \
  --allow-build=protobufjs \
  --allow-build=sharp \
  @huggingface/transformers
```

If a local preset is selected without this package, the settings panel reports
the missing dependency and the same installation command; retrieval falls back
to FTS5 until it is installed.

## Enable the ContextEngine

`ContextEngine` is intentionally an agent-plane service. The install command
copies a complete example into `$DSH_HOME/.agent-presets/context-compact/`.
Select that preset for new sessions, or set it as the default explicitly. The
repository source for the same composition is
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
      name: dsh-magic-context/engine
    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'
    - id: tool-result-pruner
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
```

The installer provides this complete example as a user-owned preset. If you
edit it, keep the ContextEngine out of the host root: compaction providers and
their session state belong to an isolated agent-preset realm.

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

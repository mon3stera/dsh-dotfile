# dsh-header-rewrite

Rewrite HTTP request headers for LLM provider calls with configurable match
rules. The plugin wraps the global `fetch` once at startup; provider SDKs
(the Anthropic/OpenAI clients behind pi-ai, deepseek's direct fetch, model
discovery) read that global per request, so the rules apply to every request
the harness sends.

Typical use case: an upstream gateway enforces a User-Agent allowlist (e.g.
only `claude-cli/...`) and rejects the harness attribution header
(`deepseek-harness/...`). Configure a rule that rewrites `User-Agent` for
that gateway's host only, leaving every other upstream untouched.

## Install

Sync the plugin into the runtime profiles directory (see the repo
`AGENTS.md` for the documented rsync procedure), then add it to the profile
loader patch (`~/.dsh/profiles/web/cordis.patch.yml` or your profile's):

```yaml
- insert:
    - id: dsh-header-rewrite
      name: dsh-header-rewrite
      config:
        rules:
          - match:
              host: agentrouter.org
              path: /v1/messages
              model: "*"
            headers:
              User-Agent: claude-cli/1.0.0 (external, cli)
```

Restart the DSH process for the patch to load.

## Web settings

The plugin adds a "Header rewrite" section to the Settings sidebar with a
YAML editor. The editor shows the currently active rules (the persisted file,
or the seed from the patch) and saving them writes
`$DSH_HOME/header-rewrite/config.yaml` and applies the rules immediately -
no restart needed. The editor accepts the same YAML as the patch `config`
above.

## Configuration

`rules` is a list of rule objects:

| Field | Type | Meaning |
|---|---|---|
| `match.host` | string | Hostname to match (`*` wildcards, e.g. `*.example.com`); omit = any |
| `match.path` | string | URL pathname to match (`*` wildcards); omit = any |
| `match.model` | string | Model id read from the JSON request body (`*` wildcards); omit = any |
| `match.method` | string | HTTP method, case-insensitive; omit = any |
| `headers` | map | Headers to set; a `null` value deletes the header |

All `match` conditions must hold for a rule to apply (AND). Rules apply in
config order; when several rules match, later rules win on the same header.

The rule above is a no-op for every host except `agentrouter.org`, so other
providers keep their original headers.

## Notes

- Model matching parses the request body as JSON; requests whose body is not
  JSON skip the `model` condition.
- The wrapper is idempotent: calling `apply` again (hot reload) does not
  stack another layer.
- Only request headers are modified; bodies and responses pass through
  unchanged.

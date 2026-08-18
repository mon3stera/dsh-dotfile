/**
 * Smoke test for dsh-header-rewrite: config schema, rule matching/rewriting,
 * YAML persistence + config route, and the client settings-section
 * registration. The host half imports the installed plugin copy (rsync from
 * plugins/ first); the client half reads this repo's copy.
 * Run: node tests/dsh-header-rewrite-smoke.mjs (from the repo root)
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import vm from "node:vm";

const plugin = await import(
  "/home/mon3tr/.dsh/profiles/node_modules/dsh-header-rewrite/lib/index.js"
);

const TEST_HOME = "/home/mon3tr/dsh-header-rewrite-test-home";
process.env.DSH_HOME = TEST_HOME;
rmSync(TEST_HOME, { recursive: true, force: true });
mkdirSync(TEST_HOME, { recursive: true });

const realFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (input, init) => {
  calls.push({ input, init });
  return { ok: true, status: 200 };
};

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL - ${name}:`, error.message);
  }
}

// ---------------------------------------------------------------------------
// Host: schema + rule matching
// ---------------------------------------------------------------------------

check("schema accepts a full rule with null header", () => {
  const result = plugin.Config["~standard"].validate({
    rules: [
      {
        match: { host: "agentrouter.org", path: "/v1/*", model: "*", method: "post" },
        headers: { "User-Agent": "claude-cli/1.0.0 (external, cli)", "X-Drop": null },
      },
    ],
  });
  assert.equal(result.issues, undefined);
  assert.equal(result.value.rules[0].headers["X-Drop"], null);
});

check("schema defaults to empty rules", () => {
  const result = plugin.Config["~standard"].validate(undefined);
  assert.deepEqual(result.value, { rules: [] });
});

// Host apply stub: records registered routes, runs the webServer callback.
const hostRoutes = [];
function stubHostCtx() {
  return {
    inject: (deps, cb) => {
      assert.deepEqual(deps, ["webServer"]);
      const httpCtx = {
        effect: (fn) => { fn(); },
        webServer: { register: (route) => { hostRoutes.push(route); } }
      };
      cb(httpCtx);
    }
  };
}

/** Reset the wrapper so the next apply() starts from the real stub fetch. */
function applyRules(rules) {
  globalThis.fetch = realFetch;
  delete globalThis.__dshHeaderRewritePatched;
  hostRoutes.length = 0;
  plugin.apply(stubHostCtx(), { rules });
}

function headerOf(init, name) {
  return new Headers(init.headers).get(name);
}

applyRules([
  {
    match: { host: "agentrouter.org" },
    headers: { "User-Agent": "claude-cli/1.0.0 (external, cli)" },
  },
]);

check("apply registers the /header-rewrite/config route", () => {
  assert.equal(hostRoutes.length, 1);
  assert.equal(hostRoutes[0].path, "/header-rewrite/config");
  assert.equal(hostRoutes[0].kind, "exact");
});

check("host match rewrites User-Agent and keeps other headers", async () => {
  calls.length = 0;
  await globalThis.fetch("https://agentrouter.org/v1/messages", {
    method: "POST",
    headers: { "User-Agent": "deepseek-harness/0.1.0", "x-api-key": "k" },
    body: JSON.stringify({ model: "claude-opus-5", messages: [] }),
  });
  const init = calls[0].init;
  assert.equal(headerOf(init, "user-agent"), "claude-cli/1.0.0 (external, cli)");
  assert.equal(headerOf(init, "x-api-key"), "k");
});

check("unmatched host passes through untouched", async () => {
  calls.length = 0;
  await globalThis.fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "User-Agent": "deepseek-harness/0.1.0" },
    body: JSON.stringify({ model: "claude-opus-5", messages: [] }),
  });
  assert.equal(headerOf(calls[0].init, "user-agent"), "deepseek-harness/0.1.0");
});

check("non-URL input passes through untouched", async () => {
  calls.length = 0;
  await globalThis.fetch(new Request("https://agentrouter.org/v1/messages", {
    method: "POST",
    headers: { "User-Agent": "deepseek-harness/0.1.0" },
  }));
  assert.equal(calls.length, 1);
});

applyRules([
  {
    match: { model: "claude-*" },
    headers: { "X-Model-Match": "yes" },
  },
]);

check("model wildcard matches from JSON body", async () => {
  calls.length = 0;
  await globalThis.fetch("https://example.com/v1/messages", {
    method: "POST",
    headers: {},
    body: JSON.stringify({ model: "claude-opus-5", messages: [] }),
  });
  assert.equal(headerOf(calls[0].init, "x-model-match"), "yes");
});

check("model mismatch skips the rule", async () => {
  calls.length = 0;
  await globalThis.fetch("https://example.com/v1/messages", {
    method: "POST",
    headers: {},
    body: JSON.stringify({ model: "gpt-5.6", messages: [] }),
  });
  assert.equal(headerOf(calls[0].init, "x-model-match"), null);
});

applyRules([
  {
    match: { host: "gateway.example", path: "/openai/v1/*" },
    headers: { "X-Via": "gateway", "X-Drop": "keep-me" },
  },
  {
    match: { host: "gateway.example" },
    headers: { "X-Drop": null, "X-Later": "wins" },
  },
]);

check("path glob narrows matching", async () => {
  calls.length = 0;
  await globalThis.fetch("https://gateway.example/openai/v1/chat/completions", {
    method: "POST",
    headers: {},
    body: JSON.stringify({ model: "gpt-5.6", messages: [] }),
  });
  assert.equal(headerOf(calls[0].init, "x-via"), "gateway");
  assert.equal(headerOf(calls[0].init, "x-later"), "wins");
});

check("null deletes a header set by an earlier rule; later rule wins on same name", async () => {
  calls.length = 0;
  await globalThis.fetch("https://gateway.example/openai/v1/chat/completions", {
    method: "POST",
    headers: {},
    body: JSON.stringify({ model: "gpt-5.6", messages: [] }),
  });
  assert.equal(headerOf(calls[0].init, "x-drop"), null);
  assert.equal(headerOf(calls[0].init, "x-later"), "wins");
});

check("non-matching path keeps request untouched", async () => {
  calls.length = 0;
  await globalThis.fetch("https://gateway.example/other/v1", {
    method: "POST",
    headers: {},
    body: JSON.stringify({ model: "gpt-5.6", messages: [] }),
  });
  assert.equal(headerOf(calls[0].init, "x-via"), null);
});

applyRules([
  {
    match: { method: "POST" },
    headers: { "X-Method": "post" },
  },
]);

check("method match applies to POST", async () => {
  calls.length = 0;
  await globalThis.fetch("https://example.com/v1/messages", {
    method: "POST",
    headers: {},
    body: JSON.stringify({ model: "m", messages: [] }),
  });
  assert.equal(headerOf(calls[0].init, "x-method"), "post");
});

check("GET request skips the POST rule", async () => {
  calls.length = 0;
  await globalThis.fetch("https://example.com/v1/models", { headers: {} });
  assert.equal(headerOf(calls[0].init, "x-method"), null);
});

check("apply re-uses the wrapper but adopts new rules", async () => {
  delete globalThis.__dshHeaderRewritePatched;
  globalThis.fetch = realFetch;
  plugin.apply(stubHostCtx(), { rules: [{ match: { host: "example.com" }, headers: { "X-Once": "1" } }] });
  const wrappedOnce = globalThis.fetch;
  plugin.apply(stubHostCtx(), { rules: [{ match: { host: "*" }, headers: { "X-Twice": "2" } }] });
  assert.equal(globalThis.fetch, wrappedOnce);
  calls.length = 0;
  await globalThis.fetch("https://example.com/v1/messages", {
    method: "POST",
    headers: {},
    body: JSON.stringify({ model: "m", messages: [] }),
  });
  assert.equal(headerOf(calls[0].init, "x-twice"), "2");
  assert.equal(headerOf(calls[0].init, "x-once"), null);
});

// ---------------------------------------------------------------------------
// Host: YAML persistence + config route
// ---------------------------------------------------------------------------

check("parseRulesYaml parses a valid rule list", () => {
  const rules = plugin.parseRulesYaml(
    "rules:\n  - match: { host: agentrouter.org }\n    headers:\n      User-Agent: claude-cli/1.0.0 (external, cli)\n",
  );
  assert.equal(rules.length, 1);
  assert.equal(rules[0].match.host, "agentrouter.org");
  assert.equal(rules[0].headers["User-Agent"], "claude-cli/1.0.0 (external, cli)");
});

check("parseRulesYaml accepts empty config", () => {
  assert.deepEqual(plugin.parseRulesYaml(""), []);
  assert.deepEqual(plugin.parseRulesYaml("rules: []"), []);
});

check("parseRulesYaml rejects invalid schema", () => {
  assert.throws(() => plugin.parseRulesYaml("rules:\n  - headers: 42"), /invalid|expected/i);
  assert.throws(() => plugin.parseRulesYaml("- not-an-object"), /top level/i);
  assert.throws(() => plugin.parseRulesYaml("rules: [not: [valid"), /invalid YAML/i);
});

check("saveRulesYaml persists and loadPersistedRules reads it back", () => {
  const yaml = "rules:\n  - match: { host: saved.example }\n    headers:\n      X-Saved: \"1\"\n";
  const rules = plugin.saveRulesYaml(yaml);
  assert.equal(rules[0].match.host, "saved.example");
  assert.deepEqual(plugin.loadPersistedRules(), rules);
});

// Stub request/response for handleConfig.
function stubRes() {
  return {
    _status: 0,
    _body: null,
    writeHead(status) { this._status = status; },
    end(payload) { this._body = payload; }
  };
}
function callGet() {
  const res = stubRes();
  return plugin.handleConfig({ method: "GET" }, res).then(() => ({
    status: res._status,
    json: JSON.parse(res._body),
  }));
}
function callPost(text) {
  const req = {
    method: "POST",
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(text); },
  };
  const res = stubRes();
  return plugin.handleConfig(req, res).then(() => ({
    status: res._status,
    json: res._body ? JSON.parse(res._body) : null,
  }));
}

check("GET config returns the persisted YAML text", async () => {
  const { status, json } = await callGet();
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.match(json.yaml, /saved\.example/);
});

check("POST config validates, persists, and applies immediately", async () => {
  const yaml = "rules:\n  - match: { host: updated.example }\n    headers:\n      X-Updated: \"1\"\n";
  const { status, json } = await callPost(yaml);
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  // Applied to the in-memory rules without re-apply: the next fetch sees it.
  calls.length = 0;
  await globalThis.fetch("https://updated.example/v1/messages", {
    method: "POST",
    headers: {},
    body: JSON.stringify({ model: "m", messages: [] }),
  });
  assert.equal(headerOf(calls[0].init, "x-updated"), "1");
});

check("POST config with invalid YAML returns 400 and keeps old rules", async () => {
  const before = plugin.loadPersistedRules();
  const { status, json } = await callPost("rules:\n  - headers: 42\n");
  assert.equal(status, 400);
  assert.ok(json.error);
  assert.deepEqual(plugin.loadPersistedRules(), before);
});

check("POST config too large returns 413", async () => {
  const big = "rules: []\n" + "#".repeat(70 * 1024);
  const { status } = await callPost(big);
  assert.equal(status, 413);
});

check("GET config with no persisted file returns the seed YAML", async () => {
  rmSync(`${TEST_HOME}/header-rewrite`, { recursive: true, force: true });
  // Re-seed via apply with a known patch config.
  delete globalThis.__dshHeaderRewritePatched;
  globalThis.fetch = realFetch;
  plugin.apply(stubHostCtx(), { rules: [{ match: { host: "seed.example" }, headers: { "X-Seed": "1" } }] });
  const { status, json } = await callGet();
  assert.equal(status, 200);
  assert.match(json.yaml, /seed\.example/);
  assert.match(json.yaml, /X-Seed/);
});

// ---------------------------------------------------------------------------
// Client: settings section registration
// ---------------------------------------------------------------------------

{
  const styleTags = [];
  globalThis.window = {
    __ModuleLoader__: { load: (entry) => { globalThis.__loadedEntry = entry; } },
  };
  globalThis.document = {
    querySelectorAll: () => [],
    createElement: (tag) => ({ dataset: {}, textContent: "" }),
    head: { appendChild: (el) => { styleTags.push(el); } },
  };

  // Stub the config GET used by apply()'s initial load.
  globalThis.fetch = async (url) => {
    if (url === "/header-rewrite/config") {
      return { ok: true, json: async () => ({ ok: true, yaml: "rules: []\n" }) };
    }
    throw new Error("FAIL: unexpected fetch " + url);
  };

  const code = readFileSync(
    new URL("../plugins/dsh-header-rewrite/lib/client.js", import.meta.url),
    "utf8",
  );
  vm.runInThisContext(code, { filename: "dsh-header-rewrite/lib/client.js" });

  const entry = globalThis.__loadedEntry;
  check("client registers under the plugin id", () => {
    assert.ok(entry);
    assert.equal(entry.id, "dsh-header-rewrite");
  });

  const clientExports = entry.factory((spec) => {
    if (spec === "react/jsx-runtime") return { jsx: (type, props, key) => ({ type, props, key }) };
    if (spec === "@deepseek-ai/dsh-client-runtime/client") {
      return {
        defineStore: (config) => ({
          ...config,
          create: () => ({
            actions: Object.fromEntries(
              Object.entries(config.actions).map(([key, fn]) => [key, (...args) => fn({}, ...args)]),
            ),
            getSnapshot: () => config.init(),
          }),
        }),
      };
    }
    throw new Error("FAIL: unexpected require: " + spec);
  });

  check("client exports name/inject", () => {
    assert.equal(clientExports.name, "dsh-header-rewrite");
    assert.deepEqual(clientExports.inject, ["slots", "locale"]);
  });

  const ctx = {
    _effects: [],
    _locales: null,
    _section: null,
    effect(cb) {
      ctx._effects.push(cb);
      const out = cb();
      return () => (typeof out === "function" ? out() : undefined);
    },
    locale: {
      register: (ns, dicts) => { ctx._locales = dicts; },
      bind: (ns) => (key) => (ctx._locales[key] ?? key),
    },
    slots: {
      inject: (key, cb) => { ctx._slotKey = key; ctx._section = cb(); },
      register: (opts, Component) => {
        ctx._sectionEntry = { ...opts, Component };
        ctx._sectionEntry.store = opts.store;
        return () => {};
      },
    },
  };

  clientExports.apply(ctx);

  check("client registers a settings.section entry", () => {
    assert.equal(ctx._slotKey, "settings.section");
    const e = ctx._sectionEntry;
    assert.equal(e.id, "header-rewrite");
    assert.equal(e.order, 30);
    assert.equal(typeof e.label(), "string");
    assert.equal(e.locale, "dsh-header-rewrite");
    assert.equal(typeof e.Component, "function");
    assert.ok(e.store);
  });

  check("client registers zh/en dictionaries with matching keys", () => {
    assert.ok(ctx._locales);
    assert.equal(ctx._locales.zh.nav, "Header 改写");
    assert.equal(ctx._locales.en.nav, "Header rewrite");
    assert.deepEqual(
      Object.keys(ctx._locales.zh).sort(),
      Object.keys(ctx._locales.en).sort(),
    );
  });

  check("client injects section styles", () => {
    assert.equal(styleTags.length, 1);
    assert.match(styleTags[0].textContent, /\.dhr-editor/);
  });
}

// ---------------------------------------------------------------------------
globalThis.fetch = realFetch;
delete globalThis.__dshHeaderRewritePatched;

console.log(failures === 0 ? "all tests passed" : `${failures} test(s) failed`);
process.exit(failures === 0 ? 0 : 1);

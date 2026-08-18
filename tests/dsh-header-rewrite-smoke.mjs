/**
 * Smoke test for dsh-header-rewrite (host/path/model/method matching and
 * header set/delete semantics) with a stub global fetch.
 * Run: node tests/dsh-header-rewrite-smoke.mjs (from the repo root)
 */
import assert from "node:assert/strict";

// Import the installed plugin copy so @deepseek-ai deps resolve.
const plugin = await import(
  "/home/mon3tr/.dsh/profiles/node_modules/dsh-header-rewrite/lib/index.js"
);

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

/** Reset the wrapper so the next apply() starts from the real stub fetch. */
function applyRules(rules) {
  globalThis.fetch = realFetch;
  delete globalThis.__dshHeaderRewritePatched;
  plugin.apply({}, { rules });
}

function headerOf(init, name) {
  return new Headers(init.headers).get(name);
}

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

// ---------------------------------------------------------------------------
applyRules([
  {
    match: { host: "agentrouter.org" },
    headers: { "User-Agent": "claude-cli/1.0.0 (external, cli)" },
  },
]);

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
  assert.equal(calls[0].input, "https://agentrouter.org/v1/messages");
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

// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
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
  assert.equal(headerOf(calls[0].init, "x-later"), null);
});

// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
check("apply is idempotent (no wrapper stacking)", async () => {
  applyRules([{ match: { host: "example.com" }, headers: { "X-Once": "1" } }]);
  const wrappedOnce = globalThis.fetch;
  plugin.apply({}, { rules: [{ match: { host: "*" }, headers: { "X-Twice": "2" } }] });
  assert.equal(globalThis.fetch, wrappedOnce);
  calls.length = 0;
  await globalThis.fetch("https://example.com/v1/messages", {
    method: "POST",
    headers: {},
    body: JSON.stringify({ model: "m", messages: [] }),
  });
  assert.equal(headerOf(calls[0].init, "x-once"), "1");
  assert.equal(headerOf(calls[0].init, "x-twice"), null);
});

// ---------------------------------------------------------------------------
globalThis.fetch = realFetch;
delete globalThis.__dshHeaderRewritePatched;

console.log(failures === 0 ? "all tests passed" : `${failures} test(s) failed`);
process.exit(failures === 0 ? 0 : 1);

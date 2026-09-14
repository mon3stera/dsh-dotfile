/**
 * Smoke test for dsh-plugin-hypa (pure wrapping math, the decide pipeline, and
 * plugin wiring with a stub hypa binary).
 * Run: node tests/dsh-hypa-smoke.mjs (from the repo root)
 *
 * The facts under test: the wrapper single-quotes the original command so the
 * outer shell cannot expand `$`/backticks inside it (hypa rewrite's own
 * rewritten string is double-quoted and therefore unsafe to substitute), the
 * per-call timeout is passed as `hypa --timeout-ms`, every skip path (background
 * jobs, bare shell builtins, an existing hypa command, a confining sandbox mode,
 * a missing or failing binary, a Passthrough/Deny/Ask outcome) leaves the
 * command untouched, decisions are cached per command string, and the plugin
 * shadows the agent's `bash` definition with an identical schema and re-shadows
 * a resumed agent while disposing the stale registration.
 */
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = fileURLToPath(new URL("../plugins/dsh-plugin-hypa/", import.meta.url));
const INSTALLED_PLUGIN_DIR = "/home/mon3tr/.dsh/profiles/node_modules/dsh-plugin-hypa";

const wrap = await import(`${PLUGIN_DIR}/lib/wrap.js`);

let failures = 0;

function check(label, condition) {
  if (condition) {
    console.log(`  ok: ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL: ${label}`);
  }
}

function section(title) {
  console.log(title);
}

// ---------- pure wrapping math ----------

section("wrap: singleQuote and buildWrappedCommand");
{
  check("escapes an embedded quote", wrap.singleQuote("a'b") === "'a'\\''b'");
  check("keeps shell metacharacters literal", wrap.singleQuote('echo "$HOME" `id`') === "'echo \"$HOME\" `id`'");
  check(
    "builds the timeout-first form",
    wrap.buildWrappedCommand({ bin: "hypa", command: "git status", timeoutMs: 600000 }) === "hypa --timeout-ms 600000 -c 'git status'",
  );
  check(
    "omits an absent timeout",
    wrap.buildWrappedCommand({ bin: "hypa", command: "ls", timeoutMs: undefined }) === "hypa -c 'ls'",
  );
  check(
    "quotes a binary path with spaces",
    wrap.buildWrappedCommand({ bin: "/opt/my hypa/hypa", command: "ls", timeoutMs: 1000 }) === "'/opt/my hypa/hypa' --timeout-ms 1000 -c 'ls'",
  );
}

section("wrap: parseRewriteResult and outcomeWraps");
{
  check("parses a decision", wrap.parseRewriteResult('{"input":"x","outcome":"Rewritten","command":"hypa x"}').outcome === "Rewritten");
  check("rejects non-JSON", wrap.parseRewriteResult("not json") === undefined);
  check("rejects a payload without an outcome", wrap.parseRewriteResult('{"input":"x"}') === undefined);
  check("rejects a non-string outcome", wrap.parseRewriteResult('{"outcome":3}') === undefined);
  check("only Rewritten and GenericWrapper wrap", wrap.outcomeWraps("Rewritten") && wrap.outcomeWraps("GenericWrapper") && !wrap.outcomeWraps("Passthrough") && !wrap.outcomeWraps("Deny") && !wrap.outcomeWraps("Ask"));
}

section("wrap: shell-syntax and bare-builtin guards");
{
  check("pipe is shell syntax", wrap.hasShellSyntax("ls | head"));
  check("quotes count as shell syntax", wrap.hasShellSyntax('echo "x"'));
  check("a bare builtin is detected", wrap.isBareShellWord("type ls"));
  check("cd is a bare builtin", wrap.isBareShellWord("cd /tmp"));
  check("a builtin with shell syntax is not bare", !wrap.isBareShellWord("cd /tmp && pwd"));
  check("time is treated as a bare builtin (no /usr/bin/time here)", wrap.isBareShellWord("time make"));
  check("an ordinary command is not a builtin", !wrap.isBareShellWord("git status"));
  check("an already-hypa command is detected", wrap.isHypaCommand("hypa git status") && wrap.isHypaCommand("/usr/local/bin/hypa -c 'x'"));
  check("a command merely containing hypa is not", !wrap.isHypaCommand("grep hypa file.txt"));
}

section("wrap: skipReason");
{
  check("disabled wins", wrap.skipReason("git status", { enabled: false }) === "disabled by config");
  check("empty command", wrap.skipReason("   ", {}) === "empty command");
  check("background job", wrap.skipReason("git status", { background: true }) === "background job (streaming output)");
  check("hypa command", wrap.skipReason("hypa git status", {}) === "already a hypa command");
  check("bare builtin names the word", wrap.skipReason("type ls", {}) === 'bare shell builtin "type"');
  check("a wrappable command has no reason", wrap.skipReason("git status", {}) === undefined);
}

section("wrap: decision cache");
{
  let clock = 0;
  const cache = wrap.createDecisionCache({ ttlMs: 100, limit: 2, now: () => clock });

  cache.set("a", "Rewritten");
  check("returns a live entry", cache.get("a") === "Rewritten");

  clock = 101;
  check("expires the entry", cache.get("a") === undefined);

  cache.set("b", "Rewritten");
  cache.set("c", "Rewritten");
  cache.set("d", "Rewritten");
  check("evicts at the limit", cache.size === 2 && cache.get("b") === undefined);
}

// ---------- decide pipeline ----------

section("decide: fail-open paths");
{
  const config = {
    enabled: true,
    hypaBin: "hypa",
    defaultTimeoutMs: 600000,
    decisionTtlMs: 60000,
    sandboxModes: ["danger-full-access"],
  };
  const warnings = [];
  let calls = 0;
  const decide = wrap.createDecider({
    config,
    logger: { warn: (message) => warnings.push(message) },
    runRewrite: async () => {
      calls += 1;

      return undefined;
    },
  });

  const missing = await decide({ command: "git status" });
  check("an unavailable rewrite does not wrap", missing.wrap === false && missing.reason === "hypa rewrite unavailable");
  check("the failed decision is not cached", calls === 1);

  const background = await decide({ command: "git status", background: true });
  check("a background job is skipped before any rewrite call", background.wrap === false && calls === 1);

  const confined = await decide({ command: "git status", sandboxMode: "workspace-write" });
  check("a confining sandbox mode skips", confined.wrap === false && confined.reason === "sandbox mode workspace-write");

  const unconfined = await decide({ command: "git status", sandboxMode: "danger-full-access" });
  check("danger-full-access is allowed to proceed to the rewrite", calls === 2 && unconfined.wrap === false);
}

section("decide: wrap, passthrough, and caching");
{
  const config = {
    enabled: true,
    hypaBin: "hypa",
    defaultTimeoutMs: 600000,
    decisionTtlMs: 60000,
    sandboxModes: ["danger-full-access"],
  };
  const seen = [];
  const outcomes = { "git status": "Rewritten", "vim foo": "Passthrough", "rm -rf /": "Deny" };
  const decide = wrap.createDecider({
    config,
    logger: { warn: () => {} },
    runRewrite: async (command) => {
      seen.push(command);

      return outcomes[command] ?? "GenericWrapper";
    },
  });

  const wrapped = await decide({ command: "git status", timeoutMs: 30000 });
  check("a Rewritten outcome wraps with the model's timeout", wrapped.wrap === true && wrapped.command === "hypa --timeout-ms 30000 -c 'git status'");

  const generic = await decide({ command: "ls -la | head" });
  check("a GenericWrapper outcome uses the configured default timeout", generic.wrap === true && generic.command === "hypa --timeout-ms 600000 -c 'ls -la | head'");

  await decide({ command: "git status", timeoutMs: 30000 });
  check("a repeated command hits the cache", seen.filter((command) => command === "git status").length === 1);

  const passthrough = await decide({ command: "vim foo" });
  check("Passthrough runs the original", passthrough.wrap === false && passthrough.reason === "hypa outcome Passthrough");

  const denied = await decide({ command: "rm -rf /" });
  check("Deny runs the original (compression is not a policy layer)", denied.wrap === false && denied.reason === "hypa outcome Deny");
}

// ---------- plugin wiring with a stub binary ----------

const stubDir = mkdtempSync(join(tmpdir(), "hypa-stub-"));
const stubLog = join(stubDir, "calls.log");
const stubBin = join(stubDir, "hypa");

writeFileSync(
  stubBin,
  [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> ${JSON.stringify(stubLog)}`,
    'case "$3" in',
    "  vim*) printf '%s\\n' '{\"input\":\"vim foo\",\"outcome\":\"Passthrough\",\"command\":\"vim foo\"}'; exit 1 ;;",
    "  boom*) exit 9 ;;",
    "  *) printf '%s\\n' '{\"input\":\"x\",\"outcome\":\"GenericWrapper\",\"command\":\"hypa -c \\\"x\\\"\"}' ;;",
    "esac",
    "",
  ].join("\n"),
);
chmodSync(stubBin, 0o755);

const stubCalls = () => {
  try {
    return readFileSync(stubLog, "utf8").trim().split("\n").filter((line) => line.length > 0);
  } catch {
    return [];
  }
};

function makeCapture() {
  const sections = [];
  const handlers = new Map();
  let policy;

  const ctx = {
    logger: { warn: () => {} },
    get(serviceName) {
      if (serviceName === "agents") return { get: () => undefined };
      if (serviceName === "sandboxPolicy") return policy;

      throw new Error(`unexpected service get: ${serviceName}`);
    },
    setSandboxPolicy(next) {
      policy = next;
    },
    tools: { get: () => undefined },
    systemPrompt: { section: (entry) => sections.push(entry) },
    on: (eventName, handler) => handlers.set(eventName, handler),
  };

  return { ctx, sections, handlers };
}

function makeAgent(sessionId, base) {
  const registrations = [];
  let disposed = 0;

  const agent = {
    session: { id: sessionId, header: { cwd: stubDir } },
    ctx: {
      tools: {
        register(definition) {
          registrations.push(definition);

          return () => {
            disposed += 1;
          };
        },
        get: () => base,
      },
    },
  };

  return { agent, registrations, disposedCounts: () => disposed };
}

section("plugin: apply registers the note and the lifecycle hooks");
{
  const host = await import(`${INSTALLED_PLUGIN_DIR}/lib/index.js`);
  check("exports the registrar shape", typeof host.apply === "function" && Array.isArray(host.inject) && host.inject.includes("tools") && host.inject.includes("systemPrompt") && host.name === "dsh-plugin-hypa");

  const captured = makeCapture();
  host.apply(captured.ctx, { hypaBin: stubBin });
  check("registers the compression note", captured.sections.some((entry) => entry.name === "hypa:compression" && entry.text.includes("[hypa:")));
  check("hooks the lifecycle events", captured.handlers.has("agent/session-start") && captured.handlers.has("session/created") && captured.handlers.has("session/event") && captured.handlers.has("session/disposed"));

  const disabled = makeCapture();
  host.apply(disabled.ctx, { enabled: false });
  check("a disabled plugin registers nothing", disabled.sections.length === 0 && disabled.handlers.size === 0);
}

section("plugin: the shadow keeps the wire schema and rewrites the executed command");
{
  const host = await import(`${INSTALLED_PLUGIN_DIR}/lib/index.js`);
  const captured = makeCapture();
  const executed = [];
  const base = {
    name: "bash",
    description: "Execute a bash command.",
    parameters: { command: { type: "string", required: true } },
    output: { schema: { type: "string" }, render: () => [] },
    presentCall: () => ({ card: "terminal" }),
    execute: async (args) => {
      executed.push(args.command);

      return "ok";
    },
  };

  captured.ctx.tools.get = (toolName) => (toolName === "bash" ? base : undefined);
  host.apply(captured.ctx, { hypaBin: stubBin, defaultTimeoutMs: 600000, sandboxModes: ["danger-full-access"] });

  const world = makeAgent("session-1", base);
  captured.handlers.get("agent/session-start")({ agent: world.agent });

  check("registers one shadow named bash", world.registrations.length === 1 && world.registrations[0].name === "bash");
  const shadow = world.registrations[0];
  check("keeps the schema and the presentation callbacks", shadow.description === base.description && shadow.parameters === base.parameters && shadow.output === base.output && shadow.presentCall === base.presentCall);
  check("replaces execute", shadow.execute !== base.execute);

  const exec = { agent: world.agent };

  await shadow.execute({ command: "git status", description: "Show status" }, exec);
  check("runs the hypa-wrapped command", executed.at(-1) === `${stubBin} --timeout-ms 600000 -c 'git status'`);

  await shadow.execute({ command: "git status", description: "Show status", timeoutMs: 45000 }, exec);
  check("the model's timeout reaches hypa", executed.at(-1) === `${stubBin} --timeout-ms 45000 -c 'git status'`);

  const beforePassthrough = stubCalls().length;
  await shadow.execute({ command: "vim foo", description: "Edit" }, exec);
  check("a Passthrough decision runs the original", executed.at(-1) === "vim foo" && stubCalls().length === beforePassthrough + 1);

  const beforeSkip = stubCalls().length;
  await shadow.execute({ command: "type ls", description: "Inspect" }, exec);
  check("a bare builtin never reaches hypa", executed.at(-1) === "type ls" && stubCalls().length === beforeSkip);

  await shadow.execute({ command: "hypa git status", description: "Already wrapped" }, exec);
  check("an existing hypa command is not wrapped twice", executed.at(-1) === "hypa git status" && stubCalls().length === beforeSkip);

  await shadow.execute({ command: "git status", description: "Background", run_in_background: true }, exec);
  check("a background job runs the original", executed.at(-1) === "git status" && stubCalls().length === beforeSkip);

  const beforeCache = stubCalls().length;
  await shadow.execute({ command: "ls -la", description: "List" }, exec);
  await shadow.execute({ command: "ls -la", description: "List" }, exec);
  check("the second identical command is served from the decision cache", stubCalls().length === beforeCache + 1 && executed.at(-1) === `${stubBin} --timeout-ms 600000 -c 'ls -la'`);

  const beforeConfined = stubCalls().length;
  captured.ctx.setSandboxPolicy({ resolve: () => ({ mode: "workspace-write" }) });
  await shadow.execute({ command: "git diff", description: "Diff" }, exec);
  check("a confining sandbox mode runs the original", executed.at(-1) === "git diff" && stubCalls().length === beforeConfined);

  captured.ctx.setSandboxPolicy({ resolve: () => ({ mode: "danger-full-access" }) });

  const beforeBoom = stubCalls().length;
  await shadow.execute({ command: "boom now", description: "Fails" }, exec);
  check("a failing rewrite runs the original", executed.at(-1) === "boom now" && stubCalls().length === beforeBoom + 1);
}

section("plugin: resume re-shadows the new agent and disposes the stale registration");
{
  const host = await import(`${INSTALLED_PLUGIN_DIR}/lib/index.js`);
  const captured = makeCapture();
  const base = { name: "bash", description: "Execute a bash command.", parameters: {}, output: { schema: { type: "string" }, render: () => [] }, execute: async () => "ok" };

  captured.ctx.tools.get = (toolName) => (toolName === "bash" ? base : undefined);
  host.apply(captured.ctx, { hypaBin: stubBin });

  const first = makeAgent("session-2", base);
  captured.handlers.get("agent/session-start")({ agent: first.agent });
  check("the first agent is shadowed", first.registrations.length === 1);

  captured.handlers.get("agent/session-start")({ agent: first.agent });
  check("the same agent is not shadowed twice", first.registrations.length === 1);

  const resumed = makeAgent("session-2", base);
  captured.handlers.get("agent/session-start")({ agent: resumed.agent });
  check("a resumed agent gets its own shadow", resumed.registrations.length === 1);
  check("the stale registration is disposed", first.disposedCounts() === 1);

  captured.handlers.get("session/disposed")({ id: "session-2" });
  check("disposal releases the live shadow", resumed.disposedCounts() === 1);
}

section("plugin: a missing binary fails open");
{
  const host = await import(`${INSTALLED_PLUGIN_DIR}/lib/index.js`);
  const captured = makeCapture();
  const executed = [];
  const base = { name: "bash", description: "Execute a bash command.", parameters: {}, output: { schema: { type: "string" }, render: () => [] }, execute: async (args) => (executed.push(args.command), "ok") };

  captured.ctx.tools.get = (toolName) => (toolName === "bash" ? base : undefined);
  host.apply(captured.ctx, { hypaBin: join(stubDir, "does-not-exist") });

  const world = makeAgent("session-3", base);
  captured.handlers.get("agent/session-start")({ agent: world.agent });

  await world.registrations[0].execute({ command: "git status", description: "Show status" }, { agent: world.agent });
  check("the original command runs when hypa is absent", executed.at(-1) === "git status");
}

section("plugin: the installed copy matches the workspace source");
{
  const workspace = readFileSync(`${PLUGIN_DIR}/lib/index.js`, "utf8");
  const installed = readFileSync(`${INSTALLED_PLUGIN_DIR}/lib/index.js`, "utf8");

  check("index.js is mirrored", workspace === installed);
  check("wrap.js is mirrored", readFileSync(`${PLUGIN_DIR}/lib/wrap.js`, "utf8") === readFileSync(`${INSTALLED_PLUGIN_DIR}/lib/wrap.js`, "utf8"));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}

console.log("\nall checks passed");

/**
 * Smoke test for dsh-plugin-usage (core collection + host routes with stubs).
 * Run: node tests/dsh-usage-smoke.mjs (from the repo root)
 *
 * The facts under test: session logs carry exact per-request usage on
 * `assistant/message` events (inputTokens = uncached input, cacheRead /
 * cacheWrite, totalTokens = input + cacheRead + output), the assembled
 * request material on `request/header` (system prompt, tool definitions),
 * and the conversation on message events. The collector must reproduce the
 * exact aggregates, flag prefix rewrites, and produce an estimated
 * composition whose normalized shares sum to the last request's exact total.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = fileURLToPath(new URL("../plugins/dsh-plugin-usage/", import.meta.url));
const INSTALLED_PLUGIN_DIR = "/home/mon3tr/.dsh/profiles/node_modules/dsh-plugin-usage";
const TEST_HOME = "/home/mon3tr/dsh-plugin-usage-test-home";
process.env.DSH_HOME = TEST_HOME;
rmSync(TEST_HOME, { recursive: true, force: true });
mkdirSync(TEST_HOME, { recursive: true });

const collect = await import(`${PLUGIN_DIR}/lib/collect.js`);
const host = await import(`${INSTALLED_PLUGIN_DIR}/lib/index.js`);

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  ok: ${label}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL: ${label}`);
}

// ---------- synthetic session log ----------
const SYSTEM_TEXT = "You are a coding agent. ".repeat(40); // 600 chars
const TOOL_A = { name: "read_file", description: "Read a file from disk. ".repeat(10), parameters: { type: "object", properties: { path: { type: "string" } } } };
const TOOL_B = { name: "bash", description: "Run a shell command. ".repeat(12), parameters: { type: "object", properties: { cmd: { type: "string" } } } };

const USER_TEXT = "你好，请帮我统计 token 消耗。".repeat(4); // CJK-heavy user message
const SPLICE_TEXT = "injected memory row for the estimate";
const ASSISTANT_TEXT = "I will analyze the request now.";
const TOOL_TEXT = "AGENTS.md\ndocs\nplugins\nprofile\ntests\n";

function usageRow(seq, time, turn, step, usage, modelNote) {
  return JSON.stringify({ type: "assistant/message", seq, time, data: { turn, step, usage, ...(modelNote === undefined ? {} : { model: modelNote }) } });
}

const lines = [
  JSON.stringify({ type: "session", version: 0, id: "session-aaaa1111-2222-4333-8444-555566667777", createdAt: 1700000000000, cwd: "/tmp/dsh-usage-proj", delegationDepth: 0, agentPreset: "context-compact" }),
  JSON.stringify({ type: "sandbox/mode", seq: 1, time: 1700000000001, data: { mode: "danger-full-access" } }),
  JSON.stringify({ type: "request/header", seq: 2, time: 1700000000010, data: { reason: "initial", header: JSON.stringify({ config: { provider: "zai", model: "glm-5.3-flash", reasoningEffort: "high" }, system: SYSTEM_TEXT, tools: [TOOL_A, TOOL_B] }) } }),
  JSON.stringify({ type: "request/context", seq: 3, time: 1700000000011, data: { provider: "zai", model: "glm-5.3-flash", contextWindow: 272000 } }),
  // A spliced user-source message with the same id as its later surface row:
  // counting must dedupe by id, not double count.
  JSON.stringify({ type: "agent/inbox/spliced", seq: 4, time: 1700000000020, data: { target: "next-turn", start: 0, inserted: [{ content: [{ type: "text", text: SPLICE_TEXT }], source: { kind: "plugin" }, role: "user", id: "m-splice-1" }] } }),
  JSON.stringify({ type: "user/message", seq: 5, time: 1700000000030, data: { content: [{ type: "text", text: USER_TEXT }], source: { kind: "user" }, role: "user", id: "m-user-1" } }),
  JSON.stringify({ type: "assistant/message", seq: 6, time: 1700000000050, data: { message: { role: "assistant", source: { kind: "model" }, id: "m-assist-1", content: [{ type: "text", text: ASSISTANT_TEXT }] } } }),
  // Request 1: no cache yet, the full prefix bills as input.
  usageRow(7, 1700000000100, 1, 1, { inputTokens: 3000, outputTokens: 300, totalTokens: 3300 }),
  JSON.stringify({ type: "tool/result", seq: 8, time: 1700000000200, data: { turn: 1, step: 1, message: { source: { kind: "tool", callId: "call_1" }, role: "user", id: "m-tool-1", content: [{ type: "tool-result", toolCallId: "call_1", content: [{ type: "text", text: TOOL_TEXT }] }] } } }),
  // Request 2: cache hit.
  usageRow(9, 1700000000300, 1, 2, { inputTokens: 200, outputTokens: 100, totalTokens: 3700, cacheReadTokens: 3400 }),
  // Request 3: full prefix rewrite (no cache read on a later request).
  usageRow(10, 1700000000400, 1, 3, { inputTokens: 3700, outputTokens: 50, totalTokens: 3950, cacheReadTokens: 0 }),
];

function writeLog(path, rows) {
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, rows.join("\n") + "\n");
  execFileSync("zstd", ["-q", "-3", "-f", "-o", path, tmp]);
  rmSync(tmp, { force: true });
}

// ---------- core collection ----------
console.log("core collection");
const parsed = collect.parseLog(lines.join("\n") + "\n");
check("header parsed", parsed.header?.id === "session-aaaa1111-2222-4333-8444-555566667777");
const usage = collect.collectUsage(parsed.rows, parsed.header);

check("three requests found", usage.requests.length === 3);
check("exact input sum", usage.totals.inputTokens === 3000 + 200 + 3700);
check("exact cache-read sum", usage.totals.cacheReadTokens === 3400);
check("exact output sum", usage.totals.outputTokens === 300 + 100 + 50);
check("exact context sum", usage.totals.totalTokens === 3300 + 3700 + 3950);
check("billed input includes cache reads", usage.totals.billedInputTokens === 6900 + 3400);
check("cache hit rate", Math.abs(usage.totals.cacheHitRate - 3400 / 10300) < 1e-9);
check("first request never counts as a rewrite", usage.requests[0].rewrite === null);
check("full rewrite flagged on the cacheless third request", usage.requests[2].rewrite === "full");
check("model resolved from request/header", usage.models.join(",") === "glm-5.3-flash");
check("provider resolved", usage.provider === "zai");
check("context window resolved", usage.contextWindow === 272000);
check("last context size", usage.lastTotalTokens === 3950);
check("turn rollup", usage.turns.length === 1 && usage.turns[0].requests === 3);

const raw = usage.compositionRaw;
check("system chars from request/header", raw.chars.system === SYSTEM_TEXT.length);
check("tool chars from tool definitions", raw.chars.tools === JSON.stringify(TOOL_A).length + JSON.stringify(TOOL_B).length);
check("user message counted", raw.chars.user === USER_TEXT.length);
check("spliced plugin message lands under memory, once", raw.chars.memory === SPLICE_TEXT.length);
check("tool result counted under tool despite envelope role", raw.chars.tool === TOOL_TEXT.length);
check("assistant message counted", raw.chars.assistant === ASSISTANT_TEXT.length);
check("composition anchored to the exact last total", usage.composition !== null && Object.values(usage.composition).reduce((sum, entry) => sum + entry.tokens, 0) === usage.lastTotalTokens);
check("composition shares sum to one", Math.abs(Object.values(usage.composition).reduce((sum, entry) => sum + entry.share, 0) - 1) < 1e-9);

check("estimateTokens ascii", Math.abs(collect.estimateTokens("a".repeat(380)) - 100) <= 1);
check("estimateTokens cjk", Math.abs(collect.estimateTokens("汉".repeat(100)) - 85) <= 1);

// ---------- host routes with stubs ----------
console.log("host routes");
{
  const cwd = "/tmp/dsh-usage-proj";
  const sessionId = "session-aaaa1111-2222-4333-8444-555566667777";
  const projectDir = `${TEST_HOME}/sessions/--tmp-dsh-usage-proj--`;
  writeLog(`${projectDir}/${sessionId}/session.jsonl.zstd`, lines);

  const registered = [];
  const ctx = {
    inject(_, fn) {
      const httpCtx = { webServer: { register: (route) => { registered.push(route); return () => {}; } }, effect: (factory) => factory() };
      fn(httpCtx);
    }
  };
  host.apply(ctx);
  check("two routes registered", registered.length === 2);
  const route = (path) => registered.find((r) => r.path === path).handler;

  const respond = async (handler, req) => {
    const res = {
      statusCode: 0,
      headers: null,
      body: "",
      writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
      end(body) { if (body !== undefined) this.body += body; }
    };
    await handler(req, res);
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
  const jsonRequest = (url) => ({ method: "GET", url });

  const overview = await respond(route("/usage/overview"), jsonRequest(`/usage/overview?cwd=${encodeURIComponent(cwd)}`));
  check("overview finds the session", overview.status === 200 && overview.body.ok && overview.body.sessions.length === 1);
  const row = overview.body.sessions[0];
  check("overview carries exact totals", row.totalTokens === 10950 && row.requests === 3 && row.inputTokens === 6900);
  check("overview carries context facts", row.lastTotalTokens === 3950 && row.contextWindow === 272000);
  check("overview narrows by cwd", row.cwd === cwd || row.projectDir === "--tmp-dsh-usage-proj--");

  const other = await respond(route("/usage/overview"), jsonRequest("/usage/overview?cwd=/tmp/other-proj"));
  check("overview omits other workspaces", other.body.sessions.length === 0);
  const all = await respond(route("/usage/overview"), jsonRequest("/usage/overview"));
  check("overview without cwd scans everywhere", all.body.sessions.length === 1);

  const detail = await respond(route("/usage/session"), jsonRequest(`/usage/session?id=${sessionId}&cwd=${encodeURIComponent(cwd)}`));
  check("session detail resolves", detail.status === 200 && detail.body.ok);
  check("session detail has exact requests", detail.body.requests.length === 3 && detail.body.requests[2].rewrite === "full");
  check("session detail has composition", detail.body.composition !== null && detail.body.composition.tool.chars === TOOL_TEXT.length);
  check("session detail has no logs-only fields in overview", existsSync(detail.body.path));

  const unknown = await respond(route("/usage/session"), jsonRequest("/usage/session?id=session-does-not-exist-0001"));
  check("unknown session 404s", unknown.status === 404);

  const bad = await respond(route("/usage/session"), jsonRequest("/usage/session?id=../etc/passwd"));
  check("path traversal rejected", bad.status === 404);
}

// ---------- client contract ----------
console.log("client contract");
{
  const source = readFileSync(`${PLUGIN_DIR}/lib/client.js`, "utf8");
  check("client registers under its module id", source.includes('id: "dsh-plugin-usage"'));
  check("client targets the session header utilities slot", source.includes("conversation.session.header.utilities"));
  check("client fetches the session route", source.includes("`/usage/${path}?${query}`") || source.includes("/usage/"));
  check("client fetches the overview route", source.includes('"overview"'));
  check("client registers locale", source.includes("ctx.locale.register"));
  check("panel paints the layer-1 alias, never the wallpaper-forced base", source.includes("--dsw-alias-bg-layer-1") && !source.includes("--dsw-alias-bg-base"));
  check("panel carries the estimate disclaimer", source.includes("estimateNote"));
  check("panel polls while open", source.includes("15_000"));
}

rmSync(TEST_HOME, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");

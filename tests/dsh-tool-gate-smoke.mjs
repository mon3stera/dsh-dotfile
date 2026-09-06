/**
 * Smoke test for dsh-plugin-tool-gate (pure gate math + plugin wiring with
 * stubs). Run: node tests/dsh-tool-gate-smoke.mjs (from the repo root)
 *
 * The facts under test: the default hidden set matches this deployment's
 * heavy tools, configured names are pre-filtered against the agent's
 * restrictable set (registry restrictions throw on unknown names), the
 * catalog renders curated summaries with a first-sentence fallback and the
 * expand contract, one expand call frees exactly the requested names and
 * re-restricts the rest (empty deny must not re-restrict), expansion is
 * per-agent (resume re-gates the new agent object and disposes the stale
 * restriction), and a disabled gate registers nothing.
 */
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = fileURLToPath(new URL("../plugins/dsh-plugin-tool-gate/", import.meta.url));
const INSTALLED_PLUGIN_DIR = "/home/mon3tr/.dsh/profiles/node_modules/dsh-plugin-tool-gate";

const gate = await import(`${PLUGIN_DIR}/lib/gate.js`);
const summaries = await import(`${PLUGIN_DIR}/lib/summaries.js`);

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

// ---------- pure gate math ----------

section("gate: normalizeHidden");
{
  const out = gate.normalizeHidden([" workflow ", "", "workflow", "subagent", null, 42]);
  check("trims, drops empties and duplicates", JSON.stringify(out) === JSON.stringify(["workflow", "subagent"]));
  check("empty input yields empty list", gate.normalizeHidden(undefined).length === 0);
}

section("gate: firstSentence");
{
  check("takes the first sentence", gate.firstSentence("Drive the pointer. Also more.") === "Drive the pointer.");
  check("keeps text without terminators", gate.firstSentence("no terminator here") === "no terminator here");
  check("collapses whitespace", gate.firstSentence("a\n\nb. c") === "a b.");
  check("caps runaway sentences", gate.firstSentence("x".repeat(300)).length === 160);
  check("empty description yields empty string", gate.firstSentence(undefined) === "");
}

section("gate: visibleDeny");
{
  const restrictable = new Set(["workflow", "subagent", "read"]);
  const { deny, skipped } = gate.visibleDeny(["workflow", "desktop_mouse", "subagent"], restrictable);
  check("keeps restrictable names in order", JSON.stringify(deny) === JSON.stringify(["workflow", "subagent"]));
  check("reports unknown names as skipped", JSON.stringify(skipped) === JSON.stringify(["desktop_mouse"]));
}

section("gate: expandTransition");
{
  const entry = { denied: new Set(["workflow", "subagent", "ralph"]), catalogNames: new Set(["workflow", "subagent", "ralph"]) };
  const requested = gate.normalizeHidden(["workflow", "workflow", "ralph", "bogus", " desktop_key "]);
  const t = gate.expandTransition(entry, requested);
  check("frees exactly the denied requested names", t.freed.length === 2 && t.freed.includes("workflow") && t.freed.includes("ralph"));
  check("classifies never-gated names as unknown", JSON.stringify(t.unknown) === JSON.stringify(["bogus", "desktop_key"]));
  check("next deny drops only the freed names", t.nextDenied.size === 1 && t.nextDenied.has("subagent"));

  const t2 = gate.expandTransition({ denied: new Set(), catalogNames: new Set(["workflow"]) }, ["workflow"]);
  check("a freed-everything call reports alreadyLoaded and empty next deny", t2.alreadyLoaded.length === 1 && t2.nextDenied.size === 0);
}

section("gate: catalogText");
{
  const text = gate.catalogText([
    { name: "workflow", summary: summaries.SUMMARIES.workflow },
    { name: "desktop_mouse", summary: summaries.SUMMARIES.desktop_mouse },
  ], "tool_expand");
  check("names every gated tool", text.includes("- workflow -") && text.includes("- desktop_mouse -"));
  check("carries the expand contract and the loader name", text.includes("tool_expand") && text.includes("unknown tool"));
  check("empty catalog renders a headerless minimal text", gate.catalogText([], "tool_expand").includes("Progressive tool loading"));
}

// ---------- plugin wiring with stubs ----------

section("plugin: apply registers the loader and the catalog section");
const host = await import(`${INSTALLED_PLUGIN_DIR}/lib/index.js`);
{
  check("exports the registrar shape", typeof host.apply === "function" && Array.isArray(host.inject) && host.inject.includes("tools") && host.inject.includes("systemPrompt") && host.name === "dsh-plugin-tool-gate");

  const captured = makeCapture();
  host.apply(captured.ctx, {});
  check("registers exactly one tool", captured.tools.length === 1 && captured.tools[0].name === "tool_expand");
  check("loader has an agent-scoped execute and a string array parameter", typeof captured.tools[0].execute === "function" && captured.tools[0].parameters.properties.tools.items.type === "string");
  check("registers the catalog section", captured.sections.some((s) => s.name === "tool-gate:catalog"));
  check("catalog section text starts empty", captured.sections.find((s) => s.name === "tool-gate:catalog").text() === "");
  check("hooks the three lifecycle events plus disposal", captured.handlers.has("agent/session-start") && captured.handlers.has("session/created") && captured.handlers.has("session/event") && captured.handlers.has("session/disposed"));
}

function makeCapture() {
  const tools = [];
  const sections = [];
  const handlers = new Map();

  const ctx = {
    logger: { warn: () => {} },
    get(name) {
      if (name !== "agents") throw new Error(`unexpected service get: ${name}`);

      return ctx.agentsService;
    },
    agentsService: { get: () => undefined },
    tools: { register: (tool) => tools.push(tool) },
    systemPrompt: { section: (section_) => sections.push(section_) },
    on: (eventName, handler) => handlers.set(eventName, handler),
  };

  return { ctx, tools, sections, handlers };
}

function makeAgent(sessionId, options = {}) {
  const viewCalls = [];
  const restrictions = [];
  let disposed = 0;

  const visible = new Map(options.visible ?? [
    ["read", { name: "read", description: "Read a file." }],
    ["workflow", { name: "workflow", description: "Run a workflow script. Long description follows." }],
    ["subagent", { name: "subagent", description: "Delegate a task." }],
  ]);

  const agentTools = {
    view(scope) {
      viewCalls.push(scope);

      return {
        visible,
        restrictableNames: options.restrictable ?? new Set([...visible.keys(), "tool_expand"]),
      };
    },
    restrict({ deny }) {
      restrictions.push([...deny]);

      return () => {
        disposed += 1;
      };
    },
  };

  const agent = {
    session: { id: sessionId },
    ctx: { tools: agentTools },
  };

  return { agent, restrictions, disposedCounts: () => disposed, viewCalls, visible };
}

section("plugin: agent/session-start gates the agent and fills the catalog");
{
  const captured = makeCapture();
  host.apply(captured.ctx, {});
  const world = makeAgent("session-1");
  captured.ctx.agentsService = { get: () => world.agent };

  captured.handlers.get("agent/session-start")({ agent: world.agent });

  check("restricts the intersection of defaults with the agent view", world.restrictions.length === 1 && world.restrictions[0].includes("workflow") && world.restrictions[0].includes("subagent") && !world.restrictions[0].includes("read"));
  check("the view is read with the agent scope", world.viewCalls.every((scope) => scope === world.agent));
  const catalog = captured.sections.find((s) => s.name === "tool-gate:catalog").text();
  check("catalog lists gated tools with curated summaries", catalog.includes("- workflow - Run a JavaScript workflow script") && catalog.includes("- subagent - Delegate one self-contained task"));
  check("catalog omits non-gated tools", !catalog.includes("read"));
  check("gate is idempotent for the same agent", (captured.handlers.get("agent/session-start")({ agent: world.agent }), world.restrictions.length === 1));
}

section("plugin: summary falls back to the tool description");
{
  const captured = makeCapture();
  host.apply(captured.ctx, { hidden: ["mystery_tool"] });
  const visible = new Map([
    ["read", { name: "read", description: "Read a file." }],
    ["mystery_tool", { name: "mystery_tool", description: "Does one thing. Then another." }],
  ]);
  const world = makeAgent("session-2", { visible });
  captured.ctx.agentsService = { get: () => world.agent };

  captured.handlers.get("agent/session-start")({ agent: world.agent });

  const catalog = captured.sections.find((s) => s.name === "tool-gate:catalog").text();
  check("fallback uses the first sentence of the description", catalog.includes("- mystery_tool - Does one thing."));
}

section("plugin: unknown configured names are skipped, known ones still gate");
{
  const captured = makeCapture();
  host.apply(captured.ctx, { hidden: ["workflow", "not_a_tool"] });
  const world = makeAgent("session-3");
  captured.ctx.agentsService = { get: () => world.agent };

  captured.handlers.get("agent/session-start")({ agent: world.agent });

  check("only the known name is denied", world.restrictions.length === 1 && JSON.stringify(world.restrictions[0]) === JSON.stringify(["workflow"]));
}

section("plugin: tool_expand transitions");
{
  const captured = makeCapture();
  host.apply(captured.ctx, {});
  const world = makeAgent("session-4");
  captured.ctx.agentsService = { get: () => world.agent };
  captured.handlers.get("agent/session-start")({ agent: world.agent });
  const expand = captured.tools[0];

  const first = await expand.execute({ tools: ["workflow", "bogus"] }, { agent: world.agent });
  check("first expand frees the requested tool", first.result.includes("Now available from your next step: workflow") && first.result.includes("Not gated tools (ignored): bogus"));
  check("the stale restriction was disposed and a reduced one applied", world.disposedCounts() === 1 && world.restrictions.length === 2 && JSON.stringify(world.restrictions[1]) === JSON.stringify(["subagent"]));

  const second = await expand.execute({ tools: ["workflow"] }, { agent: world.agent });
  check("re-expanding reports already loaded without touching the restriction", second.result.includes("Already loaded: workflow") && world.restrictions.length === 2 && world.disposedCounts() === 1);

  const third = await expand.execute({ tools: ["subagent"] }, { agent: world.agent });
  check("freeing the last tool disposes without re-restricting", third.result.includes("0 tool(s) remain gated") && world.disposedCounts() === 2 && world.restrictions.length === 2);

  const fourth = await expand.execute({ tools: ["desktop_mouse"] }, { agent: world.agent });
  check("an all-unknown call answers with guidance", fourth.result.includes("No gated tools matched"));
}

section("plugin: expand without a gate state fails open");
{
  const captured = makeCapture();
  host.apply(captured.ctx, {});
  const expand = captured.tools[0];
  const world = makeAgent("session-5");
  captured.ctx.agentsService = { get: () => undefined };

  const result = await expand.execute({ tools: ["workflow"] }, { agent: world.agent });
  check("reports that everything is already declared", result.result.includes("every tool should already be declared") && world.restrictions.length === 0);
}

section("plugin: resume re-gates the new agent object");
{
  const captured = makeCapture();
  host.apply(captured.ctx, {});
  const first = makeAgent("session-6");
  captured.ctx.agentsService = { get: () => first.agent };
  captured.handlers.get("session/created")({ id: "session-6" });
  check("session/created gates when the agent is live", first.restrictions.length === 1);

  const second = makeAgent("session-6");
  captured.ctx.agentsService = { get: () => second.agent };

  captured.handlers.get("session/event")({ id: "session-6" }, { type: "turn/start" });

  check("the stale agent's restriction was disposed", first.disposedCounts() === 1);
  check("the resumed agent is gated fresh", second.restrictions.length === 1 && second.restrictions[0].includes("workflow"));
  check("same-agent event handling stays idempotent", (captured.handlers.get("session/event")({ id: "session-6" }, { type: "user/message" }), second.restrictions.length === 1));
}

section("plugin: disposal on session end");
{
  const captured = makeCapture();
  host.apply(captured.ctx, {});
  const world = makeAgent("session-7");
  captured.ctx.agentsService = { get: () => world.agent };

  captured.handlers.get("agent/session-start")({ agent: world.agent });
  captured.handlers.get("session/disposed")({ id: "session-7" });

  check("the restriction disposer ran at disposal", world.disposedCounts() === 1);

  captured.ctx.agentsService = { get: () => undefined };

  const afterDisposal = await captured.tools[0].execute({ tools: ["workflow"] }, { agent: world.agent });
  check("a later expand on the disposed session fails open", afterDisposal.result.includes("already be declared"));
}

section("plugin: disabled gate registers nothing");
{
  const captured = makeCapture();
  host.apply(captured.ctx, { enabled: false });
  check("no tools, sections, or handlers", captured.tools.length === 0 && captured.sections.length === 0 && captured.handlers.size === 0);

  const captured2 = makeCapture();
  host.apply(captured2.ctx, { hidden: ["  "] });
  check("an empty hidden list also disables the gate", captured2.tools.length === 0);
}

// ---------- verdict ----------

console.log(failures === 0 ? "\nAll tool-gate smoke checks passed." : `\n${failures} check(s) FAILED.`);

if (failures > 0) process.exit(1);

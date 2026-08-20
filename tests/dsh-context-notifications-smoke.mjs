// Human-facing context rows must ride the command lifecycle (model-invisible,
// no agent-inbox traffic); only deliberately model-facing content may use the
// durable plugin context-message contract.
import { readFile } from "node:fs/promises";
import {
	createContextNotice,
	mintActivityId,
	recordActivity,
	settleActivity,
	startActivity,
} from "/home/mon3tr/.dsh/profiles/node_modules/dsh-magic-context/lib/notifications.js";

let failed = 0;
const check = (label, ok) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
	if (!ok) failed += 1;
};

/** Session double recording every append, plus an inject trap that must stay unused. */
function fakeSession() {
	const events = [];
	return {
		events,
		append(type, data, opts) {
			events.push({ type, data, opts });
			return { type, data, seq: events.length - 1 };
		},
	};
}

// --- activity rows -----------------------------------------------------------

const session = fakeSession();
const runningId = startActivity(session, "Context: compartment generation 7");
check("start appends command/run", session.events.length === 1 && session.events[0].type === "command/run");
check("start returns the pairing id", typeof runningId === "string" && runningId.length > 0);
check("run carries the row title as name", session.events[0].data.name === "Context: compartment generation 7");
check("run declares the plugin as source", session.events[0].data.source.kind === "plugin" && session.events[0].data.source.plugin === "dsh-magic-context");
check("run has no surface marker", session.events[0].opts === undefined);
check("run alone leaves the row running (no done event)", session.events.filter((event) => event.type === "command/done").length === 0);

check("settle appends command/done", settleActivity(session, runningId, "success", "Captured range: 10-20.") === true);
check("done pairs by commandId", session.events[1].data.commandId === runningId);
check("done carries the outcome kind", session.events[1].data.kind === "success");
check("done carries the outcome text", session.events[1].data.text === "Captured range: 10-20.");

const errorSession = fakeSession();
const errorId = startActivity(errorSession, "Context: Dreamer maintenance pass");
settleActivity(errorSession, errorId, "error", "  Rate limit exceeded: tpm (InputTokens)  ");
check("error outcome renders as failed", errorSession.events[1].data.kind === "error");
check("outcome text is trimmed", errorSession.events[1].data.text === "Rate limit exceeded: tpm (InputTokens)");

const oneShot = fakeSession();
check("recordActivity writes a settled pair", recordActivity(oneShot, "Context: project memory injection", "Injected 3 project memories.") === true);
check("settled pair is run then done", oneShot.events.map((event) => event.type).join(",") === "command/run,command/done");
check("recordActivity defaults to success", oneShot.events[1].data.kind === "success");
check("recordActivity forwards an error kind", recordActivity(fakeSession(), "t", "boom", "error") === true);

// --- boundaries and refusals -------------------------------------------------

const empty = fakeSession();
startActivity(empty, "t");
settleActivity(empty, empty.events[0].data.commandId, "success", "   ");
check("empty outcome text is dropped", empty.events[1].data.text === undefined);

const long = fakeSession();
startActivity(long, "t");
settleActivity(long, long.events[0].data.commandId, "success", "x".repeat(9000));
check("outcome text is bounded", long.events[1].data.text.length === 4000 && long.events[1].data.text.endsWith("..."));

check("missing session is harmless", startActivity(undefined, "t") === undefined);
check("missing session settles nothing", settleActivity(undefined, "id", "success", "t") === false);
check("unknown activity id settles nothing", settleActivity(fakeSession(), undefined, "success", "t") === false);

let threw = false;
try { startActivity(fakeSession(), "   "); } catch { threw = true; }
check("blank title is rejected", threw);

threw = false;
try { settleActivity(fakeSession(), "id", "done", "t"); } catch { threw = true; }
check("unknown outcome kind is rejected", threw);

check("ids are unique", mintActivityId() !== mintActivityId());
check("ids are namespaced away from real commands", mintActivityId().startsWith("dsh-magic-context/"));

const eventTypes = new Set([...session.events, ...errorSession.events, ...oneShot.events].map((event) => event.type));
check("rows never append a surface-eligible event", !eventTypes.has("user/message") && !eventTypes.has("assistant/message") && !eventTypes.has("tool/result"));

// --- model-facing content keeps the durable contract -------------------------

// Contract guard: only deliberately model-facing content may enter the agent
// inbox, because agent.inject() lands at "next-step" and the agent loop refuses
// to end a turn while nextStep is non-empty. Status reporting from the engine
// would therefore buy one extra whole-context LLM request per row.
const engineSource = await readFile("/home/mon3tr/.dsh/profiles/node_modules/dsh-magic-context/lib/engine.js", "utf8");
check("engine never injects into the agent inbox", !/\.inject\(/.test(engineSource));
const commandSource = await readFile("/home/mon3tr/.dsh/profiles/node_modules/dsh-magic-context/lib/commands.js", "utf8");
check("inject-memory still delivers memories to the model", /agent\.inject\(createContextNotice\(/.test(commandSource));

const notice = createContextNotice("  Inject Memory: 2 project memories  ", "Injected two project memories into the next model request.");
check("notice has user message shape", notice.role === "user" && notice.content[0]?.type === "text");
check("notice uses plugin source", notice.source.kind === "plugin" && notice.source.plugin === "dsh-magic-context");
check("notice uses context notice form", notice.source.form === "notice" && notice.source.summary === "Inject Memory: 2 project memories");
check("notice keeps body", notice.content[0]?.text.includes("two project memories") === true);

if (failed > 0) {
	console.error(`${failed} assertion(s) failed`);
	process.exit(1);
}
console.log("dsh-context notifications smoke: OK");

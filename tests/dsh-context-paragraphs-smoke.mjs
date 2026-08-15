// dsh-plugin-context paragraph numbering smoke test.
// Imports the installed copy (dsh-session resolves from the profile):
// /home/mon3tr/.dsh/profiles/node_modules/dsh-plugin-context
import {
	prefixFirstText,
	injectParagraphNo,
	installParagraphInjector,
	createParagraphAssigner,
} from "/home/mon3tr/.dsh/profiles/node_modules/dsh-plugin-context/lib/paragraphs.js";

let failed = 0;
const check = (label, ok) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
	if (!ok) failed += 1;
};

// ── pure prefix functions ───────────────────────────────────────────────────
{
	const blocks = [{ type: "text", text: "hello" }, { type: "image", src: "x" }];
	const out = prefixFirstText(blocks, 7);
	check("prefix first text block", out[0].text === "\u00A77\u00A7 hello");
	check("prefix keeps other blocks", out[1] === blocks[1]);
	check("prefix does not mutate input", blocks[0].text === "hello");
	const noText = prefixFirstText([{ type: "image", src: "x" }], 3);
	check("prefix prepends when no text block", noText[0].type === "text" && noText[0].text === "\u00A73\u00A7 ");
	const msg = injectParagraphNo({ role: "user", content: [{ type: "text", text: "hi" }] }, 5);
	check("inject message rebuild", msg.content[0].text === "\u00A75\u00A7 hi" && msg.role === "user");
}

// ── assigner: who gets numbers ──────────────────────────────────────────────
{
	const calls = [];
	const cdb = { assignParagraph: (sid, seq) => calls.push([sid, seq]) };
	const assigner = createParagraphAssigner(cdb);
	const sess = { id: "s1" };
	const userMsg = { type: "user/message", seq: 1, surfaceOp: "append", data: { content: [{ type: "text", text: "hi" }] } };
	const asstMsg = { type: "assistant/message", seq: 2, surfaceOp: "append", data: { message: { content: [{ type: "text", text: "ok" }] } } };
	const toolCall1 = { type: "tool/call", seq: 3, data: { callId: "c1", name: "bash", arguments: "{}" } };
	const toolResult1 = { type: "tool/result", seq: 4, surfaceOp: "append", data: { callId: "c1", message: { content: [{ type: "text", text: "out" }] } } };
	const reduceAsst = { type: "assistant/message", seq: 5, surfaceOp: "append", data: { message: { content: [{ type: "tool-call", name: "ctx_reduce", callId: "c2", arguments: "{}" }] } } };
	const reduceCall = { type: "tool/call", seq: 6, data: { callId: "c2", name: "ctx_reduce", arguments: "{}" } };
	const reduceResult = { type: "tool/result", seq: 7, surfaceOp: "append", data: { callId: "c2", message: { content: [{ type: "text", text: "marked" }] } } };
	const mixedAsst = { type: "assistant/message", seq: 8, surfaceOp: "append", data: { message: { content: [{ type: "tool-call", name: "ctx_reduce", callId: "c3", arguments: "{}" }, { type: "tool-call", name: "bash", callId: "c4", arguments: "{}" }] } } };
	const mixedCall3 = { type: "tool/call", seq: 9, data: { callId: "c3", name: "ctx_reduce", arguments: "{}" } };
	const mixedCall4 = { type: "tool/call", seq: 10, data: { callId: "c4", name: "bash", arguments: "{}" } };
	const mixedResult3 = { type: "tool/result", seq: 11, surfaceOp: "append", data: { callId: "c3", message: { content: [{ type: "text", text: "r3" }] } } };
	const mixedResult4 = { type: "tool/result", seq: 12, surfaceOp: "append", data: { callId: "c4", message: { content: [{ type: "text", text: "r4" }] } } };
	const checkpoint = { type: "user/message", seq: 13, surfaceOp: { op: "replace", start: 1, end: 12 }, data: { content: [{ type: "text", text: "checkpoint" }] } };
	const logOnly = { type: "compaction/start", seq: 14, data: { compactionId: "x", turn: null } };
	for (const e of [userMsg, asstMsg, toolCall1, toolResult1, reduceAsst, reduceCall, reduceResult, mixedAsst, mixedCall3, mixedCall4, mixedResult3, mixedResult4, checkpoint, logOnly]) assigner(sess, e);
	check("assigner: user+assistant+tool-result+checkpoint numbered, ctx_reduce excluded", JSON.stringify(calls) === JSON.stringify([["s1", 1], ["s1", 2], ["s1", 4], ["s1", 8], ["s1", 12], ["s1", 13]]));
}

// ── injector: prefix injection + incremental cache + determinism ────────────
{
	const paras = new Map([["s1,1", 1], ["s1,2", 2]]);
	const cdb = { paragraphFor: (sid, seq) => paras.get(`${sid},${seq}`) };
	let nodes = [1, 2];
	const events = {
		1: { seq: 1, type: "user/message" },
		2: { seq: 2, type: "assistant/message" },
	};
	const session = {
		id: "s1",
		surface: { get nodes() { return nodes; }, replaceGeneration: 0 },
		events,
		deriveEventMessage: (event) => ({ role: "user", content: [{ type: "text", text: `msg${event.seq}` }] }),
	};
	installParagraphInjector(session, cdb);
	const first = session.deriveMessages();
	check("injector prefixes numbered messages", first[0].content[0].text === "\u00A71\u00A7 msg1" && first[1].content[0].text === "\u00A72\u00A7 msg2");
	check("injector returns fresh arrays", first !== session.deriveMessages());
	check("injector deterministic", JSON.stringify(first) === JSON.stringify(session.deriveMessages()));
	// incremental: new node appended after the wrap gets a number too
	paras.set("s1,3", 3);
	events[3] = { seq: 3, type: "tool/result" };
	nodes = [1, 2, 3];
	const second = session.deriveMessages();
	check("injector covers appended nodes", second.length === 3 && second[2].content[0].text === "\u00A73\u00A7 msg3");
	// surface shrink (replace) bumps generation: cache resets and old entries drop
	nodes = [1, 2];
	session.surface.replaceGeneration = 1;
	const third = session.deriveMessages();
	check("injector resets cache on replace", third.length === 2 && third[0].content[0].text === "\u00A71\u00A7 msg1");
	// unnumbered node passes through untouched
	nodes = [1, 2, 9];
	events[9] = { seq: 9, type: "tool/result" };
	paras.delete("s1,9");
	const fourth = session.deriveMessages();
	check("injector passthrough for unnumbered", fourth.length === 3 && fourth[2].content[0].text === "msg9");
}

if (failed > 0) {
	console.error(`${failed} assertion(s) failed`);
	process.exit(1);
}
console.log("dsh-context paragraphs smoke: OK");

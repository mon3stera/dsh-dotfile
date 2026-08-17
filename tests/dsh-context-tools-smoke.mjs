// dsh-magic-context ctx_reduce/ctx_expand tool smoke test.
import { parseParagraphList, createExpandTool, createReduceTool, renderOriginalMessage } from "/home/mon3tr/.dsh/profiles/node_modules/dsh-magic-context/lib/tools.js";

let failed = 0;
const check = (label, ok) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
	if (!ok) failed += 1;
};

// ── parse ───────────────────────────────────────────────────────────────────
check("parse single", JSON.stringify(parseParagraphList("5")) === "[5]");
check("parse range", JSON.stringify(parseParagraphList("1-3")) === "[1,2,3]");
check("parse mixed", JSON.stringify(parseParagraphList("1-2,5,11-12")) === "[1,2,5,11,12]");
check("parse dedupes+sorts", JSON.stringify(parseParagraphList("3,1,1-2")) === "[1,2,3]");
check("parse rejects garbage", (() => { try { parseParagraphList("1-2,x"); return false; } catch { return true; } })());
check("parse rejects reversed range", (() => { try { parseParagraphList("5-2"); return false; } catch { return true; } })());

// ── execute ─────────────────────────────────────────────────────────────────
{
	const marks = [];
	const cdb = {
		seqForParagraph: (sid, no) => ({ s1: { 1: 0, 2: 1, 3: 2, 4: 3 } })[sid][no],
		markSkip: (sid, seq, no) => marks.push([sid, seq, no]),
	};
	const tool = createReduceTool(cdb);
	// visible paragraphs 1..3 (surface seqs 0..2); paragraph 4 is stale.
	const exec = { agent: { session: { id: "s1", surface: { nodes: [0, 1, 2] } } } };
	const result = await tool.execute({ paragraphs: "1-2,4" }, exec);
	check("marks visible paragraphs", JSON.stringify(result.marked) === "[1,2]");
	check("rejects stale paragraph", JSON.stringify(result.rejected) === "[4]");
	check("markSkip written per seq", JSON.stringify(marks) === '[["s1",0,1],["s1",1,2]]');
	// no session: empty result
	const none = await tool.execute({ paragraphs: "1" }, {});
	check("no session empty result", JSON.stringify(none) === '{"marked":[],"rejected":[]}');
	// tool shape
	check("tool metadata", tool.name === "ctx_reduce" && typeof tool.execute === "function" && tool.description.includes("paragraph"));
}

// ── ctx_expand: retrieve original log content, including hidden paragraphs ───
{
	const cdb = {
		seqForParagraph: (sid, no) => ({ s1: { 7: 0, 8: 1 } })[sid]?.[no],
	};
	const events = {
		0: { type: "user/message", data: { role: "user", content: [{ type: "text", text: "original hidden paragraph" }] } },
		1: { type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "visible answer" }] } } },
	};
	const session = {
		id: "s1",
		surface: { nodes: [1] },
		events,
		deriveEventMessage: (event) => event.type === "user/message" ? event.data : event.data.message,
	};
	const tool = createExpandTool(cdb);
	const hidden = await tool.execute({ paragraph: 7 }, { agent: { session } });
	check("expand hidden paragraph", hidden.found === true && hidden.seq === 0 && hidden.role === "user" && hidden.content === "original hidden paragraph");
	const visible = await tool.execute({ paragraph: 8 }, { agent: { session } });
	check("expand visible paragraph", visible.found === true && visible.content === "visible answer");
	const missing = await tool.execute({ paragraph: 99 }, { agent: { session } });
	check("expand missing paragraph", missing.found === false && missing.content.includes("not available"));
	check("expand renders original message", renderOriginalMessage({ role: "assistant", content: [{ type: "text", text: "raw" }] }) === "raw");
	check("expand rejects invalid number", (() => tool.execute({ paragraph: 0 }, { agent: { session } }).then(() => false, () => true))());
	check("expand tool metadata", tool.name === "ctx_expand" && tool.description.includes("ctx_reduce"));
}

if (failed > 0) {
	console.error(`${failed} assertion(s) failed`);
	process.exit(1);
}
console.log("dsh-context tools smoke: OK");

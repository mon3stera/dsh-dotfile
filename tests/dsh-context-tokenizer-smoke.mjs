// Exact token accounting: the optional Rust tokenizer, its fail-open fallback,
// the cache/batch contract, and the archival budget it now prices.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createTokenCounter, tokenizerPath, DEFAULT_TOKENIZER_FILE } from "/home/mon3tr/.dsh/profiles/node_modules/dsh-magic-context/lib/tokenizer.js";
import { runArchival } from "/home/mon3tr/.dsh/profiles/node_modules/dsh-magic-context/lib/dreamer.js";
import { openDatabase } from "/home/mon3tr/.dsh/profiles/node_modules/dsh-magic-context/lib/db.js";
import { setContextUsage, getContextUsage, clearContextUsage } from "/home/mon3tr/.dsh/profiles/node_modules/dsh-magic-context/lib/usage.js";

let failed = 0;
const check = (label, ok) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
	if (!ok) failed += 1;
};

const home = process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");
const empty = mkdtempSync("/home/mon3tr/ctx-tok-");
const dbHome = mkdtempSync("/home/mon3tr/ctx-tok-db-");
try {
	// ── fail-open without a vocabulary ───────────────────────────────────────
	const missing = createTokenCounter({ homeDir: empty });
	check("missing vocabulary counts nothing", (await missing.countText("hello")) === null);
	check("missing vocabulary reports unavailable", missing.status().state === "unavailable" && /fetch-tokenizer/.test(missing.status().error ?? ""));
	check("missing vocabulary prices no message", (await missing.countMessage({ content: [{ type: "text", text: "hi" }] })) === null);
	check("empty text is free even without a vocabulary", (await missing.countText("")) === 0);

	// ── exact counts through the real vocabulary ─────────────────────────────
	const vocabulary = tokenizerPath(home, DEFAULT_TOKENIZER_FILE);
	if (!existsSync(vocabulary)) {
		console.log(`SKIP exact counting: no vocabulary at ${vocabulary} (run scripts/fetch-tokenizer.mjs)`);
	} else {
		const counter = createTokenCounter({ homeDir: home });
		check("tokenizer loads", (await counter.warm()) === true && counter.status().state === "ready");
		const chinese = "黑手升温重写：boot2 系地图打包铁律，一键 tools/boot2_build.py";
		const tokens = await counter.countText(chinese);
		const heuristic = Math.ceil(chinese.length / 4);
		check("CJK counts exactly", tokens > 0 && tokens > heuristic, `${tokens} tokens vs chars/4 ${heuristic}`);
		check("counts are cached", (await counter.countText(chinese)) === tokens);
		const batch = await counter.countTexts([chinese, "hello world", ""]);
		check("batch matches single counts", batch[0] === tokens && batch[2] === 0 && batch[1] > 0);
		const english = "export const TOKEN_TTL = 3600; // seconds";
		check("English prices near chars/3.5-4.5", Math.abs((await counter.countText(english)) - english.length / 4) <= 3);

		// Message framing mirrors the host estimator: 4 per block, 4 per message.
		const message = { content: [{ type: "text", text: chinese }, { type: "text", text: english }] };
		check("message framing mirrors the host shape", (await counter.countMessage(message)) === tokens + (await counter.countText(english)) + 12);
		const toolCall = { content: [{ type: "tool-call", name: "bash", arguments: "{\"command\":\"ls\"}" }] };
		check("tool-call prices name and arguments", (await counter.countMessage(toolCall)) === (await counter.countText("bash")) + (await counter.countText("{\"command\":\"ls\"}")) + 8);
		check("unavailable tokenizer returns null from a batch miss", (await createTokenCounter({ homeDir: empty }).countTexts(["hello"]))[0] === null);
	}

	// ── archival prices exact counts and stays inside one session ────────────
	const cdb = openDatabase(dbHome, {});
	const shortSummary = "z".repeat(200); // chars/4 would price this at 50
	const a = cdb.insertCompartment({ sessionId: "s1", scopePath: "/ws", generation: 1, startSeq: 1, endSeq: 5, startPara: 1, endPara: 5, summary: shortSummary });
	cdb.setCompartmentStatus(a, "ready");
	cdb.markCompartmentLanded(a, 42);
	cdb.setCompartmentSummaryTokens(a, 900);
	const b = cdb.insertCompartment({ sessionId: "s2", scopePath: "/ws", generation: 1, startSeq: 1, endSeq: 5, startPara: 1, endPara: 5, summary: shortSummary });
	cdb.setCompartmentStatus(b, "ready");
	cdb.markCompartmentLanded(b, 42);
	cdb.setCompartmentSummaryTokens(b, 900);
	check("exact price is stored", cdb.compartmentById(a).summary_tokens === 900);
	check("missing prices are listed", cdb.compartmentsMissingTokens().length === 0);

	const scoped = runArchival(cdb, { budgetTokens: 100, sessionId: "s1" });
	check("exact prices drive archival", scoped.archived.length === 1 && scoped.archived[0] === a);
	check("archival is session-scoped", cdb.compartmentById(b).archived === 0 && cdb.compartmentById(a).archived === 1);

	const unpriced = cdb.insertCompartment({ sessionId: "s3", scopePath: "/ws", generation: 1, startSeq: 1, endSeq: 5, startPara: 1, endPara: 5, summary: shortSummary });
	cdb.setCompartmentStatus(unpriced, "ready");
	cdb.markCompartmentLanded(unpriced, 42);
	// chars/4 prices the 200-character summary at 50, so a 60-token budget fits it.
	check("an unrecorded price falls back to the heuristic", runArchival(cdb, { budgetTokens: 60, sessionId: "s3" }).archived.length === 0);
	cdb.setCompartmentSummaryTokens(unpriced, 200);
	check("a recorded price overrides the heuristic", runArchival(cdb, { budgetTokens: 60, sessionId: "s3" }).archived.length === 1);
	check("compartment pricing is resettable", cdb.setCompartmentSummaryTokens(unpriced, null) === undefined && cdb.compartmentById(unpriced).summary_tokens === null);

	// ── usage projection shape ───────────────────────────────────────────────
	setContextUsage("usage-session", {
		compartments: { count: 2, tokens: 1000, heuristicTokens: 600, exact: true },
		memories: { count: 3, tokens: 200, heuristicTokens: 120, exact: true },
		measured: { tokens: 5000, kind: "usage", deltaTokens: -40, window: 20000 },
	});
	const usage = getContextUsage("usage-session");
	check("usage keeps both accountings", usage.compartments.tokens === 1000 && usage.compartments.heuristicTokens === 600 && usage.compartments.exact === true);
	check("usage totals the rows", usage.totalTokens === 1200);
	check("usage carries the anchored measurement", usage.measured.tokens === 5000 && usage.measured.kind === "usage" && usage.measured.window === 20000);
	check("usage keeps a signed delta", usage.measured.deltaTokens === -40);
	clearContextUsage("usage-session");
	check("usage clears", getContextUsage("usage-session").measured.tokens === 0);
} finally {
	rmSync(empty, { recursive: true, force: true });
	rmSync(dbHome, { recursive: true, force: true });
}

if (failed > 0) {
	console.log(`dsh-context tokenizer smoke: ${failed} failure(s)`);
	process.exit(1);
}
console.log("dsh-context tokenizer smoke: OK");

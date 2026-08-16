// User-side /ctx-search command parser and execution smoke test.
import { DEFAULT_MEMORY_CONFIG } from "/home/mon3tr/.dsh/profiles/node_modules/dsh-plugin-context/lib/memory.js";
import { executeCtxSearchCommand, executeDreamCommand, parseCtxSearchInput, parseDreamInput } from "/home/mon3tr/.dsh/profiles/node_modules/dsh-plugin-context/lib/commands.js";

let failed = 0;
const check = (label, ok) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
	if (!ok) failed += 1;
};

check("empty command usage", parseCtxSearchInput("").error.includes("/ctx-search"));
check("query parser", JSON.stringify(parseCtxSearchInput("jwt authentication")) === JSON.stringify({ query: "jwt authentication", limit: 5 }));
check("limit parser", JSON.stringify(parseCtxSearchInput("jwt --limit 3")) === JSON.stringify({ query: "jwt", limit: 3 }));
check("limit equals parser", JSON.stringify(parseCtxSearchInput("jwt --limit=2")) === JSON.stringify({ query: "jwt", limit: 2 }));
check("invalid limit usage", parseCtxSearchInput("jwt --limit 11").error.includes("1 to 10"));

const rows = [
	{ id: 7, category: "ARCHITECTURE", summary: "JWT auth", content: "Use a 30 day expiry." },
];
const hits = [];
const cdb = {
	vecEnabled: false,
	ftsSearch(query, limit) { check("search receives query", query === "jwt authentication" && limit === 20); return rows; },
	memoryById(id) { return rows.find((row) => row.id === id); },
	recordMemoryHit(id) { hits.push(id); },
	updateMemory() {},
};
const result = await executeCtxSearchCommand({ rawInput: "jwt authentication --limit 3" }, {
	cdb,
	memoryConfig: DEFAULT_MEMORY_CONFIG,
	retrieval: { ftsTopK: 20, vecTopK: 20, rrfK: 60, rerankTopN: 5, rerankInputTopK: 20 },
});
check("command succeeds", result.kind === "success");
check("command renders ctx_search format", result.text === "#7 [ARCHITECTURE] JWT auth\nUse a 30 day expiry.");
check("command records hit", hits.length === 1 && hits[0] === 7);
check("dream parser accepts no args", JSON.stringify(parseDreamInput("")) === "{}");
check("dream parser rejects args", parseDreamInput("now").error === "Usage: /dream");
let dreamAgent;
const dreamResult = await executeDreamCommand({ agent: { id: "agent-1" }, rawInput: "" }, {
	runDreamer: async (agent) => {
		dreamAgent = agent;
		return { skipped: false, rounds: 2, facts: [{}], memories: [{}, {}], compartments: [] };
	},
});
check("dream command runs current agent", dreamAgent?.id === "agent-1" && dreamResult.kind === "success");
check("dream command reports rounds", dreamResult.text.includes("Dreamer completed 2 rounds"));

if (failed > 0) {
	console.error(`${failed} assertion(s) failed`);
	process.exit(1);
}
console.log("dsh-context command smoke: OK");

// User-side /ctx-search command parser and execution smoke test.
import { DEFAULT_MEMORY_CONFIG } from "/home/mon3tr/.dsh/profiles/node_modules/dsh-magic-context/lib/memory.js";
import { collectRelatedMemories, executeCtxSearchCommand, executeDreamCommand, executeInjectMemoryCommand, executeOrganizeMemoriesCommand, parseCtxSearchInput, parseDreamInput, parseInjectMemoryInput, parseOrganizeMemoriesInput, renderOrganizeMemoriesText } from "/home/mon3tr/.dsh/profiles/node_modules/dsh-magic-context/lib/commands.js";

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
check("inject parser accepts no args", JSON.stringify(parseInjectMemoryInput("")) === "{}");
check("inject parser rejects args", parseInjectMemoryInput("now").error === "Usage: /inject-memory");
const injectableRows = [
	{ id: 9, category: "CONVENTIONS", summary: "Use append-only context injections.", content: "Keep the existing request prefix stable.", importance: 8, hits: 0, last_hit_at: Date.now(), archived: 0 },
];
const injectHits = [];
const injectedMessages = [];
const injectCdb = {
	allInjectableMemories() { return injectableRows; },
	recordMemoryHit(id) { injectHits.push(id); },
	updateMemory() {},
};
const injectResult = await executeInjectMemoryCommand({
	rawInput: "",
	agent: { session: { id: "agent-1" }, inject(message) { injectedMessages.push(message); } },
}, {
	cdb: injectCdb,
	memoryConfig: DEFAULT_MEMORY_CONFIG,
	resolveScope: () => "/repo",
});
check("inject command succeeds", injectResult.kind === "success");
check("inject command appends one message", injectedMessages.length === 1 && injectedMessages[0].content[0].text.includes("<project_memory>") && injectedMessages[0].source.form === "notice");
check("inject command records memory hit", injectHits.length === 1 && injectHits[0] === 9);

check("organize parser accepts no args", JSON.stringify(parseOrganizeMemoriesInput("")) === "{}");
check("organize parser rejects args", parseOrganizeMemoriesInput("now").error === "Usage: /organize-memories");
const organizeRows = [
	{ id: 9, category: "CONVENTIONS", summary: "Use append-only context injections.", content: "Keep the existing request prefix stable.", importance: 8, hits: 0, last_hit_at: Date.now(), archived: 0 },
];
const relatedRow = { id: 11, category: "CONVENTIONS", summary: "Use append-only injections.", content: "Older wording of the same convention.", archived: 1 };
const organizeHits = [];
const organizedMessages = [];
const organizeCdb = {
	allInjectableMemories() { return organizeRows; },
	recordMemoryHit(id) { organizeHits.push(id); },
	updateMemory() {},
	ftsSearch() { return [relatedRow]; },
	memoryById(id) { return id === 11 ? relatedRow : organizeRows.find((row) => row.id === id); },
};
const organizeResult = await executeOrganizeMemoriesCommand({
	rawInput: "",
	agent: { session: { id: "agent-1" }, inject(message) { organizedMessages.push(message); } },
}, {
	cdb: organizeCdb,
	memoryConfig: DEFAULT_MEMORY_CONFIG,
	resolveScope: () => "/repo",
});
check("organize command succeeds", organizeResult.kind === "success");
check("organize command appends one notice", organizedMessages.length === 1 && organizedMessages[0].source.form === "notice" && organizedMessages[0].content[0].text.includes("CURRENTLY INJECTED"));
check("organize command includes ids and related archived", organizedMessages[0].content[0].text.includes("#9 [CONVENTIONS]") && organizedMessages[0].content[0].text.includes("#11 [CONVENTIONS] archived"));
check("organize command asks before uncertain deletes", organizedMessages[0].content[0].text.includes("ask the user before changing anything"));
check("organize command records memory hit", organizeHits.length === 1 && organizeHits[0] === 9);
check("organize related collector skips the injected id", collectRelatedMemories(organizeCdb, organizeRows, "/repo").map((row) => row.id).join(",") === "11");
check("organize renderer lists injected content", renderOrganizeMemoriesText(organizeRows).includes("Keep the existing request prefix stable."));
const emptyOrganize = await executeOrganizeMemoriesCommand({
	rawInput: "",
	agent: { session: { id: "agent-1" }, inject() { throw new Error("should not inject"); } },
}, {
	cdb: { allInjectableMemories() { return []; }, updateMemory() {} },
	memoryConfig: DEFAULT_MEMORY_CONFIG,
	resolveScope: () => "/repo",
});
check("organize command skips empty set", emptyOrganize.kind === "success" && emptyOrganize.text.includes("No injectable"));

if (failed > 0) {
	console.error(`${failed} assertion(s) failed`);
	process.exit(1);
}
console.log("dsh-context command smoke: OK");

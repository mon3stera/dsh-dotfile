/** System-prompt guidance for the four context-management tools. */
export const CONTEXT_TOOL_GUIDANCE = {
	name: "context-tool-guidance",
	order: 102,
	text: [
		"Use the context-management tools deliberately:",
		"1. If paragraphs are no longer needed for the task or have become obsolete, use ctx_reduce to mark them before compaction.",
		"2. When the user identifies an important durable memory, or when you judge a project fact, convention, constraint, preference, or environment detail worth retaining, use ctx_search first. If a live memory already covers the fact, ctx_memory update that id (do not write a second row). If a memory is stale or contradicted, ctx_memory delete it. Only ctx_memory write when search finds no duplicate and no stale row that should be replaced.",
		"3. When you need the full details of a stored memory, use ctx_search instead of relying on the injected summary alone. Archived memories stay searchable; archival only removes them from automatic injection.",
		"4. When you need exact original content from a paragraph, use ctx_expand with its paragraph number.",
	].join(" "),
};

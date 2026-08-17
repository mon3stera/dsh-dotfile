/** System-prompt guidance for the four context-management tools. */
export const CONTEXT_TOOL_GUIDANCE = {
	name: "context-tool-guidance",
	order: 102,
	text: [
		"Use the context-management tools deliberately:",
		"1. If paragraphs are no longer needed for the task or have become obsolete, use ctx_reduce to mark them before compaction.",
		"2. When the user identifies an important durable memory, or when you judge a project fact, convention, constraint, preference, or environment detail worth retaining, use ctx_memory to write it.",
		"3. When you need the full details of a stored memory, use ctx_search instead of relying on the injected summary alone.",
		"4. When you need exact original content from a paragraph, use ctx_expand with its paragraph number.",
	].join(" "),
};

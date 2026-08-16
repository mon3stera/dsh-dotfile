// Context UI notices use DSH's existing plugin context-message presentation.
// agent.inject() queues the notice for the next pre-step; the built-in web
// conversation renderer shows it as a collapsed ContextInjectionRow.
import { boundContextSummary, createUserMessage } from "@deepseek-ai/dsh-llm";

const PLUGIN = "dsh-plugin-context";

/** Build one durable, model-facing context notice for the next agent step. */
export function createContextNotice(summary, text) {
	if (typeof summary !== "string" || summary.trim().length === 0) throw new Error("context notice summary must be non-empty");
	if (typeof text !== "string" || text.trim().length === 0) throw new Error("context notice text must be non-empty");
	return createUserMessage({
		content: [{ type: "text", text }],
		source: {
			kind: "plugin",
			plugin: PLUGIN,
			form: "notice",
			summary: boundContextSummary(summary.trim()),
		},
	});
}

/** Queue a notice without making UI delivery a critical-path failure. */
export function injectContextNotice(agent, summary, text) {
	if (agent === undefined) return false;
	agent.inject(createContextNotice(summary, text));
	return true;
}

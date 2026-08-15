// Background summarizer ("organizer") for dsh-plugin-context.
//
// Runs OUTSIDE the agent loop: at the 65% generation point it captures a
// stable input snapshot (the compartment's fixed span, minus skipped
// paragraphs, minus prior checkpoints), makes ONE auxiliary LLM call, and
// stores the result as a ready compartment plus pending session facts.
// Because it never runs inside a turn and never mutates the surface, it does
// not block the agent and does not disturb prefix stability.
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import { isCompactCheckpointSource } from "@deepseek-ai/dsh-compaction";

/** Directs the organizer to emit summary + extractable facts in tagged blocks. */
export const ORGANIZER_INSTRUCTION = [
	"You are the context organizer for this AI coding assistant session.",
	"Condense the conversation region ABOVE into a compartment checkpoint that lets another model resume the work with no loss of essential context.",
	"",
	"Output EXACTLY this structure:",
	"<compacted-summary>",
	"- terse bullets, not prose: preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments",
	"- capture user feedback and explicit instructions faithfully, especially corrections",
	"- the summary is used as established context; never mention this summarization request",
	"</compacted-summary>",
	"<session-facts>",
	"- [one project-worthy fact per line, with enough context to stand alone] (importance: 0-10)",
	"</session-facts>",
	"",
	"Rules:",
	"- Keep every section in order. Write the facts section with a single line \"(none)\" when nothing is project-worthy.",
	"- Facts are raw material for the project memory: architecture decisions, constraints, conventions, preferences, environment/config facts. Do NOT include one-off task details.",
	"- Output only the two blocks; do not call any tool or take any other action.",
].join("\n");

/** Build the stable input snapshot for a compartment's fixed span. */
export function buildSummarizationInput(session, range, skipSeqs) {
	const header = session.requestHeader();
	const messages = [];
	for (const seq of range.shadowedSeqs) {
		if (skipSeqs.has(seq)) continue;
		const event = session.events[seq];
		// Never re-summarize a prior checkpoint (chain design).
		if (event.type === "user/message" && event.data.source !== undefined && isCompactCheckpointSource(event.data.source)) continue;
		const msg = session.deriveEventMessage(event);
		if (msg) messages.push(msg);
	}
	return {
		...(header?.system === undefined ? {} : { system: header.system }),
		...(header?.tools === undefined ? {} : { tools: header.tools }),
		messages,
	};
}

/** Parse the organizer output into { summary, facts: [{text, importance}] }. */
export function parseOrganizerOutput(text) {
	const summaryMatch = text.match(/<compacted-summary>([\s\S]*?)<\/compacted-summary>/);
	const summary = summaryMatch ? summaryMatch[1].trim() : text.trim();
	const facts = [];
	const factsMatch = text.match(/<session-facts>([\s\S]*?)<\/session-facts>/);
	if (factsMatch) {
		for (const line of factsMatch[1].split("\n")) {
			const m = line.match(/^\s*[-*]\s*(.+?)(?:\s*\(importance:\s*(\d+(?:\.\d+)?)\))?\s*$/);
			if (m !== null && m[1] !== undefined && m[1].trim() !== "(none)") {
				facts.push({
					text: m[1].trim(),
					importance: m[2] === undefined ? 5 : Math.min(10, Math.max(0, Number.parseFloat(m[2]))),
				});
			}
		}
	}
	return { summary, facts };
}

/** Map a terminal stream finish to its fail-closed error. */
function finishError(finish) {
	switch (finish.kind) {
		case "error":
		case "aborted": {
			const error = new Error(finish.failure.message);
			error.code = finish.failure.code;
			return error;
		}
		case "max-tokens": {
			const error = new Error("organizer output truncated at the token cap (incomplete compartment)");
			error.code = "MAX_TOKENS";
			return error;
		}
		default:
			return undefined;
	}
}

/**
 * Run the organizer: one auxiliary LLM call over the fixed span, then persist
 * the summary (compartment -> ready) and extracted facts (session_facts).
 * @param ctx - host context with llm service.
 * @param cdb - context database.
 * @param args - { session, compartment, range }.
 * @returns the parsed { summary, facts }.
 */
export async function summarizeCompartment(ctx, cdb, { session, compartment, range }) {
	const input = buildSummarizationInput(session, range, cdb.skippedSeqs(session.id));
	const header = session.requestHeader();
	const target = header?.config;
	if (target === undefined || target.provider.length === 0 || target.model.length === 0) {
		throw new Error("no provider/model available for compartment summarization");
	}
	const assembler = new BlockAssembler();
	const options = {
		provider: target.provider,
		model: target.model,
		messages: [
			...input.messages,
			createUserMessage({
				content: [{ type: "text", text: ORGANIZER_INSTRUCTION }],
				source: { kind: "plugin", plugin: "dsh-plugin-context" },
			}),
		],
		...(input.system === undefined ? {} : { system: input.system }),
		...(input.tools === undefined ? {} : { tools: input.tools }),
		maxTokens: 8192,
		sessionId: session.id,
		purpose: "compaction",
	};
	for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk);
	const error = finishError(assembler.finish);
	if (error !== undefined) throw error;
	const text = assembler.blocks().filter((block) => block.type === "text").map((block) => block.text).join("\n");
	if (text.trim().length === 0) throw new Error("organizer produced no text content");
	const parsed = parseOrganizerOutput(text);
	cdb.setCompartmentSummary(compartment.id, { summary: parsed.summary, provider: options.provider, model: options.model });
	for (const fact of parsed.facts) {
		cdb.insertFact({ sessionId: session.id, compartmentId: compartment.id, fact: fact.text, importance: fact.importance });
	}
	return parsed;
}

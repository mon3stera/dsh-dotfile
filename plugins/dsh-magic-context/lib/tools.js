// Conversation paragraph tools: ctx_reduce marks paragraphs as skippable and
// ctx_expand retrieves original paragraph content from the session log.
import { defineTool } from "@deepseek-ai/dsh-tools";

const RANGE_RE = /^\d+(-\d+)?$/;

/** Parse "1-2,5,11-12" into a sorted, deduped number list. */
export function parseParagraphList(input) {
	const out = new Set();
	for (const part of input.split(",")) {
		const piece = part.trim();
		if (piece.length === 0) continue;
		if (!RANGE_RE.test(piece)) throw new Error(`invalid paragraph range "${part}"`);
		const [a, b] = piece.split("-").map(Number);
		if (b === undefined) {
			out.add(a);
		} else {
			if (b < a) throw new Error(`invalid paragraph range "${part}"`);
			for (let i = a; i <= b; i += 1) out.add(i);
		}
	}
	return [...out].sort((x, y) => x - y);
}

/** Render the original message content without the injected paragraph prefix. */
function blockText(block) {
	if (block?.type === "text") return block.text ?? "";
	if (block?.type === "tool-call") return `[tool-call ${block.name ?? ""}] ${block.arguments ?? ""}`;
	if (block?.type === "tool-result") return `[tool-result ${block.toolCallId ?? ""}]\n${contentText(block.content)}`;
	return `[${block?.type ?? "content-block"}] ${JSON.stringify(block)}`;
}

function contentText(content) {
	if (!Array.isArray(content)) return "";
	return content.map(blockText).filter((text) => text.length > 0).join("\n");
}

/** Extract the durable, unprefixed text represented by one session message. */
export function renderOriginalMessage(message) {
	return contentText(message?.content);
}

/** Build the registered ctx_expand tool over one context database. */
export function createExpandTool(cdb) {
	return defineTool({
		name: "ctx_expand",
		description: [
			"Retrieve the original content of one conversation paragraph by its \u00A7N\u00A7 number.",
			"Unlike ctx_reduce, this can retrieve paragraphs that are no longer visible after a checkpoint replacement, as long as the session log is retained.",
		].join(" "),
		parameters: {
			paragraph: {
				type: "number",
				required: true,
				description: "One paragraph number, for example 42.",
			},
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					found: { type: "boolean", required: true },
					paragraph: { type: "number", required: true },
					seq: { type: "number" },
					role: { type: "string" },
					content: { type: "string", required: true },
				},
			},
			render: (args, value) => [{
				type: "text",
				text: value.found
					? `ctx_expand \u00A7${value.paragraph}\u00A7 (seq ${value.seq})\n${value.content}`
					: `ctx_expand: paragraph \u00A7${value.paragraph}\u00A7 was not found in the retained session log.`,
			}],
		},
		async execute(args, exec) {
			const paragraph = args.paragraph;
			if (!Number.isSafeInteger(paragraph) || paragraph < 1) throw new Error("paragraph must be a positive integer");
			const session = exec.agent?.session;
			if (session === undefined) return { found: false, paragraph, content: "No active session." };
			const seq = cdb.seqForParagraph(session.id, paragraph);
			const event = seq === undefined ? undefined : session.events?.[seq];
			const message = event === undefined || typeof session.deriveEventMessage !== "function"
				? undefined
				: session.deriveEventMessage(event);
			if (seq === undefined || event === undefined || message === null || message === undefined) {
				return { found: false, paragraph, content: `Paragraph \u00A7${paragraph}\u00A7 is not available in the retained session log.` };
			}
			return {
				found: true,
				paragraph,
				seq,
				role: message.role ?? "unknown",
				content: renderOriginalMessage(message) || "(empty message)",
			};
		},
	});
}

/** Build the registered ctx_reduce tool over one context database. */
export function createReduceTool(cdb) {
	return defineTool({
		name: "ctx_reduce",
		description: [
			"Mark conversation paragraphs (by their \u00A7N\u00A7 numbers) as no longer needed.",
			"Their content is skipped when the next checkpoint summary is generated, and the original text stays recallable from the session log.",
			"Numbers refer to the current context; numbers that fell out of the visible context are rejected.",
		].join(" "),
		parameters: {
			paragraphs: {
				type: "string",
				required: true,
				description: 'Comma-separated paragraph numbers or ranges, e.g. "1-2,5,11-12".',
			},
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					marked: { type: "array", items: { type: "number" }, required: true },
					rejected: { type: "array", items: { type: "number" }, required: true },
				},
			},
			render: (args, value) => [
				{ type: "text", text: `ctx_reduce: marked ${value.marked.length} paragraph(s), rejected ${value.rejected.length}.` },
			],
		},
		async execute(args, exec) {
			const session = exec.agent?.session;
			if (session === undefined) return { marked: [], rejected: [] };
			const numbers = parseParagraphList(args.paragraphs);
			const marked = [];
			const rejected = [];
			const visible = new Set(session.surface.nodes);
			for (const no of numbers) {
				const seq = cdb.seqForParagraph(session.id, no);
				if (seq === undefined || !visible.has(seq)) {
					rejected.push(no);
					continue;
				}
				cdb.markSkip(session.id, seq, no);
				marked.push(no);
			}
			return { marked, rejected };
		},
	});
}

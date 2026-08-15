// ctx_reduce tool: let the model mark §N§ paragraphs as no longer needed.
// Skipped paragraphs are excluded from the next compartment summary; the
// original text always stays recallable from the session log (design §3.4).
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

// Paragraph numbering for dsh-magic-context.
//
// Every model-visible message (user output, assistant output, tool result)
// gets a global monotonic paragraph number, persisted in the `paragraphs`
// table. Numbers are assigned when surface events are appended (never inside
// `deriveMessages`, so read-only callers like the api-proxy image check stay
// side-effect free), and injected as a `§N§ ` text prefix by wrapping
// `session.deriveMessages` — the single assembly point agent-loop uses for the
// main request. Auxiliary LLM calls (summarization, titles) never call
// `deriveMessages`, so they neither consume nor show numbers. `ctx_reduce` and
// `ctx_expand` tool calls themselves are excluded from numbering (design §3.2).
import { isSurfaceEvent } from "@deepseek-ai/dsh-session/surface";

/** Tool names whose own call/result nodes are excluded from numbering. */
export const SKIP_TOOL_NAMES = new Set(["ctx_reduce", "ctx_expand"]);

/** The injected text prefix for one paragraph number. */
export function paragraphPrefix(no) {
	return `\u00A7${no}\u00A7 `;
}

/** Prefix the first text block of a content array; never mutates input. */
export function prefixFirstText(blocks, no) {
	const prefix = paragraphPrefix(no);
	let injected = false;
	const out = blocks.map((block) => {
		if (!injected && block.type === "text") {
			injected = true;
			return { ...block, text: prefix + block.text };
		}
		return block;
	});
	if (!injected) out.unshift({ type: "text", text: prefix });
	return out;
}

/** Rebuild a message with its paragraph prefix; input stays untouched. */
export function injectParagraphNo(message, no) {
	return { ...message, content: prefixFirstText(message.content, no) };
}

/**
 * Rebuild a tool-result message with the paragraph number INSIDE the
 * tool-result block's own content (the text the model reads), leaving the
 * message's top-level content a pure `[tool-result]` array. The DeepSeek
 * adapter expands such a message into a single `{role: "tool"}` wire message
 * (any text is legal there), so the number stays visible to the model without
 * ever inserting a stray user message between a tool call and its reply.
 * Blocks without a text block get the prefix prepended to their content.
 */
export function injectToolResultParagraph(message, no) {
	return {
		...message,
		content: message.content.map((block) => {
			if (block.type !== "tool-result") return block;
			return { ...block, content: prefixFirstText(block.content, no) };
		}),
	};
}

/** True when a message carries an assistant tool-call block (no content slot). */
function carriesToolCalls(message) {
	return message.content.some((block) => block.type === "tool-call");
}

/**
 * Wrap `session.deriveMessages` with paragraph injection (and an optional
 * extra head message, used by the memory injector).
 *
 * Mirrors the original incremental cache (keyed by replace generation), but
 * rebuilds every message object so the shared frozen event data is never
 * mutated. Deterministic per surface state, which keeps the agent-loop
 * `llm/stream` reconstruction invariant (JSON equality with
 * `session.deriveMessages()`) satisfied: both the request assembly and the
 * invariant check go through this same wrapper.
 *
 * Messages that carry tool blocks keep their paragraph number (they can be
 * referenced by ctx_reduce) but are never prefixed at the top level:
 * assistant tool-call messages have no content slot at all (DeepSeek
 * requires empty content on tool_calls messages), and tool-result messages
 * carry their number INSIDE the tool-result block's content, so the adapter
 * still expands them into standalone `{role: "tool"}` wire messages with no
 * stray user message inserted between a tool call and its reply.
 * @param session - the session whose method is wrapped.
 * @param cdb - context database supplying paragraph numbers.
 * @param opts - { extraMessage: () => Message | null } head message (e.g. the
 * cached <project_memory> block), evaluated per call, inserted first.
 */
export function installParagraphInjector(session, cdb, opts = {}) {
	const { extraMessage } = opts;
	let cacheGen = -1;
	let cacheNodes = 0;
	const cache = [];
	session.deriveMessages = function deriveMessagesWithParagraphs() {
		const surface = session.surface;
		const gen = surface.replaceGeneration;
		const nodes = surface.nodes;
		if (gen !== cacheGen || cacheNodes > nodes.length) {
			cache.length = 0;
			cacheNodes = 0;
			cacheGen = gen;
		}
		for (const seq of nodes.slice(cacheNodes)) {
			const msg = session.deriveEventMessage(session.events[seq]);
			if (!msg) continue;
			const no = cdb.paragraphFor(session.id, seq);
			if (no === undefined) {
				cache.push(msg);
			} else if (msg.content.some((block) => block.type === "tool-result")) {
				cache.push(injectToolResultParagraph(msg, no));
			} else if (carriesToolCalls(msg)) {
				cache.push(msg); // numbered, but no display slot
			} else {
				cache.push(injectParagraphNo(msg, no));
			}
		}
		cacheNodes = nodes.length;
		const head = extraMessage === undefined ? null : extraMessage();
		if (head !== null) return [head, ...cache];
		return [...cache];
	};
}

/**
 * Surface-event listener that assigns paragraph numbers as events land.
 *
 * Skips: `tool/call` (log-only), assistant messages whose tool calls are all
 * excluded tools, and tool results whose paired `tool/call` named an excluded
 * tool. Every other surface event (including a landing checkpoint's
 * replacement user message) receives the next global number.
 * @param cdb - context database.
 * @param opts - { skipToolNames } excluded tool set (default ctx_reduce/ctx_expand).
 * @returns a `session/event` listener.
 */
export function createParagraphAssigner(cdb, { skipToolNames = SKIP_TOOL_NAMES } = {}) {
	const callNames = new WeakMap(); // session -> Map<callId, toolName>
	const rememberCall = (session, callId, name) => {
		let names = callNames.get(session);
		if (names === undefined) {
			names = new Map();
			callNames.set(session, names);
		}
		names.set(callId, name);
	};
	const findCallName = (session, callId) => {
		const remembered = callNames.get(session)?.get(callId);
		if (remembered !== undefined) return remembered;
		for (let index = session.events.length - 1; index >= 0; index -= 1) {
			const event = session.events[index];
			if (event.type === "tool/call" && event.data.callId === callId) {
				rememberCall(session, callId, event.data.name);
				return event.data.name;
			}
		}
		return undefined;
	};
	return (session, event) => {
		if (event.type === "tool/call") {
			rememberCall(session, event.data.callId, event.data.name);
			return;
		}
		if (event.type === "assistant/message") {
			const calls = event.data.message.content.filter((block) => block.type === "tool-call");
			if (calls.length > 0 && calls.every((call) => skipToolNames.has(call.name))) return;
		} else if (event.type === "tool/result") {
			// The call id lives on the tool-result message's source, not on the
			// event data root. Fall back to the durable event log for restored sessions.
			const callId = event.data.message?.source?.callId ?? event.data.callId;
			const name = findCallName(session, callId);
			if (name !== undefined && skipToolNames.has(name)) return;
		}
		if (isSurfaceEvent(event)) cdb.assignParagraph(session.id, event.seq);
	};
}

/** System-prompt section teaching the model how paragraph numbers work. */
export const PARAGRAPH_SECTION = {
	name: "context-paragraph-numbers",
	order: 100,
	text: [
		"Each model-visible message in this conversation carries a paragraph number prefix (\u00A7N\u00A7).",
		"Paragraph numbers are assigned in increasing order as messages are added and never reused.",
		"When older history is replaced by a checkpoint, the checkpoint takes a new number and numbers that fell out of the visible context are no longer valid — always address paragraphs by the numbers shown in the current context.",
		"Use the ctx_reduce tool with explicit paragraph numbers (e.g. ctx_reduce=[1-2,5,11-12]) to mark content you no longer need; it is skipped when the next checkpoint summary is generated.",
		"Use ctx_expand with one paragraph number (e.g. ctx_expand=42) to retrieve its original content from the retained session log, including paragraphs no longer visible after a checkpoint.",
	].join(" "),
};

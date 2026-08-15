// Paragraph numbering for dsh-plugin-context.
//
// Every model-visible message (user output, assistant output, tool result)
// gets a global monotonic paragraph number, persisted in the `paragraphs`
// table. Numbers are assigned when surface events are appended (never inside
// `deriveMessages`, so read-only callers like the api-proxy image check stay
// side-effect free), and injected as a `§N§ ` text prefix by wrapping
// `session.deriveMessages` — the single assembly point agent-loop uses for the
// main request. Auxiliary LLM calls (summarization, titles) never call
// `deriveMessages`, so they neither consume nor show numbers. `ctx_reduce`
// tool calls themselves are excluded from numbering (design §3.2).
import { isSurfaceEvent } from "@deepseek-ai/dsh-session/surface";

/** Tool names whose own call/result nodes are excluded from numbering. */
export const SKIP_TOOL_NAMES = new Set(["ctx_reduce"]);

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

/** True when a message carries tool blocks (assistant tool calls or tool results). */
function carriesToolBlocks(message) {
	return message.content.some((block) => block.type === "tool-call" || block.type === "tool-result");
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
 * Messages that carry tool blocks KEEP their paragraph number (they can be
 * referenced by ctx_reduce) but never receive the §N§ prefix: the DeepSeek
 * adapter requires assistant tool-call messages to have empty content, and
 * expands a tool-result message into standalone `{role: "tool"}` wire
 * messages — a prefixed text block would make the assistant content
 * non-empty or insert a stray user message between the tool call and its
 * reply, which the provider rejects (INVALID_REQUEST 400).
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
			if (no === undefined || carriesToolBlocks(msg)) {
				cache.push(msg);
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
 * @param opts - { skipToolNames } excluded tool set (default ctx_reduce).
 * @returns a `session/event` listener.
 */
export function createParagraphAssigner(cdb, { skipToolNames = SKIP_TOOL_NAMES } = {}) {
	const callNames = new WeakMap(); // session -> Map<callId, toolName>
	return (session, event) => {
		if (event.type === "tool/call") {
			let names = callNames.get(session);
			if (names === undefined) {
				names = new Map();
				callNames.set(session, names);
			}
			names.set(event.data.callId, event.data.name);
			return;
		}
		if (event.type === "assistant/message") {
			const calls = event.data.message.content.filter((block) => block.type === "tool-call");
			if (calls.length > 0 && calls.every((call) => skipToolNames.has(call.name))) return;
		} else if (event.type === "tool/result") {
			// The call id lives on the tool-result message's source, not on the
			// event data root.
			const callId = event.data.message?.source?.callId ?? event.data.callId;
			const name = callNames.get(session)?.get(callId);
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
		"Use the ctx_reduce tool with explicit paragraph numbers (e.g. ctx_reduce=[1-2,5,11-12]) to mark content you no longer need; it is skipped when the next checkpoint summary is generated, and the original text stays recallable from the session log.",
	].join(" "),
};

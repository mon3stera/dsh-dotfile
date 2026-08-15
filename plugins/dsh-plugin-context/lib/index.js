// dsh-plugin-context entry — Phase 2: paragraph numbering mounted.
// Later phases mount the async engine, memory system, tools, and Dreamer here.
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { openDatabase } from "./db.js";
import { createParagraphAssigner, installParagraphInjector, PARAGRAPH_SECTION } from "./paragraphs.js";

export const name = "dsh-plugin-context";
export const inject = ["systemPrompt"];

export function apply(ctx) {
	const cdb = openDatabase(resolveDshHome());
	ctx.effect(() => () => cdb.close(), "dsh-plugin-context db");

	// Assign paragraph numbers as surface events land (skips ctx_reduce itself).
	ctx.on("session/event", createParagraphAssigner(cdb));

	// Wrap each session's deriveMessages so the main request carries §N§ prefixes.
	const wrapped = new WeakSet();
	ctx.on("agent/session-start", ({ agent }) => {
		const session = agent.session;
		if (wrapped.has(session)) return;
		wrapped.add(session);
		installParagraphInjector(session, cdb);
	});

	// Teach the model the numbering rules.
	ctx.systemPrompt.section(PARAGRAPH_SECTION);
}

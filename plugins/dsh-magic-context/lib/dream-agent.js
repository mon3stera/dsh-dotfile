// Agent-plane entry for the `dream` agent preset: registers the Dreamer's
// read-only maintenance tools into the host `tools` registry plus the
// Dreamer instruction section.
//
// The dream preset deliberately mounts NOTHING else: no shell, no general
// filesystem tools, no delegation, and above all NO compaction group. A dream
// child session therefore cannot compact — context overflow fails the pass
// loudly, which is the intended signal that a pass is too heavy and its brief
// or source ranges must shrink.
//
// Tool execution resolves the executing agent's session at runtime
// (exec.agent.session), so workspace root and memory scope always come from
// the dream child's own header (inherited from its parent), never from a
// mount-time snapshot.
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";

import { openDatabase } from "./db.js";
import { DREAM_TOOL_SCHEMAS, DREAMER_INSTRUCTION, createDreamerExecutors } from "./dreamer.js";
import { sessionMemoryScope } from "./scope.js";

/** @module dsh-magic-context/dream-agent */

/** Cordis plugin name used by loader diagnostics. */
const name = "dsh-magic-context-dream-agent";

/** Services required at registration time. */
const inject = ["tools", "systemPrompt"];

const Config = z.object({});

/** Tool result rows ride the same shallow-JSON presentation as the legacy loop. */
const MAX_TOOL_TEXT = 8000;

function renderValue(value) {
	const text = typeof value === "string" ? value : JSON.stringify(value, null, 1);
	return [{ type: "text", text: text.slice(0, MAX_TOOL_TEXT) }];
}

/**
 * Convert the shared shallow JSON-schema parameter shape into the flat
 * `defineTool` parameter spec (name -> { type, required, description, ... }).
 * The Dreamer tools are deliberately flat; nesting would need a real rewrite,
 * not a converter.
 */
function flatSpecFromJsonSchema(schema) {
	const required = new Set(schema.required ?? []);
	const spec = {};
	for (const [key, property] of Object.entries(schema.properties ?? {})) {
		spec[key] = {
			...property,
			...(required.has(key) ? { required: true } : {}),
		};
	}
	return spec;
}

/** Register the Dreamer maintenance tools and instruction for dream agents. */
function apply(ctx) {
	// One database connection per standing mount, closed on disposal. The
	// vector/embedding refresh inside the write tools stays best-effort: this
	// connection carries no embedding dimension, so vec is disabled and FTS
	// remains the retrieval path (the same degradation the engine already
	// treats as optional).
	const cdb = openDatabase(resolveDshHome(), {});

	ctx.effect(() => () => {
		cdb.close();
	}, "dsh-magic-context dream-agent db");

	// The host sessions service exposes live (resident) sessions only — the
	// same semantics the legacy loop had through the engine's realm — so
	// session_context can read a resident source session (typically the parent
	// that triggered this pass) under the unchanged scope checks. An
	// unavailable service or a non-resident session degrades to the stored
	// fact/compartment summary, exactly like the legacy loop.
	let sessions;
	try {
		ctx.inject?.(["sessions"], (hostCtx) => {
			sessions = hostCtx.sessions;
		});
	} catch {
		sessions = undefined;
	}

	// The legacy loop's executor bodies, reused verbatim. The environment is
	// resolved per execution from the calling agent's session, so a dream
	// child always operates on its inherited workspace.
	const executors = createDreamerExecutors(cdb, (exec) => {
		const session = exec?.agent?.session;
		return {
			workspaceRoot: session?.header?.cwd,
			scopePath: sessionMemoryScope(session),
			sessions,
			currentSession: session,
		};
	});

	for (const [toolName, schema] of Object.entries(DREAM_TOOL_SCHEMAS)) {
		ctx.tools.register(defineTool({
			name: toolName,
			description: schema.description,
			parameters: flatSpecFromJsonSchema(schema.parameters),
			output: {
				schema: { type: "json" },
				render: (_args, value) => renderValue(value),
			},
			execute: (args, exec) => executors[toolName](args, exec),
		}));
	}

	ctx.systemPrompt.section({
		name: "dreamer:instruction",
		order: 1600,
		text: DREAMER_INSTRUCTION,
	});
}

export { Config, apply, inject, name };

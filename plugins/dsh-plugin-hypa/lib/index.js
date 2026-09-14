// dsh-plugin-hypa: run bash commands through the Hypa compression runtime.
//
// Hypa (github.com/Hypabolic/Hypa) buffers a command's output, reduces it with
// deterministic reducers and DSL filters, and appends a
// `[hypa: 1200->340 tok, -72%, reducer=dotnet-build]` footer when it saved
// tokens. Integration is transparent to the model: the `bash` tool's own
// definition is shadowed per agent with an identical schema, so the wire
// surface (and therefore the prompt prefix) does not change, and only the
// executed command string differs.
//
// Why a shadow registration and not a hook: DSH's `tools/pre-execute`
// (the Claude-Code PreToolUse analogue) can only allow/deny/ask — it
// deliberately cannot rewrite `exec.arguments`, and `dsh-hooks-claude-code`
// parses `hookSpecificOutput.updatedInput` but logs it without honoring it.
// The supported seam is a scoped registration: `ToolRuntime.view(scope)`
// applies the agent's own layer last, so a per-agent `bash` definition
// shadows the global one. Registrations made from a preset row land in the
// global layer and would collide, which is why this is a host-plane patch row
// that registers through `agent.ctx` on `agent/session-start` — the same
// lifecycle dsh-plugin-tool-gate uses.
//
// Every seam fails open: no hypa binary, no rewrite answer, an unparsed
// decision, a confining sandbox mode, a background job, or a bare shell
// builtin all leave the command exactly as the model wrote it.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import z from "@deepseek-ai/schemastery";

import { createDecider, parseRewriteResult } from "./wrap.js";

/** @module dsh-plugin-hypa */

/** Cordis plugin name used by loader diagnostics. */
const name = "dsh-plugin-hypa";

/** Services required at registration time. */
const inject = ["tools", "systemPrompt"];

const run = promisify(execFile);

const Config = z.object({
	// Master switch; the patch row can disable compression without unloading.
	enabled: z.boolean().default(true),
	// Hypa executable. A bare name resolves through PATH.
	hypaBin: z.string().default("hypa"),
	// Timeout handed to `hypa --timeout-ms` when the model did not set one.
	// Hypa's own default is 30s (10min for package managers), which is far
	// shorter than a harness bash call should die at.
	defaultTimeoutMs: z.number().default(600_000),
	// Cap on the `hypa rewrite` decision call.
	rewriteTimeoutMs: z.number().default(5_000),
	// How long a rewrite decision is reused for the same command string.
	decisionTtlMs: z.number().default(300_000),
	// Sandbox modes compression is allowed under. Hypa records metrics and
	// artifacts under ~/.hypa, so a confined mode would deny its writes and
	// turn a working command into a hypa failure.
	sandboxModes: z.array(z.string()).default(["danger-full-access"]),
	// Tell the model what the `[hypa: ...]` footer means.
	systemPromptNote: z.boolean().default(true),
	sectionOrder: z.number().default(1620),
});

const NOTE = [
	"Bash commands may run through the local Hypa compression runtime.",
	"A result whose output was reduced ends with a footer line",
	"`[hypa: <before>-><after> tok, -<pct>%, reducer=<id>]`; that line is compression metadata, not command output.",
	"The exit status is unchanged, so keep reading the `[exit code: N]` marker.",
	"Commands Hypa classifies as interactive, destructive, or unsafe run unmodified.",
].join(" ");

/** Register the per-agent bash shadow. */
function apply(ctx, config = {}) {
	const resolved = Config(config);

	if (!resolved.enabled) return;

	const warn = (message) => {
		const text = `[hypa] ${message}`;

		if (typeof ctx.logger?.warn === "function") ctx.logger.warn(text); else console.warn(text);
	};

	// Session id -> { agent, disposer }.
	const wrapped = new Map();

	let binaryMissing = false;

	const runRewrite = async (command, cwd) => {
		if (binaryMissing) return undefined;

		try {
			const { stdout } = await run(resolved.hypaBin, ["rewrite", "--json", command], {
				...cwd === undefined ? {} : { cwd },
				timeout: resolved.rewriteTimeoutMs,
				maxBuffer: 1 << 20,
				windowsHide: true,
			});

			return parseRewriteResult(stdout)?.outcome;
		} catch (error) {
			// Passthrough/Deny/Ask exit non-zero WITH a valid JSON decision on
			// stdout, so the rejection payload is parsed before giving up.
			const parsed = parseRewriteResult(error?.stdout);

			if (parsed !== undefined) return parsed.outcome;

			if (error?.code === "ENOENT") {
				if (!binaryMissing) warn(`binary not found (${resolved.hypaBin}); bash runs unmodified`);

				binaryMissing = true;

				return undefined;
			}

			if (error?.killed === true || error?.signal !== null && error?.signal !== undefined) {
				warn(`rewrite timed out after ${resolved.rewriteTimeoutMs}ms; command runs unmodified`);

				return undefined;
			}

			warn(`rewrite failed: ${error?.message ?? String(error)}`);

			return undefined;
		}
	};

	const decide = createDecider({ config: resolved, runRewrite, logger: ctx.logger });

	// The bash tool resolves its standing policy exactly this way; mirroring it
	// keeps the sandbox gate on the same per-call identity.
	const resolveSandboxMode = (exec) => {
		const policy = ctx.get("sandboxPolicy");

		if (policy === undefined) return undefined;

		try {
			const standing = policy.resolve(exec?.agent === undefined ? {} : { session: exec.agent.session });

			return standing?.mode ?? "unknown";
		} catch {
			return "unknown";
		}
	};

	const liveAgent = (sessionId) => {
		try {
			return ctx.get("agents")?.get(sessionId);
		} catch {
			return undefined;
		}
	};

	const disposeEntry = (entry) => {
		try {
			entry.disposer?.();
		} catch {
			/* the owning agent's layer may already be gone (resume race) */
		}
	};

	const wrappedExecute = (base) => async (args, exec) => {
		let decision;

		try {
			decision = await decide({
				command: args?.command,
				cwd: exec?.agent?.session?.header?.cwd,
				background: args?.run_in_background === true,
				timeoutMs: args?.timeoutMs,
				sandboxMode: resolveSandboxMode(exec),
			});
		} catch (error) {
			warn(`decision failed, running the original command: ${error?.message ?? String(error)}`);

			return base.execute(args, exec);
		}

		if (!decision.wrap) return base.execute(args, exec);

		return base.execute({ ...args, command: decision.command }, exec);
	};

	// Shadow the agent's `bash` with an identical definition whose execute
	// substitutes the hypa-wrapped command. The base definition is captured
	// BEFORE registering, because afterwards the agent's own view resolves to
	// the shadow. The global view is preferred: it stays the true base even
	// after this registration.
	const wrapSession = (sessionId, agentHint) => {
		if (sessionId === undefined) return false;

		const agent = agentHint ?? liveAgent(sessionId);

		if (agent === undefined) return false;

		const existing = wrapped.get(sessionId);

		if (existing !== undefined && existing.agent === agent) return true;

		if (existing !== undefined) disposeEntry(existing);

		const agentTools = agent.ctx?.tools;

		if (agentTools === undefined) return false;

		const base = ctx.tools.get("bash") ?? agentTools.get("bash", agent);

		if (base === undefined) return false;

		try {
			const disposer = agentTools.register({ ...base, execute: wrappedExecute(base) });

			wrapped.set(sessionId, { agent, disposer });

			return true;
		} catch (error) {
			warn(`could not shadow bash: ${error?.message ?? String(error)}`);

			return false;
		}
	};

	// Primary path: the agent object arrives directly, fresh or resumed.
	ctx.on("agent/session-start", ({ agent }) => {
		wrapSession(agent?.session?.id, agent);
	});

	// Fresh sessions: the agent may not be composed yet at creation.
	ctx.on("session/created", (session) => {
		wrapSession(session?.id);
	});

	// Fallback for sessions whose agent only becomes reachable later.
	ctx.on("session/event", (session, event) => {
		if (event?.type === "turn/start" || event?.type === "user/message") wrapSession(session?.id);
	});

	ctx.on("session/disposed", (session) => {
		const entry = wrapped.get(session?.id);

		if (entry !== undefined) {
			disposeEntry(entry);

			wrapped.delete(session.id);
		}
	});

	if (resolved.systemPromptNote) {
		ctx.systemPrompt.section({
			name: "hypa:compression",
			order: resolved.sectionOrder,
			text: NOTE,
		});
	}
}

export { Config, apply, inject, name };

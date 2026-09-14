// dsh-plugin-hypa: pure command-wrapping math.
//
// Hypa (github.com/Hypabolic/Hypa) is a local command runner: it buffers a
// command's output, runs it through deterministic reducers and DSL filters,
// and appends a `[hypa: 1200->340 tok, -72%, reducer=dotnet-build]` footer when
// the result actually saved tokens. Its runner has one sharp edge this module
// guards: a SIMPLE command (no shell metacharacters) is spawned as argv
// directly, so a bare shell builtin with no binary on PATH (`type`, `time`,
// `exit`, `source`, ...) fails with `hypa: An error occurred trying to start
// process ...` and exit 1 instead of running. Commands carrying shell syntax
// (pipe, `&&`, `;`, redirect, `$`, backticks, parens) go through a shell and are
// unaffected. `hypa rewrite` classifies a command as Passthrough/Deny/Ask for
// exactly the same reason, so the plugin asks it before wrapping anything.

/** Shell builtins and keywords whose bare use hypa's direct-spawn path cannot run. */
export const SHELL_WORDS = new Set([
	".", ":", "[", "alias", "bg", "bind", "break", "builtin", "caller", "cd",
	"command", "compgen", "complete", "continue", "declare", "dirs", "disown",
	"echo", "enable", "eval", "exec", "exit", "export", "fc", "fg", "getopts",
	"hash", "help", "history", "jobs", "let", "local", "logout", "mapfile",
	"popd", "printf", "pushd", "pwd", "read", "readarray", "readonly", "return",
	"set", "shift", "shopt", "source", "suspend", "test", "time", "times",
	"trap", "type", "typeset", "ulimit", "umask", "unalias", "unset", "wait",
]);

// Characters that force hypa through a shell. Quotes and backslashes are
// included because a quoted word can hide a metacharacter.
const SHELL_SYNTAX = /[|&;()<>$`'"\\\r\n]/;

const SAFE_BIN = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Whether a command string contains shell syntax that makes hypa route it
 * through a shell.
 * @param command - the model-supplied command.
 * @returns true when any shell metacharacter is present.
 */
export function hasShellSyntax(command) {
	return typeof command === "string" && SHELL_SYNTAX.test(command);
}

/**
 * The command's first whitespace-delimited word.
 * @param command - the model-supplied command.
 * @returns the first word, or an empty string.
 */
export function firstWord(command) {
	if (typeof command !== "string") return "";

	const match = /^\s*(\S+)/.exec(command);

	return match === null ? "" : match[1];
}

/**
 * Whether the command is a simple invocation of a shell builtin/keyword, the
 * one shape hypa's direct-spawn path breaks.
 * @param command - the model-supplied command.
 * @returns true when wrapping must be skipped.
 */
export function isBareShellWord(command) {
	return !hasShellSyntax(command) && SHELL_WORDS.has(firstWord(command));
}

/** Whether the command already routes through hypa (never wrap twice). */
export function isHypaCommand(command) {
	const word = firstWord(command);
	const base = word.slice(word.lastIndexOf("/") + 1);

	return base === "hypa" || base === "hypa.exe";
}

/**
 * The first guard that forbids wrapping, or undefined when wrapping is allowed.
 * Pure: it decides nothing that needs I/O.
 * @param command - the model-supplied command.
 * @param options - enabled switch, background flag, and sandbox mode.
 * @returns a human-readable reason, or undefined to continue.
 */
export function skipReason(command, options = {}) {
	if (options.enabled === false) return "disabled by config";

	if (typeof command !== "string" || command.trim().length === 0) return "empty command";

	if (options.background === true) return "background job (streaming output)";

	if (isHypaCommand(command)) return "already a hypa command";

	if (isBareShellWord(command)) return `bare shell builtin "${firstWord(command)}"`;

	return undefined;
}

/** POSIX single-quote a value so no expansion can reach the inner command. */
export function singleQuote(value) {
	return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** Quote a binary path only when it needs it. */
export function quoteBin(bin) {
	return SAFE_BIN.test(bin) ? bin : singleQuote(bin);
}

/**
 * Build the shell command that runs the original command through hypa.
 *
 * The original command is single-quoted, so `$`, backticks, and quotes reach
 * hypa verbatim. `hypa rewrite`'s own rewritten string is deliberately NOT
 * used: it double-quotes the command, which lets the outer shell expand `$`
 * inside it (verified: `grep -n '$foo' file` rewrites to a form that loses the
 * literal `$`).
 * @param args - binary, original command, and the per-call timeout.
 * @returns the command to execute.
 */
export function buildWrappedCommand({ bin, command, timeoutMs }) {
	const parts = [quoteBin(bin)];

	if (Number.isFinite(timeoutMs) && timeoutMs > 0) parts.push("--timeout-ms", String(Math.round(timeoutMs)));

	parts.push("-c", singleQuote(command));

	return parts.join(" ");
}

/**
 * Parse `hypa rewrite --json` output.
 * @param stdout - the process stdout.
 * @returns the decision, or undefined when the payload is not a usable decision.
 */
export function parseRewriteResult(stdout) {
	if (typeof stdout !== "string") return undefined;

	let parsed;

	try {
		parsed = JSON.parse(stdout);
	} catch {
		return undefined;
	}

	if (parsed === null || typeof parsed !== "object") return undefined;

	const outcome = parsed.outcome;

	if (typeof outcome !== "string") return undefined;

	return { outcome, command: typeof parsed.command === "string" ? parsed.command : undefined };
}

/** Whether a hypa rewrite outcome means the command should run through hypa. */
export function outcomeWraps(outcome) {
	return outcome === "Rewritten" || outcome === "GenericWrapper";
}

/**
 * A tiny TTL cache for rewrite decisions. Rewrite is a pure function of the
 * command string plus hypa's config, so a short TTL is safe and saves one
 * process spawn per repeated command.
 * @param options - ttl, entry limit, and clock.
 * @returns get/set/size/clear.
 */
export function createDecisionCache({ ttlMs = 300_000, limit = 512, now = Date.now } = {}) {
	const entries = new Map();

	return {
		get(key) {
			const entry = entries.get(key);

			if (entry === undefined) return undefined;

			if (now() - entry.at > ttlMs) {
				entries.delete(key);

				return undefined;
			}

			return entry.value;
		},
		set(key, value) {
			if (entries.size >= limit) {
				const oldest = entries.keys().next();

				if (oldest.done !== true) entries.delete(oldest.value);
			}

			entries.set(key, { at: now(), value });
		},
		get size() {
			return entries.size;
		},
		clear() {
			entries.clear();
		},
	};
}

/**
 * Build the decide function the plugin calls for every bash invocation.
 *
 * Every failure path fails open: an unreachable, slow, or unparseable hypa
 * leaves the command untouched.
 * @param deps - config, the rewrite runner, a logger, and an optional cache.
 * @returns an async decide({command, cwd, background, timeoutMs, sandboxMode}).
 */
export function createDecider({ config, runRewrite, logger, cache = createDecisionCache({ ttlMs: config.decisionTtlMs }) }) {
	const warn = (message) => logger?.warn?.(`[hypa] ${message}`);

	return async function decide({ command, cwd, background, timeoutMs, sandboxMode }) {
		const skip = skipReason(command, { enabled: config.enabled, background });

		if (skip !== undefined) return { wrap: false, reason: skip };

		if (sandboxMode !== undefined && !config.sandboxModes.includes(sandboxMode)) {
			return { wrap: false, reason: `sandbox mode ${sandboxMode}` };
		}

		let outcome = cache.get(command);

		if (outcome === undefined) {
			outcome = await runRewrite(command, cwd);

			if (outcome === undefined) return { wrap: false, reason: "hypa rewrite unavailable" };

			cache.set(command, outcome);
		}

		if (!outcomeWraps(outcome)) {
			warn(`passthrough ${outcome}: ${command}`);

			return { wrap: false, reason: `hypa outcome ${outcome}` };
		}

		const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : config.defaultTimeoutMs;

		return { wrap: true, command: buildWrappedCommand({ bin: config.hypaBin, command, timeoutMs: effectiveTimeout }) };
	};
}

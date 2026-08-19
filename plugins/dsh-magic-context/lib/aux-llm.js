// Bounded retry for the plugin's auxiliary (non-agent-loop) LLM calls.
//
// The organizer and Dreamer call `ctx.llm.stream()` directly. Such requests do
// NOT carry the agent loop's `markAgentLoopRequest` identity, so the harness's
// retry plugin - which runs on the `agent/request-error` extension point and
// guards with `isAgentLoopRequest` - never sees them, and `LlmRuntime.stream()`
// has no retry of its own. One transient provider failure therefore used to
// destroy a whole compartment generation, even though the same failure class is
// retried automatically for the main agent (observed: gateway `429 Rate limit
// exceeded: tpm (InputTokens)`, nginx `504 Gateway Time-out`, `Connection
// error.`, and completed-but-empty responses).
//
// This module gives those calls the same fail-soft behavior: retry the
// transport/limit classes with exponential backoff and jitter, honor a
// provider-supplied retry delay, and fail closed for everything else.
//
// @module dsh-magic-context/aux-llm
import { BlockAssembler } from "@deepseek-ai/dsh-llm";

/**
 * Failure codes worth another attempt. Deliberately the same set the harness
 * uses for agent-loop requests, plus `STREAM_CLOSED` for a source that ends
 * without any terminal event.
 */
export const RETRYABLE_AUX_CODES = new Set([
	"EMPTY_RESPONSE",
	"RATE_LIMIT",
	"SERVER",
	"TIMEOUT",
	"TRANSPORT",
	"STREAM_CLOSED",
]);

export const DEFAULT_AUX_RETRY = Object.freeze({
	attempts: 3,
	baseDelayMs: 2000,
	maxDelayMs: 60000,
	jitterRatio: 0.2,
	// A truncated answer is deterministic at a fixed cap, so growing the cap is
	// the only recovery that can succeed. It is a separate budget from the
	// transient-failure attempts: no backoff (nothing is throttling us) and a
	// tight bound, because every attempt re-sends the whole range.
	growAttempts: 1,
	growFactor: 2,
});

/**
 * Largest output cap this target will accept, when the runtime can tell us.
 *
 * `defaultMaxTokens` is the adapter-configured per-request cap, so it is both a
 * safe ceiling for growth and the honest upper bound for a hand-picked route
 * whose real limit is much smaller than a modern model's (a profile may declare
 * a model with only 4k-8k of output).
 * @returns the cap, or undefined when the runtime cannot resolve it.
 */
export async function resolveAuxMaxTokens(ctx, provider, model, signal) {
	if (typeof ctx?.llm?.resolveModelInfo !== "function") return undefined;
	try {
		const info = await ctx.llm.resolveModelInfo(provider, model, signal);
		const cap = info?.defaultMaxTokens;
		return typeof cap === "number" && Number.isFinite(cap) && cap > 0 ? Math.trunc(cap) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Whether this exact route accepts image content.
 *
 * `inputModalities` is explicit negative capability when present and absent
 * when unknown, so an unknown route reports `undefined` and the caller decides
 * whether to try. A text-only organizer must never fail a whole generation just
 * because the range happens to contain a screenshot.
 * @returns true/false when declared, undefined when the runtime cannot tell.
 */
export async function resolveAuxImageSupport(ctx, provider, model, signal) {
	if (typeof ctx?.llm?.resolveModelInfo !== "function") return undefined;
	try {
		const info = await ctx.llm.resolveModelInfo(provider, model, signal);
		const modalities = info?.inputModalities;
		if (modalities === undefined || modalities === null) return undefined;
		return Array.from(modalities).includes("image");
	} catch {
		return undefined;
	}
}

/** Clamp a requested output cap to the target's ceiling when one is known. */
export function clampMaxTokens(requested, ceiling) {
	const wanted = typeof requested === "number" && Number.isFinite(requested) && requested > 0 ? Math.trunc(requested) : undefined;
	if (wanted === undefined) return ceiling;
	return ceiling === undefined ? wanted : Math.min(wanted, ceiling);
}

function delay(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted === true) {
			reject(signal.reason ?? new Error("aux LLM retry aborted"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener?.("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason ?? new Error("aux LLM retry aborted"));
		};
		signal?.addEventListener?.("abort", onAbort, { once: true });
	});
}

/**
 * Map a terminal stream finish to the error an auxiliary caller must see.
 * @param finish - the assembler's terminal finish reason.
 * @returns an error carrying `code`, or undefined when the output is usable.
 */
export function auxFinishError(finish) {
	switch (finish?.kind) {
		case "error":
		case "aborted": {
			const error = new Error(finish.failure.message);
			error.code = finish.failure.code;
			if (finish.failure.providerRetryAfterMs !== undefined) error.providerRetryAfterMs = finish.failure.providerRetryAfterMs;
			if (finish.kind === "aborted") error.aborted = true;
			return error;
		}
		case "max-tokens": {
			const error = new Error("auxiliary model output truncated at the token cap");
			error.code = "MAX_TOKENS";
			return error;
		}
		default:
			return undefined;
	}
}

/** Longest normalized failure text a caller should put in front of a model. */
export const MAX_AUX_REASON_CHARS = 240;

/**
 * Reduce one provider failure message to a short, inert diagnostic.
 *
 * Provider and gateway failures are not always JSON: a WAF in front of the
 * endpoint answers with a full HTML error page, script tags and all. Such text
 * must never reach a UI notice verbatim, because a notice is durable
 * conversation content - it would ride every later request, feed the next
 * organizer attempt its own error page, and can itself trip the content
 * inspection that produced the block in the first place. The DB column is
 * bounded but equally unreadable, so both sides use this form.
 * @param message - raw failure text.
 * @returns a single-line diagnostic, HTML reduced to its status and title.
 */
export function describeAuxFailure(message) {
	const raw = typeof message === "string" ? message : String(message ?? "");
	const flat = raw.replace(/\s+/gu, " ").trim();
	if (flat.length === 0) return "unknown auxiliary failure";
	const markup = /<!doctype|<html|<script|<\/[a-z]+>/iu.test(flat);
	if (!markup) return flat.length > MAX_AUX_REASON_CHARS ? `${flat.slice(0, MAX_AUX_REASON_CHARS)}…` : flat;
	const status = /(^|[^\d])(\d{3})([^\d]|$)/u.exec(flat)?.[2];
	const title = /<title[^>]*>([^<]{1,80})<\/title>/iu.exec(flat)?.[1]?.trim();
	const parts = [
		status === undefined ? undefined : `HTTP ${status}`,
		"provider returned an HTML error page",
		title === undefined || title.length === 0 || title === status ? undefined : `title: ${title}`,
	].filter((part) => part !== undefined);
	return parts.join("; ");
}

/** Whether one mapped auxiliary failure deserves another attempt. */
export function isRetryableAuxError(error, signal) {
	if (signal?.aborted === true) return false;
	if (error?.aborted === true) return false;
	return RETRYABLE_AUX_CODES.has(error?.code);
}

/** Backoff for one attempt: provider guidance first, else exponential + jitter. */
export function auxRetryDelayMs(error, attempt, policy = DEFAULT_AUX_RETRY, random = Math.random) {
	const provided = error?.providerRetryAfterMs;
	if (typeof provided === "number" && Number.isFinite(provided) && provided > 0) {
		return Math.min(provided, policy.maxDelayMs);
	}
	const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
	return Math.round(exponential * (1 + policy.jitterRatio * random()));
}

/**
 * Run one auxiliary model call with bounded retry and return its assembler.
 *
 * @param ctx - host context with the `llm` service (`ctx.logger` optional).
 * @param options - the full `ctx.llm.stream()` request.
 * @param opts - { attempts, baseDelayMs, maxDelayMs, jitterRatio, growAttempts,
 *   growFactor, maxTokensCeiling, signal, label, onRetry, onGrow, random }.
 * @returns the BlockAssembler holding a usable response.
 * @throws the mapped failure when it is not retryable or attempts run out.
 */
export async function streamAux(ctx, options, opts = {}) {
	const policy = {
		attempts: opts.attempts ?? DEFAULT_AUX_RETRY.attempts,
		baseDelayMs: opts.baseDelayMs ?? DEFAULT_AUX_RETRY.baseDelayMs,
		maxDelayMs: opts.maxDelayMs ?? DEFAULT_AUX_RETRY.maxDelayMs,
		jitterRatio: opts.jitterRatio ?? DEFAULT_AUX_RETRY.jitterRatio,
		growAttempts: opts.growAttempts ?? DEFAULT_AUX_RETRY.growAttempts,
		growFactor: opts.growFactor ?? DEFAULT_AUX_RETRY.growFactor,
	};
	const attempts = Math.max(1, Math.trunc(policy.attempts));
	const label = opts.label ?? "auxiliary";
	const signal = opts.signal;
	let request = options;
	let grown = 0;
	for (let attempt = 1; ; attempt += 1) {
		signal?.throwIfAborted?.();
		const assembler = new BlockAssembler();
		for await (const chunk of ctx.llm.stream(request)) assembler.push(chunk);
		const error = auxFinishError(assembler.finish);
		if (error === undefined) return assembler;
		// Truncation: raise the cap instead of repeating an identical request.
		// A model that thinks before answering spends this budget on reasoning
		// first, so a cap that fits the answer can still truncate before the
		// answer starts - which is exactly how a large range fails every time.
		if (error.code === "MAX_TOKENS" && grown < Math.max(0, Math.trunc(policy.growAttempts)) && signal?.aborted !== true) {
			const ceiling = opts.maxTokensCeiling;
			const current = request.maxTokens;
			const wanted = typeof current === "number" && Number.isFinite(current) && current > 0
				? Math.trunc(current * policy.growFactor)
				: undefined;
			const next = clampMaxTokens(wanted, ceiling);
			if (next !== undefined && (current === undefined || next > current)) {
				grown += 1;
				request = { ...request, maxTokens: next };
				ctx.logger?.warn?.(`${label} output truncated at ${current} tokens; retrying with ${next}`);
				opts.onGrow?.({ from: current, to: next, error });
				continue;
			}
		}
		if (attempt >= attempts || !isRetryableAuxError(error, signal)) throw error;
		const waitMs = auxRetryDelayMs(error, attempt, policy, opts.random ?? Math.random);
		ctx.logger?.warn?.(
			`${label} request failed (${error.code}): ${error.message}; retry ${attempt}/${attempts - 1} in ${waitMs}ms`,
		);
		opts.onRetry?.({ attempt, attempts, waitMs, error });
		await delay(waitMs, signal);
	}
}

// Exact token accounting through the optional Rust `tokenizers` binding.
//
// The host meter prices every content block at four characters per token
// (`@deepseek-ai/dsh-token-meter/lib/types/estimate.js`), which undercounts CJK
// material by roughly 2x and overcounts English/code by ~15%. This module
// replaces that density model with the model family's real BPE vocabulary:
// measured on a live DeepSeek session, Chinese summaries run at ~0.51
// tokens/char (the heuristic is 2.06x low) while English/code runs at ~0.22
// (the heuristic is 1.19x high), so no constant factor can correct it.
//
// Everything is optional and fails open: without the binding or the vocabulary
// file every count returns null and callers keep the host heuristic.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Per-block structural overhead, matching the host estimator's accounting. */
const BLOCK_OVERHEAD = 4;
/** Role-field framing overhead added to every priced message. */
const ROLE_OVERHEAD = 4;
/** Text cache ceiling; surface nodes are immutable so hits dominate. */
const CACHE_MAX_CHARS = 8 * 1024 * 1024;
/** How long an unavailable counter waits before re-probing for the binding. */
const LOAD_RETRY_MS = 60000;

export const DEFAULT_TOKENIZER_FILE = "deepseek.json";
export const TOKENIZERS_INSTALL_COMMAND =
	"dsh plugin --profile web add tokenizers";

/** Vocabulary path under the plugin's home directory. */
export function tokenizerPath(homeDir, file = DEFAULT_TOKENIZER_FILE) {
	return join(homeDir, "magic-context", "tokenizers", file);
}

function createTextCache() {
	const entries = new Map();
	let chars = 0;
	return {
		get(key) {
			return entries.get(key);
		},
		set(key, value) {
			if (entries.has(key)) {
				entries.delete(key);
				chars -= key.length;
			}
			entries.set(key, value);
			chars += key.length;
			while (chars > CACHE_MAX_CHARS && entries.size > 0) {
				const oldest = entries.keys().next().value;
				chars -= oldest.length;
				entries.delete(oldest);
			}
			return value;
		},
	};
}

/**
 * Create one process-wide counter. Loading is lazy and single-flight; a missing
 * binding or vocabulary leaves the counter permanently unavailable rather than
 * throwing, because every caller has a working heuristic fallback.
 *
 * @param opts - { homeDir, file?, logger? }.
 */
export function createTokenCounter({ homeDir, file = DEFAULT_TOKENIZER_FILE, logger } = {}) {
	const cache = createTextCache();
	let tokenizer = null;
	let state = "idle";
	let error;
	let loadPromise = null;
	let attemptedAt = 0;

	async function load() {
		if (state === "ready") return true;
		// A missing binding or vocabulary is a setup state, not a verdict: the
		// fetch script or the install command can land while this process runs,
		// so an unavailable counter retries instead of latching off forever.
		if (state === "unavailable" && Date.now() - attemptedAt < LOAD_RETRY_MS) return false;
		if (loadPromise !== null) return loadPromise;
		const path = tokenizerPath(homeDir, file);
		attemptedAt = Date.now();
		loadPromise = (async () => {
			try {
				statSync(path);
			} catch {
				state = "unavailable";
				error = `vocabulary file not found at ${path} (run scripts/fetch-tokenizer.mjs)`;
				return false;
			}
			try {
				const module = await import("tokenizers");
				tokenizer = module.Tokenizer.fromFile(path);
				state = "ready";
				error = undefined;
				return true;
			} catch (cause) {
				state = "unavailable";
				error = cause?.code === "ERR_MODULE_NOT_FOUND"
					? `the tokenizers binding is not installed (${TOKENIZERS_INSTALL_COMMAND})`
					: `tokenizer load failed: ${cause instanceof Error ? cause.message : String(cause)}`;
				logger?.warn?.(`dsh-magic-context: exact token accounting disabled - ${error}`);
				return false;
			}
		})();
		return loadPromise;
	}

	/** Encode one string. Returns null when the counter is unavailable. */
	async function countText(text) {
		if (typeof text !== "string" || text.length === 0) return 0;
		const cached = cache.get(text);
		if (cached !== undefined) return cached;
		if (!(await load())) return null;
		try {
			const encoding = await tokenizer.encode(text, null);
			return cache.set(text, encoding.getIds().length);
		} catch (cause) {
			logger?.warn?.(`dsh-magic-context: tokenizer encode failed (${cause instanceof Error ? cause.message : String(cause)})`);
			return null;
		}
	}

	/** Encode many strings, reusing the cache and batching the misses. */
	async function countTexts(texts) {
		const out = new Array(texts.length).fill(null);
		const pending = [];
		for (const [index, text] of texts.entries()) {
			if (typeof text !== "string" || text.length === 0) {
				out[index] = 0;
				continue;
			}
			const cached = cache.get(text);
			if (cached !== undefined) out[index] = cached;
			else pending.push({ index, text });
		}
		if (pending.length === 0) return out;
		if (!(await load())) return out;
		try {
			const encodings = await tokenizer.encodeBatch(pending.map((item) => item.text));
			for (const [position, item] of pending.entries()) {
				const count = encodings[position].getIds().length;
				cache.set(item.text, count);
				out[item.index] = count;
			}
		} catch (cause) {
			logger?.warn?.(`dsh-magic-context: tokenizer batch encode failed (${cause instanceof Error ? cause.message : String(cause)})`);
		}
		return out;
	}

	/** Price one canonical message the way the host estimator structures it. */
	async function countMessage(message) {
		if (message === null || message === undefined) return 0;
		const blocks = Array.isArray(message.content) ? message.content : [];
		const texts = [];
		const arms = [];
		const walk = (list) => {
			for (const block of list) {
				switch (block?.type) {
					case "text":
					case "reasoning":
						arms.push({ kind: "one", overhead: BLOCK_OVERHEAD, slot: texts.length });
						texts.push(block.text ?? "");
						break;
					case "tool-call":
						arms.push({ kind: "two", overhead: BLOCK_OVERHEAD, slot: texts.length });
						texts.push(block.name ?? "");
						texts.push(block.arguments ?? "");
						break;
					case "tool-result":
						arms.push({ kind: "marker" });
						walk(Array.isArray(block.content) ? block.content : []);
						arms.push({ kind: "close", overhead: BLOCK_OVERHEAD });
						break;
					default:
						arms.push({ kind: "structural", block });
						break;
				}
			}
		};
		walk(blocks);
		const counts = await countTexts(texts);
		let total = ROLE_OVERHEAD;
		let cursor = 0;
		for (const arm of arms) {
			if (arm.kind === "one" || arm.kind === "two") {
				const width = arm.kind === "two" ? 2 : 1;
				for (let index = 0; index < width; index += 1) {
					const value = counts[cursor + index];
					if (value === null) return null;
					total += value;
				}
				cursor += width;
				total += arm.overhead;
			} else if (arm.kind === "close") {
				total += arm.overhead;
			} else if (arm.kind === "structural") {
				total += BLOCK_OVERHEAD + Math.ceil(JSON.stringify(arm.block).length / 4);
			}
		}
		if (cursor !== counts.length) return null;
		return total;
	}

	/** Price a list of messages, skipping any the tokenizer cannot express. */
	async function countMessages(messages) {
		const out = [];
		for (const message of messages) out.push(await countMessage(message));
		return out;
	}

	return {
		countText,
		countTexts,
		countMessage,
		countMessages,
		status() {
			return { state, file: tokenizerPath(homeDir, file), error, ready: state === "ready" };
		},
		warm() {
			return load();
		},
	};
}

/** Stable cache key for a text that may be large (surface nodes, tool schemas). */
export function textKey(text) {
	return text.length <= 4096 ? text : createHash("sha1").update(text).digest("hex");
}

/** Read a vocabulary file size without loading it (setup diagnostics). */
export function vocabularyBytes(path) {
	try {
		return readFileSync(path).byteLength;
	} catch {
		return 0;
	}
}

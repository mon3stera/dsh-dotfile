// dsh-magic-context auxiliary-call resilience smoke test.
//
// Covers the three failure paths that used to destroy a compartment
// generation silently: no retry for transient provider failures on
// non-agent-loop calls, fail-closed XML validation for pure escaping
// mistakes, and a `failed` row with no recorded reason.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	auxFinishError,
	auxRetryDelayMs,
	clampMaxTokens,
	describeAuxFailure,
	isRetryableAuxError,
	MAX_AUX_REASON_CHARS,
	RETRYABLE_AUX_CODES,
	streamAux,
} from "/home/mon3tr/.dsh/profiles/node_modules/dsh-magic-context/lib/aux-llm.js";
import {
	DEFAULT_ORGANIZER_MAX_TOKENS,
	extractOutputDocument,
	stripImageContent,
	sanitizeOrganizerOutput,
	summarizeCompartment,
	validateOrganizerOutput,
} from "/home/mon3tr/.dsh/profiles/node_modules/dsh-magic-context/lib/summarizer.js";
import { openDatabase } from "/home/mon3tr/.dsh/profiles/node_modules/dsh-magic-context/lib/db.js";

let failed = 0;
const check = (label, ok) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
	if (!ok) failed += 1;
};

const compartmentXml = (facts) => [
	"<output>",
	"  <compartments>",
	"    <compartment title=\"Retry work\" episode_type=\"investigation\">",
	"      <objective>Make auxiliary calls survive a flaky gateway.</objective>",
	"      <continuity>Extends the gateway investigation.</continuity>",
	"      <work_completed><item>Added bounded retry.</item></work_completed>",
	"      <decisions><decision>Retry only transport and limit classes.</decision></decisions>",
	"      <current_state><item>Retry helper is shared.</item></current_state>",
	"      <verification><check status=\"passed\">Smoke test passed.</check></verification>",
	"      <open_items><none/></open_items>",
	"      <user_constraints><none/></user_constraints>",
	"      <anchors><file>plugins/dsh-magic-context/lib/aux-llm.js</file></anchors>",
	"    </compartment>",
	"  </compartments>",
	`  <facts>${facts}</facts>`,
	"</output>",
].join("\n");

const validXml = compartmentXml("<fact importance=\"7\">Retry covers RATE_LIMIT.</fact>");
// The observed Opus 5 failure: a raw tag inside a text-only leaf.
const unescapedXml = compartmentXml("<fact importance=\"7\">package.json <name> must match the package & bundle.</fact>");

// -- retry classification ----------------------------------------------------
{
	check("retryable set covers the observed gateway classes", ["RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT", "EMPTY_RESPONSE"].every((code) => RETRYABLE_AUX_CODES.has(code)));
	const rateLimit = auxFinishError({ kind: "error", failure: { code: "RATE_LIMIT", message: "Rate limit exceeded: tpm (InputTokens)", providerRetryAfterMs: 4000 } });
	check("finish error carries code and provider delay", rateLimit.code === "RATE_LIMIT" && rateLimit.providerRetryAfterMs === 4000);
	check("rate limit is retryable", isRetryableAuxError(rateLimit));
	check("provider delay wins over backoff", auxRetryDelayMs(rateLimit, 1) === 4000);
	const backoff = auxRetryDelayMs({ code: "SERVER" }, 3, { attempts: 3, baseDelayMs: 1000, maxDelayMs: 60000, jitterRatio: 0.2 }, () => 0);
	check("backoff grows exponentially", backoff === 4000);
	const capped = auxRetryDelayMs({ code: "SERVER" }, 9, { attempts: 3, baseDelayMs: 1000, maxDelayMs: 5000, jitterRatio: 0 }, () => 0);
	check("backoff is capped", capped === 5000);
	check("auth failure is not retryable", !isRetryableAuxError(auxFinishError({ kind: "error", failure: { code: "AUTH", message: "unauthorized client detected" } })));
	check("abort is not retryable", !isRetryableAuxError(auxFinishError({ kind: "aborted", failure: { code: "ABORTED", message: "aborted" } })));
	check("truncation is not retryable", !isRetryableAuxError(auxFinishError({ kind: "max-tokens" })));
	check("usable finish maps to no error", auxFinishError({ kind: "stop" }) === undefined);
	const signal = { aborted: true };
	check("cancelled work stops retrying", !isRetryableAuxError({ code: "SERVER" }, signal));
}

// -- streamAux retries a transient failure, then fails closed ----------------
{
	let calls = 0;
	const warnings = [];
	const ctx = {
		logger: { warn: (message) => warnings.push(message) },
		llm: {
			async *stream() {
				calls += 1;
				if (calls < 3) {
					yield { type: "finish", reason: { kind: "error", failure: { code: "SERVER", message: "504 Gateway Time-out" } } };
					return;
				}
				yield { type: "text-delta", text: "recovered" };
			},
		},
	};
	const assembler = await streamAux(ctx, {}, { attempts: 3, baseDelayMs: 1, maxDelayMs: 2, label: "test" });
	const text = assembler.blocks().filter((block) => block.type === "text").map((block) => block.text).join("");
	check("streamAux retries a transient failure", calls === 3 && text === "recovered");
	check("streamAux logs each retry", warnings.length === 2 && warnings[0].includes("SERVER"));

	let exhausted = 0;
	let thrown;
	try {
		await streamAux({
			llm: {
				async *stream() {
					exhausted += 1;
					yield { type: "finish", reason: { kind: "error", failure: { code: "RATE_LIMIT", message: "tpm (InputTokens)" } } };
				},
			},
		}, {}, { attempts: 2, baseDelayMs: 1, maxDelayMs: 1 });
	} catch (error) {
		thrown = error;
	}
	check("streamAux stops at the attempt cap", exhausted === 2 && thrown?.code === "RATE_LIMIT");

	let single = 0;
	let fatal;
	try {
		await streamAux({
			llm: {
				async *stream() {
					single += 1;
					yield { type: "finish", reason: { kind: "error", failure: { code: "INVALID_REQUEST", message: "bad request" } } };
				},
			},
		}, {}, { attempts: 5, baseDelayMs: 1 });
	} catch (error) {
		fatal = error;
	}
	check("streamAux does not retry a fatal class", single === 1 && fatal?.code === "INVALID_REQUEST");
}

// -- local XML repair --------------------------------------------------------
{
	check("strict validation still rejects raw tags", !validateOrganizerOutput(unescapedXml).ok);
	const sanitized = sanitizeOrganizerOutput(unescapedXml);
	const revalidated = validateOrganizerOutput(sanitized);
	check("sanitizer repairs an unescaped leaf tag", revalidated.ok);
	check("sanitizer keeps the literal text", revalidated.ok && revalidated.facts[0].text.includes("<name>") && revalidated.facts[0].text.includes("& bundle"));
	check("sanitizer leaves valid documents alone", sanitizeOrganizerOutput(validXml) === validXml);
	check("sanitizer keeps known structure", sanitizeOrganizerOutput(unescapedXml).includes("<facts>"));
	const fenced = ["Here is the result:", "```xml", validXml, "```"].join("\n");
	check("fenced output is unwrapped", validateOrganizerOutput(sanitizeOrganizerOutput(fenced)).ok);
	check("extractOutputDocument keeps a bare document", extractOutputDocument(validXml) === validXml);
	check("extractOutputDocument passes through rootless text", extractOutputDocument("no document here") === "no document here");
	const structural = "<output><compartments><compartment title=\"Broken\" episode_type=\"feature\"><objective>Only objective</objective></compartment></compartments><facts><none/></facts></output>";
	check("sanitizer never invents structure", !validateOrganizerOutput(sanitizeOrganizerOutput(structural)).ok);
	// A leaf whose text contains its own closing tag stays unrepairable by design.
	const pathological = compartmentXml("<fact importance=\"5\">text </fact> more</fact>");
	check("sanitizer defers pathological input to the model", !validateOrganizerOutput(sanitizeOrganizerOutput(pathological)).ok);
}

// -- summarizeCompartment: retry, local repair, no extra model call ----------
{
	const session = {
		id: "aux-session",
		requestHeader: () => ({ system: "sys", tools: [], config: { provider: "p", model: "m" } }),
		events: { 1: { type: "user/message", data: { content: [{ type: "text", text: "work" }] } } },
		deriveEventMessage: (event) => ({ role: "user", content: event.data.content }),
	};
	const cdb = {
		skippedSeqs: () => new Set(),
		allInjectableMemories: () => [],
		activeCompartments: () => [],
		setCompartmentSummary: () => {},
		insertFact: () => {},
	};
	const args = { session, compartment: { id: 1 }, range: { shadowedSeqs: [1] }, scopePath: "/workspace", target: { provider: "p", model: "m" }, retry: { baseDelayMs: 1, maxDelayMs: 2 } };
	// A range that contains a pasted screenshot, as any real session may.
	const imageSession = {
		...session,
		events: { 1: { type: "user/message", data: { content: [{ type: "text", text: "look at this" }, { type: "image", source: { kind: "base64", data: "AAA", mediaType: "image/png" } }] } } },
	};

	let organizerCalls = 0;
	const summarized = await summarizeCompartment({
		llm: {
			async *stream() {
				organizerCalls += 1;
				if (organizerCalls === 1) {
					yield { type: "finish", reason: { kind: "error", failure: { code: "RATE_LIMIT", message: "Rate limit exceeded: tpm (InputTokens)" } } };
					return;
				}
				yield { type: "text-delta", text: validXml };
			},
		},
	}, cdb, args);
	check("organizer survives a throttled attempt", organizerCalls === 2 && summarized.summary.includes("<compartment"));

	let effortOptions;
	await summarizeCompartment({
		llm: {
			async *stream(options) {
				effortOptions = options;
				yield { type: "text-delta", text: validXml };
			},
		},
	}, cdb, { ...args, target: { provider: "codelink", model: "gpt-5.6-luna", reasoningEffort: "low" } });
	check("organizer honors a separate provider/model", effortOptions.provider === "codelink" && effortOptions.model === "gpt-5.6-luna");
	check("organizer forwards the reasoning effort", effortOptions.reasoningEffort === "low");
	let plainOptions;
	await summarizeCompartment({
		llm: {
			async *stream(options) {
				plainOptions = options;
				yield { type: "text-delta", text: validXml };
			},
		},
	}, cdb, { ...args, target: { provider: "p", model: "m", reasoningEffort: "" } });
	check("empty effort stays adapter default", !("reasoningEffort" in plainOptions));

	check("clamp keeps a request under the model cap", clampMaxTokens(32768, 8192) === 8192);
	check("clamp passes a request the model allows", clampMaxTokens(8192, 128000) === 8192);
	check("clamp falls back to the ceiling", clampMaxTokens(undefined, 4096) === 4096);
	check("clamp tolerates an unknown ceiling", clampMaxTokens(8192, undefined) === 8192);

	// --- truncation is recovered by growing the cap, not by repeating -----------
	{
		const caps = [];
		const grown = await summarizeCompartment({
			llm: {
				async *stream(options) {
					caps.push(options.maxTokens);
					if (caps.length === 1) {
						yield { type: "finish", reason: { kind: "max-tokens" } };
						return;
					}
					yield { type: "text-delta", text: validXml };
				},
				resolveModelInfo: async () => ({ defaultMaxTokens: 128000 }),
			},
		}, cdb, { ...args, maxTokens: 8192 });
		check("truncation grows the output cap", JSON.stringify(caps) === JSON.stringify([8192, 16384]));
		check("a grown attempt still produces the summary", grown.summary.length > 0);
	}
	{
		const caps = [];
		let failure;
		try {
			await summarizeCompartment({
				llm: {
					async *stream(options) {
						caps.push(options.maxTokens);
						yield { type: "finish", reason: { kind: "max-tokens" } };
					},
					resolveModelInfo: async () => ({ defaultMaxTokens: 12000 }),
				},
			}, cdb, { ...args, maxTokens: 32768 });
		} catch (error) {
			failure = error;
		}
		check("the model's own cap bounds the request", caps[0] === 12000);
		check("growth stops at the model cap", caps.length === 1 && failure?.code === "MAX_TOKENS");
	}
	{
		let seen;
		await summarizeCompartment({
			llm: {
				async *stream(options) {
					seen = options.maxTokens;
					yield { type: "text-delta", text: validXml };
				},
			},
		}, cdb, { ...args });
		check("an unresolvable cap keeps the configured budget", seen === DEFAULT_ORGANIZER_MAX_TOKENS);
	}

	// --- a text-only organizer must survive images in the range ----------------
	{
		const withImage = [
			{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", source: { kind: "base64", data: "AAA", mediaType: "image/png" } }] },
			{ role: "assistant", content: [{ type: "text", text: "seen" }] },
		];
		const stripped = stripImageContent(withImage);
		check("image blocks are replaced, not dropped", stripped.removed === 1 && stripped.messages[0].content.length === 2);
		check("the placeholder is text", stripped.messages[0].content[1].type === "text" && /image omitted/u.test(stripped.messages[0].content[1].text));
		check("text blocks are untouched", stripped.messages[0].content[0].text === "look" && stripped.messages[1] === withImage[1]);
		check("an image-free list is returned as-is", stripImageContent([withImage[1]]).messages[0] === withImage[1]);
	}
	{
		// A route that declares text-only capability is stripped up front.
		let sent;
		await summarizeCompartment({
			llm: {
				async *stream(options) {
					sent = options.messages;
					yield { type: "text-delta", text: validXml };
				},
				resolveModelInfo: async () => ({ inputModalities: ["text"] }),
			},
		}, cdb, { ...args, session: imageSession });
		const blocks = sent.flatMap((message) => (Array.isArray(message.content) ? message.content : []));
		check("a declared text-only route never sees an image", !blocks.some((block) => block.type === "image"));
		check("the image position is preserved as text", blocks.some((block) => block.type === "text" && /image omitted/u.test(block.text)));
	}
	{
		// An undeclared route is tried as-is, then retried without images.
		const attempts = [];
		await summarizeCompartment({
			llm: {
				async *stream(options) {
					const hasImage = options.messages.some((message) => Array.isArray(message.content) && message.content.some((block) => block.type === "image"));
					attempts.push(hasImage);
					if (hasImage) {
						const error = new Error("The DeepSeek chat-completions adapter does not support image content.");
						error.code = "UNSUPPORTED_CONTENT";
						throw error;
					}
					yield { type: "text-delta", text: validXml };
				},
			},
		}, cdb, { ...args, session: imageSession });
		check("an undeclared route is tried with the image first", attempts[0] === true);
		check("a refusal is recovered by stripping images", attempts.length === 2 && attempts[1] === false);
	}
	{
		// A refusal unrelated to images must still fail.
		let calls = 0;
		let failure;
		try {
			await summarizeCompartment({
				llm: {
					async *stream() {
						calls += 1;
						const error = new Error("model does not exist");
						error.code = "INVALID_REQUEST";
						throw error;
					},
				},
			}, cdb, { ...args, session: imageSession });
		} catch (error) {
			failure = error;
		}
		check("an unrelated refusal is not retried as an image problem", calls === 1 && failure?.code === "INVALID_REQUEST");
	}

	// --- provider failure text is made inert before it becomes durable ---------
	const wafPage = `405 <!doctypehtml><html lang="zh-cn"><title>405</title><body><script>alert(1)</script><textarea id="renderData">{"traceid":"0a0f"}</textarea>`;
	const described = describeAuxFailure(wafPage);
	check("an HTML error page is reduced to a diagnostic", described === "HTTP 405; provider returned an HTML error page");
	check("markup never survives normalization", !/[<>]/u.test(described));
	check("a plain provider message is preserved", describeAuxFailure("Rate limit exceeded: tpm (InputTokens)") === "Rate limit exceeded: tpm (InputTokens)");
	check("normalized text is bounded", describeAuxFailure("x".repeat(4000)).length <= MAX_AUX_REASON_CHARS + 1);
	check("empty failure text still says something", describeAuxFailure("").length > 0);

	let repairCalls = 0;
	const locallyRepaired = await summarizeCompartment({
		llm: {
			async *stream() {
				repairCalls += 1;
				yield { type: "text-delta", text: unescapedXml };
			},
		},
	}, cdb, args);
	check("escaping mistakes cost no extra model call", repairCalls === 1);
	check("locally repaired summary is stored", locallyRepaired.facts[0].text.includes("<name>"));
}

// -- durable failure reason --------------------------------------------------
{
	const home = mkdtempSync(join(tmpdir(), "dsh-aux-db-"));
	try {
		const cdb = openDatabase(home, { embeddingDim: 8 });
		const id = cdb.insertCompartment({
			sessionId: "s1", generation: 1, startSeq: 0, endSeq: 4, startPara: 1, endPara: 5, summary: "", shadowedTokens: 64313,
		});
		cdb.setCompartmentStatus(id, "failed", "Rate limit exceeded: tpm (InputTokens)");
		const row = cdb.compartmentById(id);
		check("failure reason is durable", row.status === "failed" && row.error.includes("tpm (InputTokens)"));
		cdb.setCompartmentStatus(id, "generating");
		check("status-only update keeps the reason", cdb.compartmentById(id).error.includes("tpm"));
		cdb.setCompartmentSummary(id, { summary: "<compartment/>", provider: "p", model: "m" });
		const cleared = cdb.compartmentById(id);
		check("success clears the reason", cleared.status === "ready" && cleared.error === null);
		cdb.setCompartmentStatus(id, "failed", "x".repeat(5000));
		check("stored reason is bounded", cdb.compartmentById(id).error.length === 2000);
		cdb.close?.();
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

// -- engine: durable reason, UI notice, and post-failure cooldown ------------
{
	const tmpHome = mkdtempSync(join(tmpdir(), "dsh-aux-engine-"));
	const savedHome = process.env.DSH_HOME;
	process.env.DSH_HOME = tmpHome;
	try {
		const { ContextEngine } = await import("/home/mon3tr/.dsh/profiles/node_modules/dsh-magic-context/lib/engine.js");
		const warnings = [];
		const fakeCtx = {
			effect: () => () => {},
			logger: { warn: (message) => warnings.push(message) },
			tokenMeter: { estimateMessage: () => 178, measure: () => ({ totalTokens: 0, nodes: [] }) },
			on: () => {},
			systemPrompt: { section: () => {} },
			tools: { register: () => {} },
			reflect: { provide: () => () => {} },
			llm: {
				async *stream() {
					yield { type: "finish", reason: { kind: "error", failure: { code: "RATE_LIMIT", message: "Rate limit exceeded: tpm (InputTokens)" } } };
				},
			},
		};
		const engine = new ContextEngine(fakeCtx, { embeddingDim: 4 });
		const notices = [];
		const rowEvents = [];
		const session = {
			id: "failure-session",
			requestHeader: () => ({ system: "sys", tools: [], config: { provider: "p", model: "m" } }),
			events: { 1: { type: "user/message", data: { content: [{ type: "text", text: "work" }] } } },
			surface: { nodes: [] },
			deriveEventMessage: (event) => ({ role: "user", content: event.data.content }),
			append: (type, data) => { rowEvents.push({ type, data }); return { type, data, seq: rowEvents.length }; },
		};
		const agent = { session, inject: (message) => notices.push(message) };
		const range = { start: 1, end: 1, shadowedSeqs: [1] };

		// Target resolution: an explicit pair overrides the session route, and the
		// effort choice applies to either.
		check("engine falls back to the session route", JSON.stringify(engine._summarizationTarget(session)) === JSON.stringify({ provider: "p", model: "m" }));
		engine.ownConfig.summarizationReasoningEffort = "low";
		check("engine applies effort to the session route", engine._summarizationTarget(session).reasoningEffort === "low");
		engine.ownConfig.summarizationReasoningEffort = "";
		const routed = new ContextEngine(fakeCtx, {
			embeddingDim: 4,
			summarizationProvider: "codelink",
			summarizationModel: "gpt-5.6-luna",
			summarizationReasoningEffort: "low",
			dreamerProvider: "anthropic",
			dreamerModel: "claude-haiku-4-5",
			dreamerReasoningEffort: "minimal",
		});
		const overridden = routed._summarizationTarget(session);
		check("engine prefers the configured organizer model", overridden.provider === "codelink" && overridden.model === "gpt-5.6-luna" && overridden.reasoningEffort === "low");
		check("dreamer keeps an independent target", routed.ownConfig.dreamerConfig.provider === "anthropic" && routed.ownConfig.dreamerConfig.model === "claude-haiku-4-5" && routed.ownConfig.dreamerConfig.reasoningEffort === "minimal");
		check("organizer and dreamer targets stay separate", routed._summarizationTarget(session).model !== routed.ownConfig.dreamerConfig.model);
		routed.cdb.close?.();

		let thrown;
		try {
			await engine._createAndSummarize(agent, range, 64313);
		} catch (error) {
			thrown = error;
		}
		const row = engine.cdb.compartmentById(1);
		check("generation failure still propagates", thrown?.code === "RATE_LIMIT");
		check("failed row records the reason", row.status === "failed" && row.error.includes("tpm (InputTokens)"));
		const runRow = rowEvents.find((event) => event.type === "command/run");
		const doneRow = rowEvents.find((event) => event.type === "command/done");
		const rowText = doneRow?.data.text ?? "";
		check("generation opens one running row", runRow?.data.name === "Context: compartment generation 1" && rowEvents.filter((event) => event.type === "command/run").length === 1);
		check("failure settles that row as an error", doneRow?.data.kind === "error" && doneRow.data.commandId === runRow.data.commandId && rowText.includes("failed after retries: Rate limit exceeded: tpm (InputTokens)"));
		check("failure row reports the deferral", rowText.includes("Consecutive failures: 1") && rowText.includes("deferred"));
		check("failure never reaches the model surface", notices.length === 0 && rowEvents.every((event) => event.type === "command/run" || event.type === "command/done"));
		const first = engine.generateFailures.get(session.id);
		check("first failure arms a cooldown", first.failures === 1 && first.until > Date.now());

		let generationAttempts = 0;
		const originalWindow = engine._contextWindow;
		engine._contextWindow = async () => { generationAttempts += 1; return 200000; };
		await engine._maybeGenerate(agent);
		check("cooldown suppresses the next attempt", generationAttempts === 0);

		engine.generateFailures.set(session.id, { failures: 1, until: Date.now() - 1 });
		await engine._maybeGenerate(agent);
		check("an expired cooldown allows a retry", generationAttempts === 1);
		engine._contextWindow = originalWindow;

		try {
			await engine._createAndSummarize(agent, range, 64313);
		} catch { /* expected */ }
		const second = engine.generateFailures.get(session.id);
		check("consecutive failures widen the cooldown", second.failures === 2 && second.until - Date.now() > first.until - Date.now());

		fakeCtx.llm = { async *stream() { yield { type: "text-delta", text: validXml }; } };
		await engine._createAndSummarize(agent, range, 64313);
		check("a successful generation clears the cooldown", !engine.generateFailures.has(session.id));
		engine.cdb.close?.();
	} finally {
		if (savedHome === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = savedHome;
		rmSync(tmpHome, { recursive: true, force: true });
	}
}

console.log(failed === 0 ? "\nall aux-resilience checks passed" : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);

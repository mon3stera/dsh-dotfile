// dsh-magic-context session-compat smoke test: the replace-marker key-name
// probe across the 0.1.2 -> 0.1.5 boundary. The probe is what keeps landings
// working after the host renamed {start,end} to {startSeq,endSeq}; a wrong
// answer is fatal (the log refuses to fold back), so every branch of the
// decision is pinned here, including both degradation paths.
import {
	probeReplaceOpShape,
	replaceSurfaceOp,
	REPLACE_OP_SHAPES,
	sessionEventAt,
	sessionEventCount,
	sessionEvents,
	setSurfaceValidatorSourceForTesting,
	warmReplaceSurfaceOpProbe,
} from "/home/mon3tr/.dsh/profiles/node_modules/dsh-magic-context/lib/session-compat.js";

let failed = 0;
const check = (label, ok) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
	if (!ok) failed += 1;
};

/** The host's own surface metadata validator (the authority the probe consults). */
const surface = await import("/home/mon3tr/.dsh/profiles/node_modules/@deepseek-ai/dsh-session/lib/types/surface.js");

/** A stand-in for the host validator: accepts exactly the named key shape. */
const validatorAccepting = (shape) => (event) => {
	const op = event.surfaceOp;
	const keys = Object.keys(op).filter((key) => key !== "op");
	const expected = REPLACE_OP_SHAPES[shape];
	if (keys.length !== 2 || !expected.every((key) => keys.includes(key))) {
		throw new Error(`session event "${event.type}" carries an invalid replace surfaceOp`);
	}
	return op;
};

// ── the real installed validator ────────────────────────────────────────────
{
	const shape = await probeReplaceOpShape();
	// The workspace ships 0.1.5: the current names must win. Derive the
	// expectation from the validator instead of hardcoding the host version.
	const acceptsCurrent = (() => {
		try {
			surface.validateSurfaceMetadata({ type: "user/message", seq: 5, surfaceOp: { op: "replace", startSeq: 3, endSeq: 3 } });
			return true;
		} catch {
			return false;
		}
	})();
	check("probe reads the installed validator", shape === (acceptsCurrent ? "current" : "legacy"));

	const op = await replaceSurfaceOp(3, 8);
	check("marker carries both endpoints", op.op === "replace" && (op.start ?? op.startSeq) === 3 && (op.end ?? op.endSeq) === 8);
	let accepted = false;
	let validationError;
	try {
		surface.validateSurfaceMetadata({ type: "user/message", seq: 9, surfaceOp: op });
		accepted = true;
	} catch (error) {
		validationError = error;
	}
	check(
		`produced marker passes the host validator${accepted ? "" : ` (${validationError?.message})`}`,
		accepted,
	);
	check("exactly one key shape is present", Object.keys(op).length === 3 && (op.start === undefined) !== (op.startSeq === undefined));
}

// ── both decided branches, via the validator stub ───────────────────────────
{
	check("stub: current-only validator -> current", (await probeReplaceOpShape(async () => validatorAccepting("current"))) === "current");
	check("stub: legacy-only validator -> legacy", (await probeReplaceOpShape(async () => validatorAccepting("legacy"))) === "legacy");
	// Both accepted: no rename signal at all, so keep what 0.1.2 wrote.
	check("stub: permissive validator -> legacy", (await probeReplaceOpShape(async () => () => undefined)) === "legacy");
	// Neither accepted: not this validator, not this rename.
	check("stub: rejecting validator -> legacy", (await probeReplaceOpShape(async () => () => { throw new Error("nope"); })) === "legacy");
	// No `./surface` subpath (a pre-0.1.5 install) and a loader that itself blows up.
	check("stub: no validator -> legacy", (await probeReplaceOpShape(async () => undefined)) === "legacy");
	check("stub: loader throws -> legacy", (await probeReplaceOpShape(async () => { throw new Error("ERR_MODULE_NOT_FOUND"); })) === "legacy");
}

// ── source override + memoization ───────────────────────────────────────────
{
	let calls = 0;
	setSurfaceValidatorSourceForTesting(async () => {
		calls += 1;
		return validatorAccepting("current");
	});
	const [a, b] = await Promise.all([replaceSurfaceOp(1, 2), replaceSurfaceOp(3, 4)]);
	check("override drives the shape", a.startSeq === 1 && a.endSeq === 2 && b.startSeq === 3 && b.endSeq === 4);
	await replaceSurfaceOp(5, 6);
	check("probe runs once per process", calls === 1);
	await warmReplaceSurfaceOpProbe();
	check("warm-up is memoized and inert", calls === 1);

	// A throwing loader must not reject the marker builder or poison the memo.
	setSurfaceValidatorSourceForTesting(async () => { throw new Error("boom"); });
	const fallback = await warmReplaceSurfaceOpProbe().then(() => replaceSurfaceOp(7, 9));
	check("loader failure degrades to the legacy names", fallback.start === 7 && fallback.end === 9 && fallback.startSeq === undefined);
	setSurfaceValidatorSourceForTesting(undefined);
	const restored = await replaceSurfaceOp(10, 11);
	check("reset re-probes the real validator", restored.op === "replace" && (restored.startSeq ?? restored.start) === 10);
}

// ── event accessors (the other half of the compat seam) ─────────────────────
{
	const events = [{ seq: 0, type: "turn/start" }, { seq: 1, type: "user/message" }, { seq: 2, type: "turn/end" }];
	const modern = { eventAt: (seq) => events[seq] };
	check("eventAt session reads by seq", sessionEventAt(modern, 1).type === "user/message" && sessionEventCount(modern) === 3);
	check("eventAt session materializes", sessionEvents(modern).map((e) => e.seq).join(",") === "0,1,2");
	const legacy = { events };
	check("events-array session still works", sessionEvents(legacy).length === 3 && sessionEventCount(legacy) === 3);
	check("empty session is not a crash", sessionEventCount({}) === 0 && sessionEvents({}).length === 0);

	// A sparse log (eventAt returns undefined past the end) must not loop forever.
	const sparse = { eventAt: (seq) => (seq < 2 ? { seq } : undefined) };
	check("sparse log stops at the first hole", sessionEventCount(sparse) === 2);
}

if (failed > 0) {
	console.error(`${failed} assertion(s) failed`);
	process.exit(1);
}
console.log("dsh-context session-compat smoke: OK");

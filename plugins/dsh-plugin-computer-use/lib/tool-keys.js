// desktop_key: keyboard input. Text and keysym-based combos go through wtype
// (virtual-keyboard protocol; niri registers it unrestricted, and wtype
// uploads its own keymap so Unicode/CJK typing works). A ydotool fallback
// (raw evdev keycodes, ASCII-oriented) covers setups without wtype.
import { defineTool } from "@deepseek-ai/dsh-tools";

import { runFileOrThrow } from "./exec.js";
import { sessionEnv } from "./env.js";

/** @module dsh-plugin-computer-use/tool-keys */

/** Modifier alias → xkb modifier name for wtype. */
const WTYPE_MODIFIERS = {
	ctrl: "ctrl",
	control: "ctrl",
	alt: "alt",
	option: "alt",
	shift: "shift",
	super: "logo",
	meta: "logo",
	logo: "logo",
	win: "logo",
	cmd: "logo",
};

/** Keysym aliases the model is likely to produce. */
const KEYSYM_ALIASES = {
	esc: "Escape",
	return: "Return",
	enter: "Return",
	del: "Delete",
	backspace: "BackSpace",
	pageup: "Prior",
	pagedown: "Next",
	prtsc: "Print",
	space: "space",
	spacebar: "space",
};

/** evdev keycodes for the ydotool fallback (US QWERTY). */
export const KEYCODES = {
	esc: 1, escape: 1,
	1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9, 9: 10, 0: 11,
	minus: 12, equal: 13, backspace: 14,
	tab: 15,
	q: 16, w: 17, e: 18, r: 19, t: 20, y: 21, u: 22, i: 23, o: 24, p: 25,
	bracketleft: 26, bracketright: 27,
	enter: 28, return: 28,
	ctrl: 29, control: 29,
	a: 30, s: 31, d: 32, f: 33, g: 34, h: 35, j: 36, k: 37, l: 38,
	semicolon: 39, apostrophe: 40, grave: 41,
	shift: 42,
	backslash: 43,
	z: 44, x: 45, c: 46, v: 47, b: 48, n: 49, m: 50,
	comma: 51, dot: 52, slash: 53,
	alt: 56,
	space: 57,
	capslock: 58,
	f1: 59, f2: 60, f3: 61, f4: 62, f5: 63, f6: 64, f7: 65, f8: 66, f9: 67, f10: 68,
	numlock: 69,
	f11: 87, f12: 88,
	home: 102, up: 103, pageup: 104,
	left: 105, right: 106,
	end: 107, down: 108, pagedown: 109,
	insert: 110, delete: 111,
	super: 125, meta: 125, logo: 125, win: 125,
};

/** Parse "ctrl+shift+a" into `["ctrl", "shift"]` and `"a"`. */
export function parseCombo(combo) {
	const parts = String(combo).split("+").map((part) => part.trim().toLowerCase()).filter((part) => part.length > 0);
	if (parts.length === 0) throw new Error('combo is empty; use forms like "ctrl+shift+a" or "Return"');
	const key = parts.pop();
	const modifiers = [];
	for (const part of parts) {
		const modifier = WTYPE_MODIFIERS[part];
		if (modifier === undefined) throw new Error(`unknown modifier "${part}" in combo "${combo}"`);
		modifiers.push(modifier);
	}
	return { modifiers, key };
}

/** wtype argv for one combo: press modifiers, tap key, release modifiers. */
export function wtypeComboArgs(combo) {
	const { modifiers, key } = parseCombo(combo);
	const keysym = KEYSYM_ALIASES[key] ?? key;
	const argv = [];
	for (const modifier of modifiers) argv.push("-M", modifier);
	argv.push("-P", keysym, "-p", keysym);
	for (const modifier of [...modifiers].reverse()) argv.push("-m", modifier);
	return argv;
}

/** ydotool argv (raw keycodes) for one combo. */
export function ydotoolComboArgs(combo) {
	const { modifiers, key } = parseCombo(combo);
	const resolved = KEYSYM_ALIASES[key] ?? key;
	const keycode = KEYCODES[resolved];
	if (keycode === undefined) throw new Error(`no ydotool keycode for "${key}"; use wtype transport for keysyms`);
	const events = modifiers.map((modifier) => {
		const code = KEYCODES[modifier];
		if (code === undefined) throw new Error(`no ydotool keycode for modifier "${modifier}"`);
		return `${code}:1`;
	});
	events.push(`${keycode}:1`, `${keycode}:0`);
	for (const modifier of [...modifiers].reverse()) events.push(`${KEYCODES[modifier]}:0`);
	return ["key", ...events];
}

/** Build the keyboard tool over one resolved plugin config. */
export function createKeysTool(config) {
	const transport = config.keyboardTransport === "ydotool" ? "ydotool" : "wtype";
	const binary = transport === "ydotool" ? "ydotool" : "wtype";

	return defineTool({
		name: "desktop_key",
		description: [
			"Send keyboard input to the focused window on the user's desktop.",
			"`text` types literal text (Unicode/CJK included); `combo` taps a shortcut like \"ctrl+shift+a\"; `press` taps one key like \"Return\", \"Escape\", \"F5\".",
			"Keyboard input goes to the focused window only — focus it first with desktop_windows focus.",
			"Exactly one of text / combo / press per call.",
		].join(" "),
		parameters: {
			text: { type: "string", description: "Literal text to type, newlines included." },
			combo: { type: "string", description: 'Modifier shortcut to tap, e.g. "ctrl+shift+a", "super+d".' },
			press: { type: "string", description: 'Single key to tap, e.g. "Return", "Escape", "Tab", "F5".' },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					result: { type: "string", required: true },
				},
			},
			render: (args, value) => [{ type: "text", text: value.result }],
		},
		timeoutMs: 30_000,
		async execute(args) {
			const provided = ["text", "combo", "press"].filter((field) => args[field] !== undefined);
			if (provided.length !== 1) {
				throw new Error(`provide exactly one of text / combo / press (got ${provided.length === 0 ? "none" : provided.join(", ")})`);
			}
			const [field] = provided;

			let argv;
			if (field === "text") {
				argv = transport === "ydotool" ? ["type", "--", String(args.text)] : ["--", String(args.text)];
			} else if (transport === "ydotool") {
				argv = ydotoolComboArgs(args.combo ?? args.press);
			} else {
				argv = wtypeComboArgs(args.combo ?? args.press);
			}

			try {
				await runFileOrThrow(binary, argv, { env: sessionEnv() });
			} catch (error) {
				if (transport === "wtype" && /not available/i.test(String(error.message))) {
					await runFileOrThrow("ydotool", field === "text" ? ["type", "--", String(args.text)] : ydotoolComboArgs(args.combo ?? args.press), { env: sessionEnv() });
					return { result: `desktop_key: ${field} sent via ydotool fallback (wtype unavailable).` };
				}
				throw error;
			}
			return { result: `desktop_key: ${field} sent via ${binary}${field === "text" ? ` (${String(args.text).length} chars)` : ""}.` };
		},
		presentCall(args) {
			const subject = args.text !== undefined ? "type text" : `key ${args.combo ?? args.press ?? ""}`;
			return {
				card: "generic",
				title: `Keyboard: ${subject}`,
				kind: "execute",
			};
		},
	});
}

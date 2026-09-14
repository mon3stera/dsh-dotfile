// desktop_tree: the structured primary access path. A Python helper walks the
// AT-SPI2 accessibility tree (GTK/Qt expose it natively; Firefox connects when
// an AT client appears; Chromium/Electron need ACCESSIBILITY_ENABLED=1) and
// this tool renders it as indented text. Wayland apps cannot know their own
// position, so the raw extents are window-relative; the renderer reconciles
// them with the compositor (see coords.js) and states the space per app.
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineTool } from "@deepseek-ai/dsh-tools";

import { anchorTree } from "./coords.js";
import { runFileOrThrow } from "./exec.js";
import { sessionEnv } from "./env.js";
import { outputs, windows, workspaces } from "./niri.js";

/** @module dsh-plugin-computer-use/tool-tree */

const helperPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "atspi-tree.py");
const TITLE_CAP = 60;

/** Shorten a window title so one app header stays one readable line. */
function shortTitle(title) {
	const text = String(title ?? "");
	return text.length <= TITLE_CAP ? text : `${text.slice(0, TITLE_CAP - 1)}…`;
}

/** Human description of one toplevel's coordinate space, for the app header. */
function describeSpace(toplevel, anchor) {
	if (anchor === undefined) return "no compositor match — extents are WINDOW-RELATIVE";
	if (anchor.state === "absolute") {
		const origin = [toplevel.ext[0] + anchor.offset[0], toplevel.ext[1] + anchor.offset[1]];
		return `floating at ${origin[0]},${origin[1]} — extents are desktop-global`;
	}
	if (anchor.state === "none") {
		return "no widget geometry exposed (every node reports 0,0) — use desktop_screenshot";
	}
	if (anchor.reason === "tiled") {
		return "tiled — extents are WINDOW-RELATIVE (niri exposes no position for tiled windows; use desktop_screenshot or float the window first)";
	}
	return "no compositor match — extents are WINDOW-RELATIVE";
}

/** Per-app header suffix describing its windows and their coordinate spaces. */
function describeApp(app, anchors) {
	const toplevels = (app.node?.ch ?? []).filter((child) => Array.isArray(child.ext) && child.ext.length === 4);
	if (toplevels.length === 0) return "";

	const parts = toplevels.map((toplevel) => {
		const anchor = anchors?.get(toplevel.id);
		const title = toplevel.name === "" ? "" : ` "${shortTitle(toplevel.name)}"`;
		return `${title.trim() === "" ? "" : `window${title}`} ${toplevel.ext[2]}x${toplevel.ext[3]} ${describeSpace(toplevel, anchor)}`.trim();
	});

	return ` — ${parts.join(" | ")}`;
}

/** Render one walker node and its children as indented text lines. */
export function renderNode(node, indent, lines, note, anchors = null, space = { state: "relative" }) {
	if (note.stop) return;
	if (note.limit !== undefined && lines.length >= note.limit) {
		note.stop = true;
		return;
	}

	const anchor = anchors?.get(node.id);
	const active = anchor === undefined ? space : anchor;
	const parts = [
		node.id,
		node.role,
		node.name === "" ? "" : JSON.stringify(node.name),
	];
	if (node.ext !== null && node.ext !== undefined && node.ext.length === 4) {
		const [x, y, width, height] = node.ext;
		if (active.state === "absolute") {
			parts.push(`@${x + active.offset[0]},${y + active.offset[1]} ${width}x${height}`);
		} else if (active.state === "none") {
			parts.push(`@? ${width}x${height}`);
		} else {
			parts.push(`@${x},${y} ${width}x${height}`);
		}
	}
	if (node.act !== undefined && node.act.length > 0) parts.push(`actions=[${node.act.join("|")}]`);
	if (node.st !== undefined && node.st.length > 0) parts.push(`[${node.st.join(",")}]`);
	if (node.text !== undefined) parts.push(`text=${JSON.stringify(node.text)}`);
	lines.push(`${indent}${parts.filter((part) => part !== "").join(" ")}`);

	for (const child of node.ch ?? []) {
		renderNode(child, `${indent}  `, lines, note, anchors, active);
		if (note.stop) return;
	}
}

/** Render a parsed helper dump; returns the model-facing text. */
export function renderTree(dump, limit, anchors = null) {
	const lines = [];
	const note = { limit, stop: false };
	const spaces = [];

	for (const app of dump.apps) {
		lines.push(`## app "${app.name}"${describeApp(app, anchors)}`);
		renderNode(app.node, "", lines, note, anchors);
		if (note.stop) break;
	}

	for (const anchor of anchors?.values() ?? []) spaces.push(anchor.state);

	const header = dump.apps.length === 0
		? [
			"The accessibility tree is empty: no application has registered on the a11y bus yet.",
			"GTK and Qt apps register automatically; Firefox connects when an assistive client attaches;",
			"Chromium/Electron apps (VS Code, Obsidian, QQ, browsers) must be launched with ACCESSIBILITY_ENABLED=1.",
			"Fall back to desktop_screenshot plus desktop_mouse coordinates for apps that never register.",
		].join(" ")
		: [
			`Accessibility tree (${dump.total_nodes} nodes${dump.truncated ? ", TRUNCATED" : ""});`,
			"Wayland apps cannot report their own position, so each app line states its coordinate space.",
			spaces.length > 0 && spaces.every((state) => state === "absolute")
				? "Extents here are desktop-global logical pixels (compositor-anchored), usable directly as desktop_mouse coordinates."
				: "Only extents under an app marked desktop-global are usable directly as desktop_mouse coordinates; window-relative extents need the window origin, and apps without widget geometry need desktop_screenshot.",
		].join(" ");

	if (note.stop && !dump.truncated) lines.push(`(output truncated at ${limit} lines)`);
	return [header, ...lines].join("\n");
}

/** Build the accessibility-tree tool over one resolved plugin config. */
export function createTreeTool(config) {
	return defineTool({
		name: "desktop_tree",
		description: [
			"Read the AT-SPI2 accessibility (widget) tree of the user's desktop — the primary structured view of running applications.",
			"Each node shows role, name, pixel extents, available actions, states, and text content.",
			"Wayland apps cannot know their own absolute position: extents are window-relative unless the compositor can anchor them.",
			"Each app line states its space — desktop-global extents are usable directly as desktop_mouse coordinates; window-relative ones are not (niri exposes no position for tiled windows); apps reporting no widget geometry need desktop_screenshot.",
			"Filter with `app` (name substring) and `focused` to keep output small.",
		].join(" "),
		parameters: {
			app: { type: "string", description: 'Only applications whose name contains this substring, e.g. "obsidian".' },
			focused: { type: "boolean", description: "Only applications containing the currently active window." },
			max_depth: { type: "number", description: "Maximum tree depth (default from config)." },
			max_nodes: { type: "number", description: "Maximum node count before truncation (default from config)." },
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
		isConcurrencySafe: () => true,
		timeoutMs: 40_000,
		async execute(args) {
			const args_ = [
				"--max-depth", String(args.max_depth ?? config.maxTreeDepth),
				"--max-nodes", String(args.max_nodes ?? config.maxTreeNodes),
			];
			if (args.app !== undefined) args_.push("--app", String(args.app));
			if (args.focused === true) args_.push("--focused");

			const [result, comp] = await Promise.all([
				runFileOrThrow("python3", [helperPath, ...args_], {
					env: sessionEnv(),
					timeoutMs: 35_000,
					encoding: "utf8",
				}),
				compositorState(),
			]);

			const dump = JSON.parse(result.stdout);
			return { result: renderTree(dump, config.maxTreeNodes * 4, anchorTree(dump, comp)) };
		},
		presentCall(args) {
			return {
				card: "generic",
				title: `Accessibility tree${args.app === undefined ? "" : `: ${args.app}`}`,
				kind: "read",
			};
		},
	});
}

/**
 * Compositor state used for coordinate anchoring. Returns null when niri is
 * unreachable: the tree still renders, only with window-relative extents.
 */
async function compositorState() {
	try {
		const [list, workspaceList, outputList] = await Promise.all([windows(), workspaces(), outputs()]);
		return { windows: list, workspaces: workspaceList, outputs: outputList };
	} catch {
		return null;
	}
}

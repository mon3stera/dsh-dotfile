// desktop_tree: the structured primary access path. A Python helper walks the
// AT-SPI2 accessibility tree (GTK/Qt expose it natively; Firefox connects when
// an AT client appears; Chromium/Electron need ACCESSIBILITY_ENABLED=1) and
// this tool renders it as indented text with desktop-global pixel extents so
// the model can click any widget via desktop_mouse without a screenshot.
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineTool } from "@deepseek-ai/dsh-tools";

import { runFileOrThrow } from "./exec.js";
import { sessionEnv } from "./env.js";

/** @module dsh-plugin-computer-use/tool-tree */

const helperPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "atspi-tree.py");

/** Render one walker node and its children as indented text lines. */
export function renderNode(node, indent, lines, note) {
	if (note.stop) return;
	if (note.limit !== undefined && lines.length >= note.limit) {
		note.stop = true;
		return;
	}

	const parts = [
		node.id,
		node.role,
		node.name === "" ? "" : JSON.stringify(node.name),
	];
	if (node.ext !== null && node.ext !== undefined && node.ext.length === 4) {
		const [x, y, width, height] = node.ext;
		parts.push(`@${x},${y} ${width}x${height}`);
	}
	if (node.act !== undefined && node.act.length > 0) parts.push(`actions=[${node.act.join("|")}]`);
	if (node.st !== undefined && node.st.length > 0) parts.push(`[${node.st.join(",")}]`);
	if (node.text !== undefined) parts.push(`text=${JSON.stringify(node.text)}`);
	lines.push(`${indent}${parts.filter((part) => part !== "").join(" ")}`);

	for (const child of node.ch ?? []) {
		renderNode(child, `${indent}  `, lines, note);
		if (note.stop) return;
	}
}

/** Render a parsed helper dump; returns the model-facing text. */
export function renderTree(dump, limit) {
	const lines = [];
	const note = { limit, stop: false };
	for (const app of dump.apps) {
		lines.push(`## app "${app.name}"`);
		renderNode(app.node, "", lines, note);
		if (note.stop) break;
	}

	const header = dump.apps.length === 0
		? [
			"The accessibility tree is empty: no application has registered on the a11y bus yet.",
			"GTK and Qt apps register automatically; Firefox connects when an assistive client attaches;",
			"Chromium/Electron apps (VS Code, Obsidian, QQ, browsers) must be launched with ACCESSIBILITY_ENABLED=1.",
			"Fall back to desktop_screenshot plus desktop_mouse coordinates for apps that never register.",
		].join(" ")
		: `Accessibility tree (${dump.total_nodes} nodes${dump.truncated ? ", TRUNCATED" : ""}); extents are desktop-global logical pixels usable directly as desktop_mouse coordinates.`;

	if (note.stop && !dump.truncated) lines.push(`(output truncated at ${limit} lines)`);
	return [header, ...lines].join("\n");
}

/** Build the accessibility-tree tool over one resolved plugin config. */
export function createTreeTool(config) {
	return defineTool({
		name: "desktop_tree",
		description: [
			"Read the AT-SPI2 accessibility (widget) tree of the user's desktop — the primary structured view of running applications.",
			"Each node shows role, name, desktop-global pixel extents (usable directly as desktop_mouse coordinates), available actions, states, and text content.",
			"Prefer this over screenshots for GUI automation; apps that never register (Electron without ACCESSIBILITY_ENABLED=1) need desktop_screenshot instead.",
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

			const result = await runFileOrThrow("python3", [helperPath, ...args_], {
				env: sessionEnv(),
				timeoutMs: 35_000,
				encoding: "utf8",
			});
			return { result: renderTree(JSON.parse(result.stdout), config.maxTreeNodes * 4) };
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

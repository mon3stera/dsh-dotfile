// desktop_windows: the model-facing window manager. `list` is the targeting
// primitive every other tool keys off; the remaining actions wrap niri's
// focus-window / close-window / fullscreen-window IPC actions.
import { defineTool } from "@deepseek-ai/dsh-tools";

import { runFileOrThrow } from "./exec.js";
import { sessionEnv } from "./env.js";
import { windows } from "./niri.js";

/** @module dsh-plugin-computer-use/tool-windows */

/** Build the window-management tool. */
export function createWindowsTool() {
	return defineTool({
		name: "desktop_windows",
		description: [
			"List or manipulate windows on the user's niri desktop.",
			"action list returns every window with its id, app, title, workspace, focus state, and size — always list before targeting a window.",
			"focus / close / fullscreen take a window_id.",
		].join(" "),
		parameters: {
			action: { type: "string", enum: ["list", "focus", "close", "fullscreen"], description: "What to do. Default list." },
			window_id: { type: "number", description: "Target window id; required for focus, close, and fullscreen." },
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
		isConcurrencySafe: (args) => args?.action === undefined || args.action === "list",
		timeoutMs: 15_000,
		async execute(args) {
			const act = args.action ?? "list";

			if (act === "list") {
				const list = await windows();
				const lines = list.map((w) => {
					const size = w.layout?.window_size ?? [];
					return [
						`id=${w.id}`,
						`app=${w.app_id ?? "?"}`,
						`ws=${w.workspace_id ?? "?"}`,
						w.is_focused === true ? "focused" : "",
						size.length === 2 ? `${size[0]}x${size[1]}` : "",
						`title=${JSON.stringify(w.title ?? "")}`,
					].filter((part) => part !== "").join(" ");
				});
				return { result: lines.length === 0 ? "No windows are open." : lines.join("\n") };
			}

			if (args.window_id === undefined) throw new Error(`action "${act}" requires window_id`);
			const subcommand = act === "focus" ? "focus-window" : act === "close" ? "close-window" : "fullscreen-window";
			await runFileOrThrow("niri", ["msg", "action", subcommand, "--id", String(args.window_id)], { env: sessionEnv() });
			return { result: `desktop_windows: ${act} on window ${args.window_id} accepted by niri; call desktop_windows list to confirm.` };
		},
		presentCall(args) {
			return {
				card: "generic",
				title: `Windows: ${args.action ?? "list"}`,
				kind: (args.action ?? "list") === "list" ? "read" : "execute",
			};
		},
	});
}

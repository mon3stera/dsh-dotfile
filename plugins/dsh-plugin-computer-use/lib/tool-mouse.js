// desktop_mouse: pointer input over zwlr_virtual_pointer_v1 (absolute motion
// supported natively by niri) with ydotool's wheel for scrolling. Coordinates
// are desktop-global logical pixels — exactly what the accessibility tree
// reports and what desktop_screenshot's mapping line converts to.
import { defineTool } from "@deepseek-ai/dsh-tools";

import { runFileOrThrow } from "./exec.js";
import { sessionEnv } from "./env.js";
import { desktopBounds } from "./niri.js";
import { buttonCode, withVirtualPointer } from "./wayland-pointer.js";

/** @module dsh-plugin-computer-use/tool-mouse */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Build the mouse tool over one resolved plugin config. */
export function createMouseTool() {
	return defineTool({
		name: "desktop_mouse",
		description: [
			"Drive the real pointer on the user's desktop: move, click (left/right/middle, single/double), press, release, drag, and scroll.",
			"All coordinates are desktop-global logical pixels — the same numbers the accessibility tree (desktop_tree) reports and the ones desktop_screenshot's mapping line converts to.",
			"Prefer clicking widgets by their tree extents; use screenshot-measured coordinates only for a11y-less apps.",
		].join(" "),
		parameters: {
			action: { type: "string", enum: ["move", "click", "down", "up", "drag", "scroll"], description: "Pointer operation. Default click." },
			x: { type: "number", description: "Desktop X for move/click/down/drag start." },
			y: { type: "number", description: "Desktop Y for move/click/down/drag start." },
			to_x: { type: "number", description: "Drag end X." },
			to_y: { type: "number", description: "Drag end Y." },
			button: { type: "string", enum: ["left", "right", "middle"], description: "Button for click/down/up/drag. Default left." },
			count: { type: "number", description: "Click count, 1-3 (double-click: 2). Default 1." },
			dx: { type: "number", description: "Scroll: horizontal detents (positive right)." },
			dy: { type: "number", description: "Scroll: vertical detents (positive scrolls down)." },
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
			const act = args.action ?? "click";
			const button = args.button ?? "left";

			if (act === "scroll") {
				const detentsY = Math.trunc(args.dy ?? 0);
				const detentsX = Math.trunc(args.dx ?? 0);
				if (detentsY === 0 && detentsX === 0) throw new Error("scroll needs dx or dy (in wheel detents)");
				const parts = [];
				if (detentsY !== 0) parts.push(["mousemove", "-w", "-x", "0", "-y", String(detentsY)]);
				if (detentsX !== 0) parts.push(["mousemove", "-w", "-x", String(detentsX), "-y", "0"]);
				for (const argv of parts) {
					await runFileOrThrow("ydotool", argv, { env: sessionEnv() });
				}
				return { result: `desktop_mouse: scrolled dx=${detentsX} dy=${detentsY} detents.` };
			}

			const bounds = await desktopBounds();
			if (bounds.width <= 0) throw new Error("no niri output reports a logical size; cannot map coordinates");

			await withVirtualPointer(async (pointer) => {
				if (act === "move") {
					requirePoint(args, "move");
					pointer.moveAbsolute(args.x, args.y, bounds);
					await sleep(50);
					return;
				}

				if (act === "click") {
					requirePoint(args, "click");
					pointer.moveAbsolute(args.x, args.y, bounds);
					await sleep(60);
					const count = Math.min(Math.max(Math.trunc(args.count ?? 1), 1), 3);
					for (let i = 0; i < count; i += 1) {
						pointer.button(buttonCode(button), true);
						await sleep(35);
						pointer.button(buttonCode(button), false);
						await sleep(i + 1 < count ? 80 : 30);
					}
					return;
				}

				if (act === "down" || act === "up") {
					if (act === "down" && args.x !== undefined && args.y !== undefined) {
						pointer.moveAbsolute(args.x, args.y, bounds);
						await sleep(50);
					}
					pointer.button(buttonCode(button), act === "down");
					await sleep(40);
					return;
				}

				if (act === "drag") {
					requirePoint(args, "drag");
					if (args.to_x === undefined || args.to_y === undefined) throw new Error("drag requires to_x and to_y");
					pointer.moveAbsolute(args.x, args.y, bounds);
					await sleep(60);
					pointer.button(buttonCode(button), true);
					await sleep(80);

					const steps = 16;
					for (let i = 1; i <= steps; i += 1) {
						const t = i / steps;
						pointer.moveAbsolute(args.x + (args.to_x - args.x) * t, args.y + (args.to_y - args.y) * t, bounds);
						await sleep(16);
					}
					await sleep(60);
					pointer.button(buttonCode(button), false);
					await sleep(40);
					return;
				}

				throw new Error(`unknown action "${act}"`);
			});

			const where = args.x !== undefined ? ` at ${Math.round(args.x)},${Math.round(args.y)}` : "";
			return {
				result: `desktop_mouse: ${act}${where}${act === "click" ? ` ${args.button ?? "left"} x${args.count ?? 1}` : act === "drag" ? ` to ${Math.round(args.to_x)},${Math.round(args.to_y)}` : ""} done; verify with desktop_screenshot when unsure.`,
			};
		},
		presentCall(args) {
			return {
				card: "generic",
				title: `Mouse: ${args.action ?? "click"}`,
				kind: "execute",
			};
		},
	});
}

function requirePoint(args, action) {
	if (args.x === undefined || args.y === undefined) {
		throw new Error(`action "${action}" requires x and y (desktop-global logical pixels)`);
	}
}

// Thin wrappers around `niri msg`. The JSON flag is used for every read and
// actions run as `niri msg action ...`; every spawn re-resolves the session
// environment so the plugin also works when the DSH process was started
// outside the desktop session.
import { execFile } from "node:child_process";

import { sessionEnv } from "./env.js";

/** @module dsh-plugin-computer-use/niri */

function niri(args, timeoutMs = 10_000) {
	return new Promise((resolve, reject) => {
		execFile("niri", ["msg", ...args], {
			env: sessionEnv(),
			timeout: timeoutMs,
			maxBuffer: 16 * 1024 * 1024,
			encoding: "utf8",
		}, (error, stdout, stderr) => {
			if (error !== null && stdout === "") {
				reject(new Error(`niri msg ${args.join(" ")} failed: ${error.message}${stderr ? `: ${stderr.trim()}` : ""}`));
				return;
			}
			resolve(stdout);
		});
	});
}

/** All windows: `{id, title, app_id, workspace_id, is_focused, layout}` records. */
export async function windows() {
	const raw = await niri(["--json", "windows"]);
	return JSON.parse(raw);
}

/** All outputs keyed by name; each carries `logical {x, y, width, height}`. */
export async function outputs() {
	const raw = await niri(["--json", "outputs"]);
	return JSON.parse(raw);
}

/**
 * All workspaces: `{id, idx, name, output, is_active, is_focused, ...}`. Used to
 * map a window to the output whose `logical` origin completes an absolute
 * position, because `tile_pos_in_workspace_view` is output-local.
 */
export async function workspaces() {
	const raw = await niri(["--json", "workspaces"]);
	return JSON.parse(raw);
}

/**
 * Bounding box of the desktop in global logical pixels, plus per-output
 * records. Coordinates from the accessibility tree and niri itself are
 * desktop-global, so targeting normalizes into this box.
 */
export async function desktopBounds() {
	const outs = await outputs();
	const boxes = Object.values(outs)
		.map((out) => out.logical)
		.filter((logical) => logical !== undefined && logical !== null);

	if (boxes.length === 0) return { x: 0, y: 0, width: 0, height: 0, outputs: outs };

	const minX = Math.min(...boxes.map((box) => box.x));
	const minY = Math.min(...boxes.map((box) => box.y));
	const maxX = Math.max(...boxes.map((box) => box.x + box.width));
	const maxY = Math.max(...boxes.map((box) => box.y + box.height));
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY, outputs: outs };
}

/** Run one `niri msg action ...`; resolves with stdout, rejects on failure. */
export function action(...args) {
	return niri(["action", ...args]);
}

/** Best-effort focus by window id; resolves `false` when niri refuses. */
export async function focusWindow(windowId) {
	try {
		await action("focus-window", "--id", String(windowId));
		return true;
	} catch {
		return false;
	}
}

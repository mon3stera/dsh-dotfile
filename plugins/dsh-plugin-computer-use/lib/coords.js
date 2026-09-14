// Coordinate reconciliation between the AT-SPI tree and the compositor.
//
// Wayland gives a client no global coordinate space, so the extents an app
// reports through AT-SPI are never desktop-global: GTK3 reports them relative
// to its own toplevel (the frame sits at 0,0), XWayland reports them relative
// to the X root, and GTK4 reports 0,0 for every node including the toplevel.
// The compositor is the only source of an absolute origin, and niri supplies
// one only for floating windows: `tile_pos_in_workspace_view` is null for
// tiled windows (upstream issue #2381), so those stay window-relative and are
// labelled as such instead of being silently mis-targeted.
//
// Verified 2026-09-08 on niri 26.04: a floating window reported
// `tile_pos_in_workspace_view` [783,50] on an output whose logical origin is
// (-1440,0), and grim pixel localization measured the window at local (783,50)
// — so global = output.logical + tile_pos.
/** @module dsh-plugin-computer-use/coords */

/** Collect a node and every descendant into `into`. */
function collect(node, into) {
	into.push(node);
	for (const child of node.ch ?? []) collect(child, into);
	return into;
}

/**
 * Toplevel windows of one application node: the application's children that
 * carry usable extents. An application node itself reports -1,-1 (no frame).
 */
export function toplevelsOf(app) {
	return (app.node?.ch ?? []).filter((child) => Array.isArray(child.ext) && child.ext.length === 4);
}

/**
 * Whether the reported extents carry intra-window positions at all. GTK4
 * reports 0,0 for every node, so a subtree whose nodes all sit at the origin
 * has no usable geometry — only sizes. Degenerate 1x1 placeholder windows
 * (tray/portal stubs) count as no geometry too.
 */
export function geometryUsable(toplevel) {
	const nodes = collect(toplevel, []).filter((node) => Array.isArray(node.ext) && node.ext.length === 4);
	const sized = nodes.filter((node) => node.ext[2] > 1 && node.ext[3] > 1);

	if (sized.length === 0) return false;
	return sized.some((node) => node.ext[0] !== 0 || node.ext[1] !== 0) || sized.length === 1;
}

/** Normalize an app_id / a11y application name for comparison. */
function normalizeName(value) {
	return String(value ?? "").toLowerCase().replace(/\.[a-z0-9]+$/, "");
}

/**
 * Match one AT-SPI toplevel against the compositor's window list. Titles are
 * the strong signal; the app id and the size break ties, because several
 * windows of one application can share a title. An unnamed a11y window never
 * falls back to the app id: `"".includes()` would otherwise match everything.
 */
export function matchWindow(toplevel, windows) {
	const name = toplevel.name ?? "";
	const size = toplevel.ext;
	const byTitle = windows.filter((window) => window.title === name && name !== "");

	let byApp = byTitle;
	if (byApp.length === 0) {
		const key = normalizeName(name);
		if (key === "") return null;

		byApp = windows.filter((window) => {
			const appId = normalizeName(window.app_id);
			if (appId === "") return false;
			return appId === key || appId.includes(key) || key.includes(appId);
		});
	}

	if (byApp.length === 0) return null;

	const sameSize = byApp.filter((window) => {
		const windowSize = window.layout?.window_size;
		return Array.isArray(windowSize) && windowSize[0] === size[2] && windowSize[1] === size[3];
	});

	return (sameSize.length > 0 ? sameSize : byApp)[0];
}

/**
 * Absolute origin of a compositor window, or null when it has none. Floating
 * windows carry an output-local `tile_pos_in_workspace_view`; the workspace
 * maps the window to its output, whose `logical` origin completes the sum.
 */
export function originOf(window, workspaces, outputs) {
	const local = window.layout?.tile_pos_in_workspace_view;
	if (!Array.isArray(local) || local.length !== 2) return null;

	const workspace = workspaces.find((entry) => entry.id === window.workspace_id);
	const output = workspace === undefined ? undefined : outputs[workspace.output];
	const logical = output?.logical;

	if (logical === undefined || logical === null) return [local[0], local[1]];
	return [logical.x + local[0], logical.y + local[1]];
}

/**
 * Resolve the coordinate space of one toplevel window.
 *
 * - `{state: "absolute", offset}` — extents + offset are desktop-global.
 * - `{state: "relative", reason}` — window-relative; `tiled` means niri knows
 *   the window but exposes no position, `unmatched` means no compositor window
 *   could be identified.
 * - `{state: "none", reason}` — the app exposes no widget positions at all.
 */
export function anchorToplevel(toplevel, comp) {
	if (!geometryUsable(toplevel)) return { state: "none", reason: "no-geometry", window: null };

	const window = matchWindow(toplevel, comp.windows);
	if (window === null) return { state: "relative", reason: "unmatched", window: null };

	const origin = originOf(window, comp.workspaces, comp.outputs);
	if (origin === null) return { state: "relative", reason: "tiled", window };

	return {
		state: "absolute",
		offset: [origin[0] - toplevel.ext[0], origin[1] - toplevel.ext[1]],
		window,
	};
}

/**
 * Anchor every toplevel of every application. Returns a Map keyed by toplevel
 * node id, which the renderer applies to that subtree.
 */
export function anchorTree(dump, comp) {
	const anchors = new Map();
	if (comp === null || comp === undefined) return anchors;

	for (const app of dump.apps) {
		for (const toplevel of toplevelsOf(app)) anchors.set(toplevel.id, anchorToplevel(toplevel, comp));
	}

	return anchors;
}

// dsh-plugin-computer-use: five model-facing tools that let an agent see and
// operate the niri/Wayland desktop the DSH process runs in.
//
// - desktop_windows  niri IPC window list / focus / close / fullscreen
// - desktop_tree     AT-SPI2 accessibility tree via a spawned Python helper
// - desktop_screenshot  grim / niri screenshot-window, returned as an image
// - desktop_mouse    zwlr_virtual_pointer_v1 absolute motion + ydotool wheel
// - desktop_key      wtype text/keysyms (ydotool keycode fallback)
//
// A pure tool registrar like @deepseek-ai/dsh-tool-fs: it registers into the
// host `tools` registry and provides no service, so an agent-preset row needs
// no isolate realm. The tools execute real desktop input without a permission
// surface — mount this preset only where the operator trusts the agent.
import z from "@deepseek-ai/schemastery";

import { guidanceText } from "./guidance.js";
import { createScreenshotTool } from "./tool-screenshot.js";
import { createTreeTool } from "./tool-tree.js";
import { createKeysTool } from "./tool-keys.js";
import { createMouseTool } from "./tool-mouse.js";
import { createWindowsTool } from "./tool-windows.js";

/** @module dsh-plugin-computer-use */

/** Cordis plugin name used by loader diagnostics. */
const name = "dsh-plugin-computer-use";

/** Services required at registration time. */
const inject = ["tools", "systemPrompt"];

const Config = z.object({
	// Where niri's screenshot-window action drops files; the window-capture
	// path polls this directory for the newest image.
	screenshotDir: z.string().default("~/Pictures/Screenshots"),
	// Accessibility-tree walker caps; also the truncation budget of the render.
	maxTreeNodes: z.number().default(400),
	maxTreeDepth: z.number().default(12),
	// Keyboard transport: wtype (virtual-keyboard, Unicode/CJK) or ydotool
	// (raw evdev keycodes, ASCII-oriented).
	keyboardTransport: z.string().default("wtype"),
});

/** Register the five desktop tools and the guidance section. */
function apply(ctx, config = {}) {
	const resolved = Config(config);

	ctx.tools.register(createWindowsTool());
	ctx.tools.register(createTreeTool(resolved));
	ctx.tools.register(createScreenshotTool(ctx, resolved));
	ctx.tools.register(createMouseTool(resolved));
	ctx.tools.register(createKeysTool(resolved));

	ctx.systemPrompt.section({
		name: "tool:computer-use",
		order: 1610,
		text: guidanceText(resolved),
	});
}

export { Config, apply, inject, name };

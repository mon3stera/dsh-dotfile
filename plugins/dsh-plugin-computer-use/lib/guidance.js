// The model-facing guidance section for the desktop tools.
/** @module dsh-plugin-computer-use/guidance */

/**
 * Build the system-prompt section text. `imageCapable` only affects tone; the
 * screenshot tool itself refuses to run on text-only routes.
 */
export function guidanceText() {
	return [
		"# Computer use (niri/Wayland desktop)",
		"",
		"You can see and operate the user's live desktop through five tools: desktop_windows (window list, focus, close, fullscreen), desktop_tree (AT-SPI2 accessibility/widget tree), desktop_screenshot (pixels), desktop_mouse (pointer), and desktop_key (keyboard).",
		"",
		"Workflow:",
		"1. desktop_windows list first — every other tool targets windows by the ids it returns. Focus a window (desktop_windows focus) before typing into it.",
		"2. Prefer desktop_tree as the structured view: it gives each widget's role, name, text, and pixel extents, and every app line states that app's coordinate space. Use `app`/`focused` filters to keep it small.",
		"3. desktop_screenshot shows what the screen actually looks like — use it to verify results and for apps absent from the tree. Its result states the exact coordinate mapping to desktop pixels; apply it before clicking.",
		"4. desktop_mouse acts on desktop-global logical pixels. Extents under an app marked `desktop-global` are already compositor-anchored and need no conversion; screenshot pixels need the stated scale mapping. Wayland apps cannot know their own position, so extents marked WINDOW-RELATIVE are only meaningful relative to their own window — niri exposes no position for tiled windows, so those need desktop_screenshot (or make the window floating first).",
		"5. desktop_key sends text/shortcuts to the focused window only. `text` types literal content (CJK included); `combo` taps shortcuts like \"ctrl+shift+a\".",
		"",
		"Accessibility coverage is toolkit-dependent: GTK4/Qt register always, Firefox connects when a client reads the tree, Chromium/Electron apps (browsers, VS Code, Obsidian, QQ) only expose their tree if launched with ACCESSIBILITY_ENABLED=1 — for those, fall back to screenshot + coordinates. Verify side effects with desktop_screenshot rather than assuming; one action per step for state-changing operations (click, type, close).",
	].join("\n");
}

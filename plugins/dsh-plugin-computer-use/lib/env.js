// Resolve the desktop-session environment the DSH process may or may not have
// inherited. The tools spawn Wayland/D-Bus clients, so a missing
// WAYLAND_DISPLAY / NIRI_SOCKET / DBUS_SESSION_BUS_ADDRESS is recovered from
// $XDG_RUNTIME_DIR before every spawn instead of failing confusingly.
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** @module dsh-plugin-computer-use/env */

function runtimeDir() {
	const uid = process.getuid?.() ?? 1000;
	return process.env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`;
}

/** Candidates for the ydotoold unix socket, most specific first. */
export function ydotoolSocketCandidates(env = process.env) {
	const runtime = runtimeDir();
	return [
		env.YDOTOOL_SOCKET,
		path.join(runtime, ".ydotool_socket"),
		"/run/ydotoold.socket",
	].filter((value) => typeof value === "string" && value.length > 0);
}

/**
 * Build the environment for a desktop-client spawn, filling in the session
 * sockets the DSH process did not inherit. Existing values always win.
 */
export function sessionEnv(extra = {}) {
	const runtime = runtimeDir();
	const env = {
		...process.env,
		...extra,
	};
	env.XDG_RUNTIME_DIR = env.XDG_RUNTIME_DIR ?? runtime;

	if (!env.WAYLAND_DISPLAY) {
		const found = listRuntimeSockets().find((name) => name.startsWith("wayland-"));
		if (found !== undefined) env.WAYLAND_DISPLAY = found;
	}

	if (!env.NIRI_SOCKET) {
		const found = listRuntimeSockets().find((name) => /^niri\..*\.sock$/.test(name));
		if (found !== undefined) env.NIRI_SOCKET = path.join(runtime, found);
	}

	if (!env.DBUS_SESSION_BUS_ADDRESS) {
		env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${path.join(runtime, "bus")}`;
	}

	return env;
}

let runtimeCache;
function listRuntimeSockets() {
	if (runtimeCache === undefined) {
		const runtime = runtimeDir();
		try {
			runtimeCache = readdirSync(runtime);
		} catch {
			runtimeCache = [];
		}
	}
	return runtimeCache;
}

/** Absolute filesystem path of the Wayland display socket. */
export function waylandSocketPath(env = sessionEnv()) {
	const display = env.WAYLAND_DISPLAY;
	if (display === undefined) return undefined;
	if (display.startsWith("/")) return display;
	return path.join(env.XDG_RUNTIME_DIR, display);
}

/** Resolve `~` in a user-supplied path; other paths pass through. */
export function expandHome(value) {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
	return value;
}

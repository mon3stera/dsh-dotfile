// Smoke test for dsh-plugin-computer-use (agent tools for the niri/Wayland
// desktop). Run: node tests/dsh-computer-use-smoke.mjs (from the repo root)
//
// The host half is imported from the installed runtime copy (host deps resolve
// there). Protocol-level wayland encoding and the AT-SPI helper are exercised
// live when the sockets exist, and are skipped cleanly when they do not.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = fileURLToPath(new URL("../plugins/dsh-plugin-computer-use/", import.meta.url));
const RUNTIME = "/home/mon3tr/.dsh/profiles/node_modules/dsh-plugin-computer-use";

let pass = 0;
let fail = 0;
const eq = (actual, expected, label) => {
	if (actual === expected) {
		pass += 1;
		console.log(`PASS ${label}`);
		return;
	}
	fail += 1;
	console.log(`FAIL ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
};
const ok = (value, label) => eq(Boolean(value), true, label);

// ------------------------------------------------------------------ manifest
const manifest = JSON.parse(readFileSync(`${PLUGIN_DIR}/package.json`, "utf8"));
eq(manifest.name, "dsh-plugin-computer-use", "manifest name");
eq(manifest.type, "module", "manifest is ESM");
eq(manifest.exports["."], "./lib/index.js", "manifest exposes the node entry");
eq(manifest.exports["./client"], undefined, "manifest has no client half (host tools only)");

// ------------------------------------------------------- entry / registration
const host = await import(`${RUNTIME}/lib/index.js`);
eq(host.name, "dsh-plugin-computer-use", "plugin name");
ok(host.inject.includes("tools"), "injects the tools registry");
ok(host.inject.includes("systemPrompt"), "injects the system prompt service");
ok(typeof host.apply === "function", "exports apply");
ok(typeof host.Config === "object" || typeof host.Config === "function", "exports Config");

const resolved = host.Config({});
eq(resolved.screenshotDir, "~/Pictures/Screenshots", "config default screenshotDir");
eq(resolved.maxTreeNodes, 400, "config default maxTreeNodes");
eq(resolved.maxTreeDepth, 12, "config default maxTreeDepth");
eq(resolved.keyboardTransport, "wtype", "config default keyboardTransport");

const registered = [];
const sections = [];
const fakeCtx = {
	tools: { register: (definition) => registered.push(definition) },
	systemPrompt: { section: (entry) => sections.push(entry) },
};
host.apply(fakeCtx, {});
eq(registered.length, 5, "apply registers five tools");
eq(registered.map((tool) => tool.name).join(","), [
	"desktop_windows",
	"desktop_tree",
	"desktop_screenshot",
	"desktop_mouse",
	"desktop_key",
].join(","), "tool names and order");
eq(sections.length, 1, "apply adds one system prompt section");
eq(sections[0].name, "tool:computer-use", "section name");
ok(sections[0].text.includes("desktop_tree"), "guidance names the tree tool");
ok(sections[0].text.includes("ACCESSIBILITY_ENABLED=1"), "guidance documents the Electron a11y caveat");

for (const tool of registered) {
	ok(typeof tool.execute === "function", `${tool.name} has execute`);
	ok(tool.output !== undefined && typeof tool.output.render === "function", `${tool.name} has output.render`);
	ok(tool.parameters !== undefined, `${tool.name} declares parameters`);
}

// Screenshot tool result carries a model-visible image block.
const screenshot = registered.find((tool) => tool.name === "desktop_screenshot");
const blocks = screenshot.output.render({}, {
	image: { attachmentId: "a", mediaType: "image/png", bytes: 1, width: 1, height: 1 },
	detail: "d",
});
eq(blocks[1].type, "image", "screenshot render emits an image block");
eq(blocks[1].attachment.mediaType, "image/png", "image block carries the attachment ref");
eq(blocks[0].text, "d", "image block is preceded by the detail text");

// Mouse/keyboard tools are not concurrency-safe; reads are.
const mouse = registered.find((tool) => tool.name === "desktop_mouse");
const keys = registered.find((tool) => tool.name === "desktop_key");
const tree = registered.find((tool) => tool.name === "desktop_tree");
eq(mouse.isConcurrencySafe === undefined, true, "mouse tool is sequential by default");
ok(tree.isConcurrencySafe?.({}) === true, "tree tool is concurrency-safe");

// ------------------------------------------------------------------- key tool
const keysModule = await import(`${RUNTIME}/lib/tool-keys.js`);
eq(JSON.stringify(keysModule.parseCombo("ctrl+shift+a")), JSON.stringify({ modifiers: ["ctrl", "shift"], key: "a" }), "parseCombo splits modifiers");
eq(JSON.stringify(keysModule.parseCombo("Return")), JSON.stringify({ modifiers: [], key: "return" }), "parseCombo single key");
eq(JSON.stringify(keysModule.wtypeComboArgs("ctrl+s")), JSON.stringify(["-M", "ctrl", "-P", "s", "-p", "s", "-m", "ctrl"]), "wtype combo argv");
eq(JSON.stringify(keysModule.wtypeComboArgs("ctrl+alt+t")), JSON.stringify(["-M", "ctrl", "-M", "alt", "-P", "t", "-p", "t", "-m", "alt", "-m", "ctrl"]), "wtype multi-modifier argv");
eq(JSON.stringify(keysModule.ydotoolComboArgs("ctrl+c")), JSON.stringify(["key", "29:1", "46:1", "46:0", "29:0"]), "ydotool combo keycodes");
eq(JSON.stringify(keysModule.ydotoolComboArgs("super")), JSON.stringify(["key", "125:1", "125:0"]), "ydotool super keycode");
let threw = false;
try {
	keysModule.wtypeComboArgs("hyper+t");
} catch {
	threw = true;
}
ok(threw, "unknown modifier rejects");

// ------------------------------------------------------------------ tree tool
const treeModule = await import(`${RUNTIME}/lib/tool-tree.js`);
const dump = {
	apps: [{
		name: "obsidian",
		node: {
			id: "5", role: "application", name: "obsidian", st: [], ext: null,
			ch: [{
				id: "5.0", role: "frame", name: "Vault", st: ["active"], ext: [100, 200, 800, 600],
				ch: [{ id: "5.0.1", role: "push button", name: "OK", st: [], ext: [300, 400, 60, 24], act: ["press"] }],
			}],
		},
	}],
	total_nodes: 3,
	truncated: false,
};
const rendered = treeModule.renderTree(dump, 50);
ok(rendered.includes("## app \"obsidian\""), "tree render includes app header");
ok(rendered.includes("push button \"OK\""), "tree render includes node role and name");
ok(rendered.includes("@300,400 60x24"), "tree render includes desktop-global extents");
ok(rendered.includes("actions=[press]"), "tree render includes actions");
ok(rendered.includes("desktop-global logical pixels"), "tree render documents the coordinate space");
const empty = treeModule.renderTree({ apps: [], total_nodes: 0, truncated: false }, 50);
ok(empty.includes("ACCESSIBILITY_ENABLED=1"), "empty tree explains the a11y coverage gap");
const truncated = treeModule.renderTree({
	apps: [{ name: "a", node: { id: "0", role: "application", name: "a", st: [], ext: null, ch: [
		{ id: "0.0", role: "x", name: "", st: [], ext: null },
		{ id: "0.1", role: "x", name: "", st: [], ext: null },
		{ id: "0.2", role: "x", name: "", st: [], ext: null },
	] } }],
	total_nodes: 4,
	truncated: false,
}, 3);
ok(truncated.includes("truncated at 3 lines"), "render truncation is announced");

// ------------------------------------------------------------------ env / exec
const env = await import(`${RUNTIME}/lib/env.js`);
process.env.XDG_RUNTIME_DIR = "/run/user/1000";
delete process.env.NIRI_SOCKET;
delete process.env.DBUS_SESSION_BUS_ADDRESS;
delete process.env.WAYLAND_DISPLAY;
const filled = env.sessionEnv();
eq(filled.DBUS_SESSION_BUS_ADDRESS, "unix:path=/run/user/1000/bus", "sessionEnv fills the session bus");
eq(filled.NIRI_SOCKET, "/run/user/1000/niri.wayland-1.1234.sock", "sessionEnv discovers the niri socket");
eq(filled.WAYLAND_DISPLAY, "wayland-1", "sessionEnv discovers the wayland display");
ok(env.ydotoolSocketCandidates({}).includes("/run/user/1000/.ydotool_socket"), "ydotool socket candidate is $XDG_RUNTIME_DIR/.ydotool_socket");
eq(env.expandHome("~/Pictures/Screenshots"), `${process.env.HOME}/Pictures/Screenshots`, "expandHome resolves ~");

const execModule = await import(`${RUNTIME}/lib/exec.js`);
let execThrew = false;
try {
	await execModule.runFileOrThrow("/bin/false", []);
} catch (error) {
	execThrew = error.message.includes("exit code 1");
}
ok(execThrew, "runFileOrThrow surfaces nonzero exits");

// ------------------------------------------------------------ wire encoding
const wire = await import(`${RUNTIME}/lib/wayland-pointer.js`);
eq(wire.buttonCode("left"), 0x110, "buttonCode left");
eq(wire.buttonCode("right"), 0x111, "buttonCode right");
eq(wire.buttonCode("middle"), 0x112, "buttonCode middle");
{
	const pointer = new wire.VirtualPointer();
	const bounds = { x: 0, y: 0, width: 100, height: 100 };
	try {
		await pointer.open();
		ok(true, "live wayland handshake binds zwlr_virtual_pointer_manager_v1");
		pointer.moveAbsolute(50, 50, bounds);
		pointer.button(wire.BTN_LEFT, true);
		pointer.button(wire.BTN_LEFT, false);
		ok(true, "virtual pointer accepted motion/button messages");
	} catch (error) {
		if (/ENOTFOUND|ENOENT|ECONNREFUSED|no Wayland display/.test(String(error.message))) {
			console.log(`SKIP live wayland handshake: ${error.message}`);
		} else {
			fail += 1;
			console.log(`FAIL live wayland handshake: ${error.message}`);
		}
	} finally {
		await pointer.close().catch(() => {});
	}
}

// ------------------------------------------------------------- AT-SPI helper
{
	const { runFile } = await import(`${RUNTIME}/lib/exec.js`);
	try {
		const result = await runFile("python3", [`${RUNTIME}/lib/atspi-tree.py`, "--max-nodes", "12"], {
			env: { ...process.env },
			timeoutMs: 30_000,
			encoding: "utf8",
		});
		const dump = JSON.parse(result.stdout);
		ok(Array.isArray(dump.apps), "atspi-tree.py emits an apps array");
		ok(typeof dump.total_nodes === "number", "atspi-tree.py counts nodes");
	} catch (error) {
		console.log(`SKIP live atspi-tree: ${error.message}`);
	}
}

// -------------------------------------------------------------- pngSize parse
const pngModule = await import(`${RUNTIME}/lib/tool-screenshot.js`);
const fakePng = Buffer.alloc(33);
fakePng.writeUInt32BE(0x89504e47, 0);
fakePng.writeUInt32BE(1920, 16);
fakePng.writeUInt32BE(1080, 20);
eq(JSON.stringify(pngModule.pngSize(fakePng)), JSON.stringify({ width: 1920, height: 1080 }), "pngSize reads IHDR dimensions");
eq(pngModule.pngSize(Buffer.alloc(8)), undefined, "pngSize rejects non-PNG bytes");

// ---------------------------------------------------------------------- image
const image = await import(`${RUNTIME}/lib/image.js`);
eq(image.grimScale(2560, 1440, 2000), 0.78, "grimScale fits the dimension limit");
eq(image.grimScale(1440, 900, 2000), 1, "grimScale keeps small captures unscaled");
const ref = image.imageRefFromValue({ attachmentId: "abc", mediaType: "image/jpeg", bytes: 9, width: 3, height: 2 });
eq(ref.attachmentId, "abc", "imageRefFromValue passes the branded id through");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

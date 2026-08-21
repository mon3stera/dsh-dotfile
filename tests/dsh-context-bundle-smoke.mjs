// Verify the installable dsh.bundle manifest and its host patch.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const packageRoot = "/home/mon3tr/.dsh/profiles/node_modules/dsh-magic-context";
const manifest = JSON.parse(readFileSync(`${packageRoot}/package.json`, "utf8"));
const patch = readFileSync(`${packageRoot}/cordis.patch.yml`, "utf8");
if (manifest.dsh?.bundle?.patch !== "./cordis.patch.yml") throw new Error("dsh-magic-context does not declare its bundle patch");
if (!Array.isArray(manifest.files) || !manifest.files.includes("cordis.patch.yml") || !manifest.files.includes("preset") || !manifest.files.includes("scripts")) throw new Error("bundle assets are not included in package files");
if (manifest.bin?.["dsh-magic-context-install-preset"] !== "scripts/install-preset.mjs") throw new Error("preset installer binary is not declared");
if (manifest.dependencies?.["@huggingface/transformers"] !== undefined || manifest.peerDependenciesMeta?.["@huggingface/transformers"]?.optional !== true) throw new Error("Transformers.js must remain optional for clean profile installs");
if (manifest.exports?.["./engine"] !== "./lib/engine-plugin.js") throw new Error("explicit agent-plane ContextEngine export is missing");
if (!/- id: dsh-magic-context\n      name: dsh-magic-context\n      config:\n        host: true/.test(patch)) throw new Error("bundle patch does not mount the marked bare host shell for boot-time client discovery");
if (/dsh-magic-context\/(?:settings|notice)/.test(patch)) throw new Error("bundle patch still mounts subpath host rows that client discovery cannot materialize");
const hostShell = await import(`${packageRoot}/lib/index.js`);
if (typeof hostShell.apply !== "function" || typeof hostShell.ContextEngine !== "function") throw new Error("bare host shell does not preserve the public ContextEngine export");
const enginePlugin = await import(`${packageRoot}/lib/engine-plugin.js`);
if (enginePlugin.default !== enginePlugin.ContextEngine) throw new Error("explicit engine plugin does not default-export ContextEngine");

const notice = await import(`${packageRoot}/lib/notice.js`);
const installer = await import(`${packageRoot}/scripts/install-preset.mjs`);
const home = mkdtempSync(join(tmpdir(), "dsh-context-bundle-"));
try {
	const missing = notice.startupNotice(home);
	if (!missing.includes("Context Compact is not installed yet") || !missing.includes("dsh-magic-context-install-preset")) throw new Error("missing preset notice is incomplete");
	const installed = installer.installPreset({ homeDir: home, packageRoot });
	if (installed.changed !== true || installer.presetState(home).state !== "installed") throw new Error("preset installer did not install the packaged preset");
	for (const filename of ["agent.cordis.yml", "preset.yml"]) {
		if (!existsSync(join(home, ".agent-presets", "context-compact", filename))) throw new Error(`preset installer missed ${filename}`);
	}
	if (installer.installPreset({ homeDir: home, packageRoot }).changed !== false) throw new Error("preset installer is not idempotent");
	if (notice.startupNotice(home) !== "") throw new Error("startup notice was not suppressed after preset installation");
} finally {
	rmSync(home, { recursive: true, force: true });
}

const conflictHome = mkdtempSync(join(tmpdir(), "dsh-context-bundle-conflict-"));
try {
	const conflictDir = join(conflictHome, ".agent-presets", "context-compact");
	mkdirSync(conflictDir, { recursive: true });
	writeFileSync(join(conflictDir, "agent.cordis.yml"), "- id: unrelated\n  name: unrelated\n", "utf8");
	if (installer.presetState(conflictHome).state !== "conflict" || !notice.startupNotice(conflictHome).includes("not overwritten")) throw new Error("existing user preset conflict was not detected");
} finally {
	rmSync(conflictHome, { recursive: true, force: true });
}

console.log("dsh-context bundle smoke: OK");

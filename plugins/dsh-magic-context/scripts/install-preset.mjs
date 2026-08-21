#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PRESET_ID = "context-compact";
const PRESET_FILES = ["agent.cordis.yml", "preset.yml"];
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function resolvePresetHome() {
	const configured = process.env.DSH_HOME?.trim();
	if (configured === undefined || configured.length === 0) return join(homedir(), ".dsh");
	if (configured === "~") return homedir();
	if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
	return resolve(configured);
}

function targetDirectory(homeDir) {
	return join(homeDir, ".agent-presets", PRESET_ID);
}

/** Return whether the user preset is absent, ours, or an existing conflict. */
export function presetState(homeDir = resolvePresetHome()) {
	const directory = targetDirectory(homeDir);
	if (!existsSync(directory)) return { state: "missing", directory };
	try {
		const composition = readFileSync(join(directory, "agent.cordis.yml"), "utf8");
		return {
			state: /(^|\n)\s*name:\s*["']?dsh-magic-context(?:\/engine)?["']?\s*$/m.test(composition) ? "installed" : "conflict",
			directory,
		};
	} catch {
		return { state: "conflict", directory };
	}
}

/** Install the packaged preset without replacing any user-owned directory. */
export function installPreset({ homeDir = resolvePresetHome(), packageRoot = PACKAGE_ROOT } = {}) {
	const target = presetState(homeDir);
	if (target.state === "installed") return { ...target, changed: false };
	if (target.state === "conflict") throw new Error(`preset directory already exists and does not use dsh-magic-context: ${target.directory}`);

	const source = join(resolve(packageRoot), "preset", PRESET_ID);
	mkdirSync(target.directory, { recursive: true });
	try {
		for (const filename of PRESET_FILES) {
			const sourceFile = join(source, filename);
			if (!existsSync(sourceFile)) throw new Error(`packaged preset file is missing: ${sourceFile}`);
			copyFileSync(sourceFile, join(target.directory, filename));
		}
	} catch (error) {
		rmSync(target.directory, { recursive: true, force: true });
		throw error;
	}
	return { ...target, state: "installed", changed: true };
}

function isMainModule() {
	if (process.argv[1] === undefined) return false;
	try {
		return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

if (isMainModule()) {
	try {
		const result = installPreset();
		console.log(result.changed
			? `[dsh-magic-context] Installed ${PRESET_ID} preset at ${result.directory}. It is available but not selected as the default.`
			: `[dsh-magic-context] ${PRESET_ID} preset is already installed at ${result.directory}.`);
	} catch (error) {
		console.error(`[dsh-magic-context] Preset installation failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}

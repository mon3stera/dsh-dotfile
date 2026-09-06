#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PRESET_ID = "context-compact";
export const DREAM_PRESET_ID = "dream";
const PRESET_FILES = ["agent.cordis.yml", "preset.yml"];
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Marker a composition must carry to count as our copy of each preset. */
const OWNERSHIP_MARKERS = {
	[PRESET_ID]: /(^|\n)\s*name:\s*["']?dsh-magic-context(?:\/engine)?["']?\s*$/m,
	[DREAM_PRESET_ID]: /(^|\n)\s*name:\s*["']?dsh-magic-context\/dream-agent["']?\s*$/m,
};

function resolvePresetHome() {
	const configured = process.env.DSH_HOME?.trim();
	if (configured === undefined || configured.length === 0) return join(homedir(), ".dsh");
	if (configured === "~") return homedir();
	if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
	return resolve(configured);
}

function targetDirectory(homeDir, presetId) {
	return join(homeDir, ".agent-presets", presetId);
}

/** Return whether a user preset is absent, ours, or an existing conflict. */
export function presetState(homeDir = resolvePresetHome(), presetId = PRESET_ID) {
	const directory = targetDirectory(homeDir, presetId);
	if (!existsSync(directory)) return { state: "missing", directory };
	try {
		const composition = readFileSync(join(directory, "agent.cordis.yml"), "utf8");
		return {
			state: OWNERSHIP_MARKERS[presetId].test(composition) ? "installed" : "conflict",
			directory,
		};
	} catch {
		return { state: "conflict", directory };
	}
}

/** Install one packaged preset without replacing any user-owned directory. */
export function installPreset({ homeDir = resolvePresetHome(), packageRoot = PACKAGE_ROOT, presetId = PRESET_ID } = {}) {
	const target = presetState(homeDir, presetId);
	if (target.state === "installed") return { ...target, changed: false };
	if (target.state === "conflict") throw new Error(`preset directory already exists and does not use dsh-magic-context: ${target.directory}`);

	const source = join(resolve(packageRoot), "preset", presetId);
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

/** Install every preset the package ships (context-compact and dream). */
export function installPresets({ homeDir = resolvePresetHome(), packageRoot = PACKAGE_ROOT } = {}) {
	return [PRESET_ID, DREAM_PRESET_ID].map((presetId) => ({ presetId, ...installPreset({ homeDir, packageRoot, presetId }) }));
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
		for (const result of installPresets()) {
			console.log(result.changed
				? `[dsh-magic-context] Installed ${result.presetId} preset at ${result.directory}. It is available but not selected as the default.`
				: `[dsh-magic-context] ${result.presetId} preset is already installed at ${result.directory}.`);
		}
	} catch (error) {
		console.error(`[dsh-magic-context] Preset installation failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}

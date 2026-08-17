import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { presetState } from "../scripts/install-preset.mjs";

export const name = "dsh-magic-context-startup-notice";
export const INSTALL_COMMAND = "dsh plugin --profile web exec dsh-magic-context-install-preset";

export function startupNotice(homeDir = resolveDshHome()) {
	const preset = presetState(homeDir);
	if (preset.state === "installed") return "";
	if (preset.state === "conflict") {
		return [
			"[dsh-magic-context] A context-compact preset already exists but does not use dsh-magic-context.",
			"It was not overwritten. Review the existing user preset before changing it.",
		].join("\n");
	}
	return [
		"[dsh-magic-context] Context Compact is not installed yet.",
		"Run this once to install the packaged preset; it will not change your default preset:",
		`  ${INSTALL_COMMAND}`,
		"Afterward, select context-compact for new sessions if you want to use ContextEngine.",
	].join("\n");
}

/** Print setup guidance only while the packaged preset is absent or conflicting. */
export function apply(ctx) {
	const message = startupNotice();
	if (message) ctx.logger.info(message);
}

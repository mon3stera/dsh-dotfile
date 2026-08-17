export const name = "dsh-magic-context-startup-notice";

export const STARTUP_NOTICE = [
	"[dsh-magic-context] Bundle loaded.",
	"This bundle installs the host settings/client bridge; it does not install or select an agent preset.",
	"To enable ContextEngine for new sessions:",
	"  1. Use a user-owned preset with an isolated compaction realm.",
	"  2. Mount dsh-magic-context in that group.",
	"  3. Keep @deepseek-ai/dsh-command-compact and @deepseek-ai/dsh-compaction-tool-result-pruner in the same group.",
	"  4. Set agent-presets.config.default to that preset only if desired.",
	"See dsh-magic-context/README.md and profile/agent-presets/context-compact/agent.cordis.yml for the composition example.",
].join("\n");

/** Print setup guidance when the installed bundle enters a DSH profile. */
export function apply(ctx) {
	ctx.logger.info(STARTUP_NOTICE);
}

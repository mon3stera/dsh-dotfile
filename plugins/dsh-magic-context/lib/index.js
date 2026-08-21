// Bare package entry. The bundle mounts it once with { host: true } so
// dsh-client-modules discovers the browser half before the page boots. Without
// that marker it remains a compatibility alias for the agent-plane engine;
// new presets use the explicit ./engine entry.
import { ContextEngine } from "./engine.js";
import { apply as applySettings } from "./settings.js";
import { apply as applyNotice } from "./notice.js";

export { ContextEngine };
export const name = "dsh-magic-context";

export function apply(ctx, config = {}) {
	if (config.host === true) {
		ctx.plugin({ name: "dsh-magic-context-settings", apply: applySettings });
		ctx.plugin({ name: "dsh-magic-context-startup-notice", apply: applyNotice });
		return;
	}
	return ctx.plugin(ContextEngine, config);
}

// Agent-plane ContextEngine entry. The bare package entry is reserved for the
// process-wide host shell so the browser client bundle exists at Web boot.
export { ContextEngine, ContextEngine as default } from "./engine.js";
export const name = "dsh-magic-context-engine";

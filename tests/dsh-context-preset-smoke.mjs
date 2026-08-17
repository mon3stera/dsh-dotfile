// Verify the Web profile defaults new sessions to Context Compact.
import { readFileSync } from "node:fs";

const patch = readFileSync(new URL("../profile/cordis.patch.example.yml", import.meta.url), "utf8");
const presetPath = new URL("../profile/agent-presets/context-compact/", import.meta.url);
const preset = readFileSync(new URL("preset.yml", presetPath), "utf8");
const composition = readFileSync(new URL("agent.cordis.yml", presetPath), "utf8");
if (!/- id: agent-presets\n  config:\n    default: context-compact/.test(patch)) throw new Error("Web profile does not default new sessions to context-compact");
if (!/^name: Context Compact$/m.test(preset)) throw new Error("Context Compact preset label changed");
if (/tool-bootstrap|anchored-tool-bootstrap/.test(composition)) throw new Error("Context Compact still contains bootstrap logic");
if (!/id: context-engine\n      name: dsh-plugin-context/.test(composition)) throw new Error("Context Compact does not mount the Context Engine");
if (/id: compaction-basic\n/.test(composition)) throw new Error("Context Compact still mounts compaction-basic");
console.log("dsh-context preset smoke: OK");

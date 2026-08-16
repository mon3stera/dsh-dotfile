// Verify the Web profile defaults new sessions to Context Compact.
import { readFileSync } from "node:fs";

const patch = readFileSync(new URL("../profile/cordis.patch.example.yml", import.meta.url), "utf8");
const preset = readFileSync(new URL("../profile/agent-presets/my-compact/preset.yml", import.meta.url), "utf8");
if (!/- id: agent-presets\n  config:\n    default: my-compact/m.test(patch)) throw new Error("Web profile does not default new sessions to my-compact");
if (!/^name: Context Compact \(experimental\)$/m.test(preset)) throw new Error("my-compact preset label changed");
console.log("dsh-context preset smoke: OK");

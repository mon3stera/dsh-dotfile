// Verify the installable dsh.bundle manifest and its host patch.
import { readFileSync } from "node:fs";

const packageRoot = "/home/mon3tr/.dsh/profiles/node_modules/dsh-magic-context";
const manifest = JSON.parse(readFileSync(`${packageRoot}/package.json`, "utf8"));
const patch = readFileSync(`${packageRoot}/cordis.patch.yml`, "utf8");
if (manifest.dsh?.bundle?.patch !== "./cordis.patch.yml") throw new Error("dsh-magic-context does not declare its bundle patch");
if (!Array.isArray(manifest.files) || !manifest.files.includes("cordis.patch.yml")) throw new Error("bundle patch is not included in package files");
if (!/- id: dsh-magic-context-settings\n      name: dsh-magic-context\/settings/.test(patch)) throw new Error("bundle patch does not mount the settings bridge");
if (/name: dsh-magic-context\s*$/.test(patch)) throw new Error("bundle patch must not mount the agent-plane ContextEngine host-wide");
console.log("dsh-context bundle smoke: OK");

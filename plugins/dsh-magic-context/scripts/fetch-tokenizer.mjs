#!/usr/bin/env node
// Fetch the BPE vocabulary used for exact token accounting.
//
//   node scripts/fetch-tokenizer.mjs                 # deepseek-ai/DeepSeek-V3
//   node scripts/fetch-tokenizer.mjs --repo <hf-repo>
//   node scripts/fetch-tokenizer.mjs --name <file.json>
//
// The file lands in $DSH_HOME/magic-context/tokenizers/<name>.json (about 7.5 MB).
// Exact accounting stays optional: without this file the plugin falls back to
// the host's four-characters-per-token heuristic.
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_REPO = "deepseek-ai/DeepSeek-V3";
const args = process.argv.slice(2);
const option = (name, fallback) => {
	const index = args.indexOf(`--${name}`);
	return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const repo = option("repo", DEFAULT_REPO);
const name = option("name", "deepseek.json");
// Deliberately dependency-free: the script must run from the workspace copy too.
const home = process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");
const target = `${home}/magic-context/tokenizers/${name}`;
const url = `https://huggingface.co/${repo}/resolve/main/tokenizer.json`;

console.log(`fetching ${url}`);
const response = await fetch(url, { redirect: "follow" });
if (!response.ok) {
	console.error(`download failed: ${response.status} ${response.statusText}`);
	process.exit(1);
}
const bytes = Buffer.from(await response.arrayBuffer());
JSON.parse(bytes.toString("utf8")); // fail before writing a truncated or HTML body
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, bytes);
console.log(`wrote ${bytes.byteLength} bytes to ${target}`);

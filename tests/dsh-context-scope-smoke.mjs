// Git/workspace scope resolution smoke test.
import { mkdtempSync, rmSync } from "node:fs";
import { resolveMemoryScope } from "/home/mon3tr/.dsh/profiles/node_modules/dsh-magic-context/lib/scope.js";

let failed = 0;
const check = (label, ok) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
	if (!ok) failed += 1;
};

const repo = "/home/mon3tr/dev/dsh-dotfile";
check("nested Git cwd resolves to worktree root", resolveMemoryScope(`${repo}/plugins/dsh-magic-context`) === repo);
const nonGit = mkdtempSync("/home/mon3tr/ctx-scope-");
try {
	check("non-Git workspace stays isolated by canonical cwd", resolveMemoryScope(nonGit) === nonGit);
	check("missing cwd has no scope", resolveMemoryScope(undefined) === undefined);
} finally {
	rmSync(nonGit, { recursive: true, force: true });
}

if (failed > 0) {
	console.error(`${failed} assertion(s) failed`);
	process.exit(1);
}
console.log("dsh-context scope smoke: OK");

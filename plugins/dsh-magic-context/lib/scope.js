// Memory scope identity: canonical Git worktree root, or the canonical session
// cwd for a non-Git workspace. A missing cwd has no project scope.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

const scopeCache = new Map();

export function resolveMemoryScope(cwd) {
	if (typeof cwd !== "string" || !isAbsolute(cwd)) return undefined;
	if (scopeCache.has(cwd)) return scopeCache.get(cwd);
	let canonical;
	try {
		canonical = realpathSync.native(cwd);
	} catch {
		return undefined;
	}
	let scope = canonical;
	try {
		const gitRoot = execFileSync("git", ["-C", canonical, "rev-parse", "--show-toplevel"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		if (gitRoot.length > 0) scope = realpathSync.native(gitRoot);
	} catch {
		// A non-Git workspace is still isolated by its canonical cwd.
	}
	scopeCache.set(cwd, scope);
	return scope;
}

export function sessionMemoryScope(session) {
	return resolveMemoryScope(session?.header?.cwd);
}

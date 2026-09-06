// Promise wrappers around child_process.execFile that keep raw bytes for
// image capture and readable stderr for error messages.
import { execFile } from "node:child_process";

/** @module dsh-plugin-computer-use/exec */

/** Run `file` and resolve `{stdout, stderr, code}`; rejects only on spawn failure. */
export function runFile(file, args, options = {}) {
	const { timeoutMs = 15_000, maxBuffer = 32 * 1024 * 1024, env, encoding = "buffer", input } = options;
	return new Promise((resolve, reject) => {
		const child = execFile(
			file,
			args,
			{ timeout: timeoutMs, maxBuffer, env, encoding, killSignal: "SIGKILL" },
			(error, stdout, stderr) => {
				if (error !== null && stdout.length === 0 && (error.code === undefined || error.code === "ENOENT")) {
					reject(new Error(`${file} is not available: ${error.message}`));
					return;
				}
				resolve({
					stdout,
					stderr: typeof stderr === "string" ? stderr : stderr?.toString?.() ?? "",
					code: error === null ? 0 : typeof error.code === "number" ? error.code : 1,
				});
			},
		);
		if (input !== undefined) child.stdin?.end(input);
	});
}

/** Run `file` and reject with a model-readable message on a nonzero exit. */
export async function runFileOrThrow(file, args, options = {}) {
	const result = await runFile(file, args, options);
	if (result.code !== 0) {
		const detail = result.stderr.trim().split("\n")[0] ?? "";
		throw new Error(`${file} ${args[0] ?? ""} failed with exit code ${result.code}${detail ? `: ${detail}` : ""}`);
	}
	return result;
}

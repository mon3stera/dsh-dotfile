// Context UI notices must use DSH's durable plugin context-message contract.
import { createContextNotice, injectContextNotice } from "/home/mon3tr/.dsh/profiles/node_modules/dsh-plugin-context/lib/notifications.js";

let failed = 0;
const check = (label, ok) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
	if (!ok) failed += 1;
};

const notice = createContextNotice("  Inject Memory: 2 project memories  ", "Injected two project memories into the next model request.");
check("notice has user message shape", notice.role === "user" && notice.content[0]?.type === "text");
check("notice uses plugin source", notice.source.kind === "plugin" && notice.source.plugin === "dsh-plugin-context");
check("notice uses context notice form", notice.source.form === "notice" && notice.source.summary === "Inject Memory: 2 project memories");
check("notice keeps body", notice.content[0]?.text.includes("two project memories") === true);

let injected;
const agent = { inject(message) { injected = message; } };
check("inject queues notice", injectContextNotice(agent, "Dreamer started", "Dreamer started its background pass.") === true && injected?.source.form === "notice");
check("undefined agent is harmless", injectContextNotice(undefined, "ignored", "ignored") === false);

if (failed > 0) {
	console.error(`${failed} assertion(s) failed`);
	process.exit(1);
}
console.log("dsh-context notifications smoke: OK");

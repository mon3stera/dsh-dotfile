// Curated one-line summaries for tools the gate hides by default. The catalog
// renders these verbatim; a hidden tool missing from this map falls back to
// the first sentence of its own description (see gate.js firstSentence).
//
// Keep each line short: the whole catalog rides every request until the tool
// is expanded. English on purpose — ASCII estimates ~3.8 chars/token vs ~0.85
// tokens/char for CJK.
export const SUMMARIES = {
	// Desktop control (dsh-plugin-computer-use).
	desktop_windows: "List, focus, close, or fullscreen windows on the user's niri desktop.",
	desktop_tree: "Read the AT-SPI2 accessibility tree with desktop-global pixel extents for every widget.",
	desktop_screenshot: "Capture the whole desktop or one window as an image.",
	desktop_mouse: "Drive the real pointer: move, click, drag, scroll at desktop-global coordinates.",
	desktop_key: "Send keyboard text, shortcuts, or single keys to the focused window.",

	// Documentation lookup (context7 MCP).
	"mcp__context7__resolve-library-id": "Resolve a library name to a Context7 library id before querying docs.",
	"mcp__context7__query-docs": "Fetch up-to-date documentation and code examples from Context7 by library id.",

	// Orchestration / delegation.
	workflow: "Run a JavaScript workflow script that orchestrates subagents in phases with structured results; for large fan-out or audit work.",
	ralph: "Run a fresh-agent iterative loop toward one objective; each round starts a new child agent sharing only the workspace.",
	subagent: "Delegate one self-contained task to a background subagent and collect its final report.",
	subagent_fork: "Delegate a task to a subagent that inherits this conversation's completed context.",
	list_agents: "List running and continuable child agents with durable ids, labels, and statuses.",
	send_message: "Steer a running child agent's nearest step or wake an idle one with a message.",
	interrupt_agent: "Request cancellation of a child agent's current turn by agent id.",

	// Goals.
	create_goal: "Create a persistent completion goal that continues across autonomous rounds.",
	update_goal: "Edit, pause, resume, complete, or block the current session goal.",
	get_goal: "Read the current goal's id, revision, objective, phase, and round state.",

	// Background jobs.
	job_list: "List background jobs (running and finished) with ids, kinds, and statuses.",
	job_kill: "Stop a running background job by job id.",
	job_output: "Read a background job's streamed output, optionally waiting for it to settle.",
};

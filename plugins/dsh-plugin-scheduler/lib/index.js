/**
 * Node half of dsh-plugin-scheduler: durable scheduled tasks that each spawn a
 * fresh session and submit the task prompt through the host sessionController.
 *
 *   GET  /scheduler/tasks   — read the task document (empty list until set)
 *   POST /scheduler/tasks   — validate, atomically persist, and re-arm
 *   POST /scheduler/run     — run one task immediately by id
 *
 * Persistence lives in $DSH_HOME/scheduler/tasks.json. The scheduler is a
 * self-rearming timer: the delay is the clamped time until the next due task,
 * recomputed after every run, save, and fire. Interval tasks run one catch-up
 * when found overdue at boot; daily tasks wait for their next occurrence.
 * Daily times use the server's local time zone.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";

export const name = "dsh-plugin-scheduler";

const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 60 * 24 * 365;
const MAX_PROMPT_CHARS = 20000;

/** One scheduled task. Empty cwd/preset = the deployment defaults. */
export const TaskSchema = z.object({
  id: z.string().max(80),
  name: z.string().min(1).max(120),
  prompt: z.string().min(1).max(MAX_PROMPT_CHARS),
  cwd: z.string().max(1024).default(""),
  agentPreset: z.string().max(120).default(""),
  enabled: z.boolean().default(true),
  /** "interval": every `minutes`; "daily": at `time` (server-local HH:MM). */
  kind: z.union([z.const("interval"), z.const("daily")]).default("interval"),
  minutes: z.number().min(MIN_INTERVAL_MINUTES).max(MAX_INTERVAL_MINUTES).default(60),
  time: z.string().max(5).default("09:00"),
  lastRunAt: z.union([z.number(), z.const(null)]).default(null),
  lastSessionId: z.string().max(160).default(""),
  lastError: z.string().max(500).default("")
});

export const SchedulerDocumentSchema = z.object({
  tasks: z.array(TaskSchema).default([])
});

/** Absolute path of the plugin-owned task document. */
export function configPath() {
  return join(resolveDshHome(), "scheduler", "tasks.json");
}

function writeJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

/** Read the persisted document; absent or corrupt file reads as empty. */
function loadDocument() {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), "utf8"));
    const validated = SchedulerDocumentSchema["~standard"].validate(parsed);
    if (validated.issues !== undefined) return { tasks: [] };
    return validated.value;
  } catch {
    return { tasks: [] };
  }
}

function persistDocument(document) {
  const dir = join(resolveDshHome(), "scheduler");
  mkdirSync(dir, { recursive: true });
  const target = configPath();
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(document, null, 2));
  renameSync(tmp, target);
}

/** Next due timestamp for a task; null when it cannot ever come due. */
export function nextDueAt(task, now) {
  if (task.kind === "daily") {
    const [hours, minutes] = task.time.split(":").map(Number);
    const candidate = new Date(now);
    candidate.setHours(hours, minutes, 0, 0);
    if (candidate.getTime() <= now) candidate.setDate(candidate.getDate() + 1);
    return candidate.getTime();
  }
  const base = task.lastRunAt === null || typeof task.lastRunAt !== "number" ? now : task.lastRunAt;
  return base + task.minutes * 60_000;
}

/**
 * The scheduler owns the timer chain and the sessionController seam. Test
 * seams (`_setClock`, `_setRunner`) let the smoke test drive time and fake the
 * session creation.
 */
export function createScheduler() {
  let timer = null;
  let running = false;
  let clock = () => Date.now();
  let document = { tasks: [] };
  let runner = null;
  const runAborts = new Set();

  const setDocument = (next) => {
    document = next;
  };

  const getDocument = () => document;

  const setClock = (next) => {
    clock = next;
  };

  const setRunner = (next) => {
    runner = next;
  };

  /** Submit one task: fresh session, then the prompt as its first user message. */
  async function runTask(task) {
    const now = clock();
    task.lastRunAt = now;
    /* prompt() requires a caller signal even when nothing intends to cancel */
    const abort = new AbortController();
    runAborts.add(abort);
    try {
      if (runner === null) throw new Error("session controller unavailable");
      /* the session-sched- prefix lets a ContextEngine sessionFilter exclude
       * task runs from the shared memory pipeline */
      const created = await runner.create({
        sessionId: `session-sched-${randomUUID()}`,
        ...(task.cwd ? { cwd: task.cwd } : {}),
        ...(task.agentPreset ? { agentPreset: task.agentPreset } : {})
      });
      await runner.prompt({
        sessionId: created.sessionId,
        requestId: randomUUID(),
        content: [{ type: "text", text: task.prompt }]
      }, abort.signal);
      task.lastSessionId = created.sessionId;
      task.lastError = "";
    } catch (error) {
      task.lastError = String(error?.message ?? error).slice(0, 500);
    } finally {
      runAborts.delete(abort);
    }
  }

  async function fireDueTasks() {
    if (running) return;
    running = true;
    try {
      const now = clock();
      for (const task of document.tasks) {
        if (!task.enabled) continue;
        if (nextDueAt(task, now) > now) continue;
        await runTask(task);
      }
      persistDocument(document);
    } finally {
      running = false;
    }
  }

  function scheduleTick(arm) {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (!arm) return;
    const now = clock();
    let earliest = Infinity;
    for (const task of document.tasks) {
      if (!task.enabled) continue;
      const due = nextDueAt(task, now);
      if (due < earliest) earliest = due;
    }
    if (earliest === Infinity) return;
    const delay = Math.min(Math.max(earliest - now, 500), 2 ** 31 - 1);
    timer = setTimeout(() => {
      timer = null;
      void fireDueTasks().finally(() => scheduleTick(true));
    }, delay);
    timer.unref?.();
  }

  return {
    setDocument,
    getDocument,
    setClock,
    setRunner,
    runTask,
    fireDueTasks,
    scheduleTick,
    stop() {
      scheduleTick(false);
      for (const abort of runAborts) abort.abort();
    }
  };
}

/** GET/POST /scheduler/tasks plus POST /scheduler/run, sharing one scheduler. */
export function createHandlers(scheduler) {
  async function handleTasks(req, res) {
    if (req.method === "GET" || req.method === "HEAD") {
      writeJson(res, 200, scheduler.getDocument());
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }
    let candidate;
    try {
      candidate = JSON.parse(await readBody(req));
    } catch {
      writeJson(res, 400, { error: "invalid JSON" });
      return;
    }
    const validated = SchedulerDocumentSchema["~standard"].validate(candidate);
    if (validated.issues !== undefined) {
      writeJson(res, 400, { error: validated.issues[0]?.message ?? "invalid document" });
      return;
    }
    /* the schema cannot express the HH:MM shape, so the format checks here */
    const badTime = validated.value.tasks.some((task) => task.kind === "daily" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(task.time));
    if (badTime) {
      writeJson(res, 400, { error: "daily time must be HH:MM" });
      return;
    }
    persistDocument(validated.value);
    scheduler.setDocument(validated.value);
    /* an overdue interval task runs once right after a save re-arms us */
    scheduler.scheduleTick(true);
    void scheduler.fireDueTasks().finally(() => scheduler.scheduleTick(true));
    writeJson(res, 200, { ok: true, tasks: validated.value.tasks });
  }

  async function handleRun(req, res) {
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }
    let request;
    try {
      request = JSON.parse(await readBody(req));
    } catch {
      writeJson(res, 400, { error: "invalid JSON" });
      return;
    }
    const task = scheduler.getDocument().tasks.find((entry) => entry.id === request?.id);
    if (task === undefined) {
      writeJson(res, 404, { error: "task not found" });
      return;
    }
    await scheduler.runTask(task);
    persistDocument(scheduler.getDocument());
    scheduler.scheduleTick(true);
    if (task.lastError) {
      writeJson(res, 502, { error: task.lastError });
      return;
    }
    writeJson(res, 200, { ok: true, sessionId: task.lastSessionId });
  }

  return { handleTasks, handleRun };
}

/** Read the request body up to a byte limit; null on overflow (drained). */
async function readBody(req, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  let overflow = false;
  for await (const chunk of req) {
    if (overflow) continue;
    size += chunk.length;
    if (size > limit) {
      overflow = true;
      continue;
    }
    chunks.push(chunk);
  }
  if (overflow) return null;
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Compose the plugin: routes always; the timer only when the host session
 * controller exists to create sessions through.
 */
export function apply(ctx) {
  const scheduler = createScheduler();
  scheduler.setDocument(loadDocument());
  const { handleTasks, handleRun } = createHandlers(scheduler);

  ctx.inject(["webServer"], (httpCtx) => {
    httpCtx.effect(() => httpCtx.webServer.register({ kind: "exact", path: "/scheduler/tasks", handler: handleTasks }), "dsh-plugin-scheduler: tasks route");
    httpCtx.effect(() => httpCtx.webServer.register({ kind: "exact", path: "/scheduler/run", handler: handleRun }), "dsh-plugin-scheduler: run route");
  });

  ctx.inject(["sessionController"], (hostCtx) => {
    const controller = hostCtx.sessionController;
    scheduler.setRunner({
      create: (request) => controller.create(request),
      prompt: (request, signal) => controller.prompt(request, signal)
    });
    /* overdue interval tasks catch up once at boot; daily tasks wait */
    hostCtx.effect(() => {
      void scheduler.fireDueTasks().finally(() => scheduler.scheduleTick(true));
      return () => scheduler.stop();
    }, "dsh-plugin-scheduler: timer");
  });
}

/**
 * Browser half of dsh-plugin-scheduler. Hand-written client bundle in the DSH
 * client-modules format (window.__ModuleLoader__.load CJS factory).
 *
 *  - a "定时任务 / Scheduled tasks" entry in the sidebar footer action list,
 *    which renders directly above the Settings entry,
 *  - a fixed side panel to manage tasks: each task has a name, a prompt, an
 *    optional cwd / agent preset, and either a fixed interval (minutes) or a
 *    daily server-local time,
 *  - every due task makes the host half spawn a fresh session and submit the
 *    prompt, so results show up as ordinary sessions in the sidebar list.
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-scheduler",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const { useState, useEffect, useCallback } = require("react");
		const { jsx, jsxs, Fragment } = require("react/jsx-runtime");

		const name = "dsh-plugin-scheduler";
		const inject = ["slots", "locale"];
		const NS = "dsh-plugin-scheduler";

		const zh = {
			"schd.title": "定时任务",
			"schd.entry": "定时任务",
			"schd.add": "新建任务",
			"schd.refresh": "刷新",
			"schd.name": "任务名称",
			"schd.prompt": "任务提示词（新会话的第一条消息）",
			"schd.cwd": "工作目录（留空用默认）",
			"schd.preset": "Agent 预设（留空用默认）",
			"schd.provider": "模型 provider（留空用默认路由）",
			"schd.model": "模型（留空用默认路由）",
			"schd.modelHint": "provider 与 model 都填写时，任务会话覆盖部署默认模型；只填其一不生效",
			"schd.modelDefault": "默认路由",
			"schd.modelManual": "模型目录不可用，请手动输入",
			"schd.kind": "触发方式",
			"schd.interval": "固定间隔",
			"schd.daily": "每天",
			"schd.minutes": "间隔分钟数（≥ 5）",
			"schd.time": "每天时间（服务器时区）",
			"schd.enabled": "启用",
			"schd.save": "保存",
			"schd.cancel": "取消",
			"schd.delete": "删除",
			"schd.edit": "编辑",
			"schd.runNow": "立即运行",
			"schd.lastRun": "上次运行",
			"schd.never": "从未运行",
			"schd.session": "会话",
			"schd.intervalSummary": "每 %s 分钟",
			"schd.dailySummary": "每天 %s",
			"schd.empty": "还没有任务，点“新建任务”创建一个。",
			"schd.loading": "加载中…",
			"schd.serverTime": "调度使用服务器本地时间",
			"schd.confirmDelete": "删除这个任务？",
			"schd.nameRequired": "任务名称必填",
			"schd.promptRequired": "任务提示词必填"
		};
		const en = {
			"schd.title": "Scheduled tasks",
			"schd.entry": "Scheduled tasks",
			"schd.add": "New task",
			"schd.refresh": "Refresh",
			"schd.name": "Task name",
			"schd.prompt": "Prompt (first message of the new session)",
			"schd.cwd": "Working directory (empty = default)",
			"schd.preset": "Agent preset (empty = default)",
			"schd.provider": "Model provider (empty = default route)",
			"schd.model": "Model (empty = default route)",
			"schd.modelHint": "When both provider and model are set, the task session overrides the deployment default; one alone does nothing",
			"schd.modelDefault": "Default route",
			"schd.modelManual": "Model catalog unavailable — type the values",
			"schd.kind": "Trigger",
			"schd.interval": "Fixed interval",
			"schd.daily": "Daily",
			"schd.minutes": "Interval minutes (>= 5)",
			"schd.time": "Daily time (server time zone)",
			"schd.enabled": "Enabled",
			"schd.save": "Save",
			"schd.cancel": "Cancel",
			"schd.delete": "Delete",
			"schd.edit": "Edit",
			"schd.runNow": "Run now",
			"schd.lastRun": "Last run",
			"schd.never": "never",
			"schd.session": "session",
			"schd.intervalSummary": "every %s min",
			"schd.dailySummary": "daily at %s",
			"schd.empty": "No tasks yet — create one with “New task”.",
			"schd.loading": "Loading…",
			"schd.serverTime": "Scheduling uses the server's local time",
			"schd.confirmDelete": "Delete this task?",
			"schd.nameRequired": "Task name is required",
			"schd.promptRequired": "Prompt is required"
		};
		const translate = (key) => zh[key] ?? key;

		/** Row and panel styles (schd-* prefix, theme alias tokens only). */
		const PLUGIN_CSS = [
			".schd-entry{box-sizing:border-box;cursor:pointer;width:auto;min-width:0;height:42px;color:var(--dsw-alias-label-primary);background:0 0;border:none;border-radius:12px;flex:1;align-items:center;gap:8px;margin:0;padding:0 10px 0 8px;font-family:inherit;font-size:14px;line-height:22px;display:flex;overflow:hidden;text-align:left}",
			".schd-entry:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".schd-entryIcon{flex:none;display:inline-flex}",
			".schd-collapsed{border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;margin:0;padding:0;flex:none}",
			".schd-panel{position:fixed;top:0;right:0;bottom:0;width:400px;max-width:100vw;z-index:80;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);border-left:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;box-shadow:-12px 0 32px rgba(0,0,0,.25)}",
			".schd-head{display:flex;align-items:center;gap:8px;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}",
			".schd-title{flex:1;font-size:14px;font-weight:500}",
			".schd-body{flex:1;overflow-y:auto;padding:12px 16px;display:flex;flex-direction:column;gap:12px}",
			".schd-row{display:flex;flex-direction:column;gap:6px;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px}",
			".schd-rowHead{display:flex;align-items:center;gap:8px}",
			".schd-name{flex:1;min-width:0;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".schd-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;word-break:break-all}",
			".schd-error{color:var(--dsw-alias-state-warn-primary);font-size:12px;word-break:break-all}",
			".schd-actions{display:flex;gap:6px;flex-wrap:wrap}",
			".schd-btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);cursor:pointer;border-radius:8px;padding:4px 10px;font-size:12px;font-family:inherit}",
			".schd-btn:hover{border-color:var(--dsw-alias-state-business-primary)}",
			".schd-btn:disabled{opacity:.4;cursor:default}",
			".schd-primary{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-inverted)}",
			".schd-field{display:flex;flex-direction:column;gap:4px}",
			".schd-label{color:var(--dsw-alias-label-secondary);font-size:12px}",
			".schd-input,.schd-select,.schd-textarea{box-sizing:border-box;width:100%;color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 8px;font-size:13px;font-family:inherit}",
			".schd-textarea{min-height:96px;resize:vertical}",
			".schd-input:focus,.schd-select:focus,.schd-textarea:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}",
			".schd-checkRow{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px}",
			".schd-foot{padding:10px 16px;border-top:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);font-size:12px}"
		].join("\n");

		function injectPluginCss() {
			document.querySelectorAll('style[data-plugin-css="dsh-plugin-scheduler/ui.css"]').forEach((el) => el.remove());
			const tag = document.createElement("style");
			tag.dataset.plugin = name;
			tag.dataset.pluginCss = "dsh-plugin-scheduler/ui.css";
			tag.textContent = PLUGIN_CSS;
			document.head.appendChild(tag);
		}

		/** Small inline clock so the entry needs no icon package. */
		function ClockIcon() {
			return jsx("span", {
				className: "schd-entryIcon",
				"aria-hidden": true,
				children: jsx("svg", {
					width: 16, height: 16, viewBox: "0 0 16 16", fill: "none",
					stroke: "currentColor", "stroke-linecap": "round",
					children: [
						jsx("circle", { cx: 8, cy: 8.5, r: 5.8 }),
						jsx("path", { d: "M8 5.4v3.1l2.1 1.4" }),
						jsx("path", { d: "M5.2 1.6h5.6" })
					],
					"stroke-width": 1.5
				})
			});
		}

		const newTaskId = () => `task-${Math.random().toString(36).slice(2, 10)}`;

		const blankDraft = () => ({
			id: newTaskId(),
			name: "",
			prompt: "",
			cwd: "",
			agentPreset: "",
			provider: "",
			model: "",
			enabled: true,
			kind: "interval",
			minutes: 60,
			time: "09:00",
			lastRunAt: null,
			lastSessionId: "",
			lastError: ""
		});

		const formatTime = (ms) => (typeof ms === "number" ? new Date(ms).toLocaleString() : "");

		/** Field binding helper for the draft editor. */
		function Field({ label, children }) {
			return jsx("label", { className: "schd-field", children: [jsx("span", { className: "schd-label", children: label }), children] });
		}

		/**
		 * The whole app lives in one component so the open state and the task
		 * list stay in React state; the panel is position:fixed and therefore
		 * independent of the sidebar's layout.
		 */
		function SchedulerApp(props) {
			const { wide } = props;
			const t = props.t ?? translate;
			const [open, setOpen] = useState(false);
			const [tasks, setTasks] = useState(null);
			const [draft, setDraft] = useState(null);
			const [status, setStatus] = useState("");
			const [busy, setBusy] = useState(false);
			/* provider/model groups for the task form; null = manual entry */
			const [catalog, setCatalog] = useState(null);

			const load = useCallback(async () => {
				try {
					const response = await fetch("/scheduler/tasks");
					const document_ = await response.json();
					setTasks(Array.isArray(document_.tasks) ? document_.tasks : []);
				} catch {
					setStatus("load failed");
				}
			}, []);

			const persist = useCallback(async (nextTasks) => {
				setBusy(true);
				try {
					const response = await fetch("/scheduler/tasks", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ tasks: nextTasks })
					});
					const body = await response.json();
					if (!response.ok) {
						setStatus(body.error ?? String(response.status));
						return false;
					}
					setTasks(body.tasks ?? nextTasks);
					return true;
				} catch {
					setStatus("save failed");
					return false;
				} finally {
					setBusy(false);
				}
			}, []);

			const runNow = useCallback(async (id) => {
				setBusy(true);
				try {
					const response = await fetch("/scheduler/run", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ id })
					});
					const body = await response.json();
					if (!response.ok) setStatus(body.error ?? String(response.status));
				} catch {
					setStatus("run failed");
				} finally {
					setBusy(false);
					void load();
				}
			}, [load]);

			/* the model catalog comes from the magic-context settings bridge; any
			 * failure degrades the form to manual provider/model entry */
			const catalogGroups = catalog?.groups ?? null;
			const providerModels = catalogGroups?.find((group) => group.id === draft?.provider)?.models ?? null;
			const modelOptions = providerModels?.map((model) => (typeof model === "string" ? model : model.id)) ?? [];
			useEffect(() => {
				if (!open) return;
				void load();
				fetch("/magic-context/models/catalog")
					.then((response) => (response.ok ? response.json() : null))
					.then((payload) => {
						setCatalog(payload?.ok === true && Array.isArray(payload.groups) && payload.groups.length > 0 ? payload : null);
					})
					.catch(() => setCatalog(null));
			}, [open, load]);

			const saveDraft = async () => {
				if (!draft.name.trim()) {
					setStatus(t("schd.nameRequired"));
					return;
				}
				if (!draft.prompt.trim()) {
					setStatus(t("schd.promptRequired"));
					return;
				}
				const next = [...(tasks ?? []).filter((task) => task.id !== draft.id), draft];
				if (await persist(next)) {
					setDraft(null);
					setStatus("");
				}
			};

			const removeTask = (id) => {
				if (!window.confirm(t("schd.confirmDelete"))) return;
				void persist((tasks ?? []).filter((task) => task.id !== id));
			};

			const toggleEnabled = (id) => {
				void persist((tasks ?? []).map((task) => (task.id === id ? { ...task, enabled: !task.enabled } : task)));
			};

			const summary = (task) => (task.kind === "daily"
				? t("schd.dailySummary").replace("%s", task.time)
				: t("schd.intervalSummary").replace("%s", String(task.minutes)));

			const entry = jsx("button", {
				type: "button",
				className: wide ? "schd-entry" : "schd-entry schd-collapsed",
				onClick: () => { setOpen(!open); },
				children: [
					jsx(ClockIcon, {}),
					wide ? jsx("span", { children: t("schd.entry") }) : null
				]
			});

			const editor = draft === null ? null : jsx("div", {
				className: "schd-row",
				children: [
					jsx(Field, { label: t("schd.name"), children: jsx("input", {
						className: "schd-input", value: draft.name,
						onChange: (e) => { setDraft({ ...draft, name: e.target.value }); }
					}) }),
					jsx(Field, { label: t("schd.prompt"), children: jsx("textarea", {
						className: "schd-textarea", value: draft.prompt,
						onChange: (e) => { setDraft({ ...draft, prompt: e.target.value }); }
					}) }),
					jsx(Field, { label: t("schd.kind"), children: jsx("select", {
						className: "schd-select", value: draft.kind,
						onChange: (e) => { setDraft({ ...draft, kind: e.target.value }); },
						children: [
							jsx("option", { key: "interval", value: "interval", children: t("schd.interval") }),
							jsx("option", { key: "daily", value: "daily", children: t("schd.daily") })
						]
					}) }),
					draft.kind === "daily" ? jsx(Field, { label: t("schd.time"), children: jsx("input", {
						className: "schd-input", type: "time", value: draft.time,
						onChange: (e) => { setDraft({ ...draft, time: e.target.value || "09:00" }); }
					}) }) : jsx(Field, { label: t("schd.minutes"), children: jsx("input", {
						className: "schd-input", type: "number", min: 5, value: draft.minutes,
						onChange: (e) => { setDraft({ ...draft, minutes: Math.max(5, Number(e.target.value) || 5) }); }
					}) }),
					jsx(Field, { label: t("schd.cwd"), children: jsx("input", {
						className: "schd-input", value: draft.cwd,
						onChange: (e) => { setDraft({ ...draft, cwd: e.target.value }); }
					}) }),
					jsx(Field, { label: t("schd.preset"), children: jsx("input", {
						className: "schd-input", value: draft.agentPreset,
						onChange: (e) => { setDraft({ ...draft, agentPreset: e.target.value }); }
					}) }),
					jsx(Field, { label: t("schd.provider"), children: catalogGroups
						? jsx("select", {
							className: "schd-select", value: draft.provider,
							onChange: (e) => { setDraft({ ...draft, provider: e.target.value, model: "" }); },
							children: [
								jsx("option", { key: "", value: "", children: t("schd.modelDefault") }),
								...catalogGroups.map((group) => jsx("option", { key: group.id, value: group.id, children: group.id }))
							]
						})
						: jsx("input", {
							className: "schd-input", value: draft.provider, placeholder: t("schd.modelManual"),
							onChange: (e) => { setDraft({ ...draft, provider: e.target.value }); }
						})
					}),
					jsx(Field, { label: t("schd.model"), children: !draft.provider
						? jsx("input", { className: "schd-input", disabled: true, placeholder: t("schd.modelDefault") })
						: catalogGroups && modelOptions.length > 0
							? jsx("select", {
								className: "schd-select", value: draft.model,
								onChange: (e) => { setDraft({ ...draft, model: e.target.value }); },
								children: [
									jsx("option", { key: "", value: "", children: t("schd.modelDefault") }),
									...modelOptions.map((id) => jsx("option", { key: id, value: id, children: id }))
								]
							})
							: jsx("input", {
								className: "schd-input", value: draft.model, placeholder: t("schd.modelManual"),
								onChange: (e) => { setDraft({ ...draft, model: e.target.value }); }
							})
					}),
					jsx("div", { className: "schd-meta", children: t("schd.modelHint") }),
					jsx("label", { className: "schd-checkRow", children: [
						jsx("input", {
							type: "checkbox", checked: draft.enabled,
							onChange: (e) => { setDraft({ ...draft, enabled: e.target.checked }); }
						}),
						jsx("span", { children: t("schd.enabled") })
					] }),
					jsx("div", { className: "schd-actions", children: [
						jsx("button", { type: "button", className: "schd-btn schd-primary", disabled: busy, onClick: () => { void saveDraft(); }, children: t("schd.save") }),
						jsx("button", { type: "button", className: "schd-btn", onClick: () => { setDraft(null); }, children: t("schd.cancel") })
					] })
				]
			});

			const list = draft !== null ? null : jsx(Fragment, {
				children: tasks === null
					? jsx("div", { className: "schd-meta", children: t("schd.loading") })
					: tasks.length === 0
						? jsx("div", { className: "schd-meta", children: t("schd.empty") })
						: tasks.map((task) => jsx("div", {
							className: "schd-row",
							key: task.id,
							children: [
								jsx("div", { className: "schd-rowHead", children: [
									jsx("input", {
										type: "checkbox", checked: task.enabled,
										onChange: () => { toggleEnabled(task.id); },
										"aria-label": t("schd.enabled")
									}),
									jsx("span", { className: "schd-name", children: task.name })
								] }),
								jsx("div", { className: "schd-meta", children: summary(task) }),
								jsx("div", { className: "schd-meta", children: `${t("schd.lastRun")}: ${task.lastRunAt ? formatTime(task.lastRunAt) : t("schd.never")}` }),
								task.lastSessionId ? jsx("div", { className: "schd-meta", title: task.lastSessionId, children: `${t("schd.session")}: ${task.lastSessionId.slice(0, 22)}…` }) : null,
								task.lastError ? jsx("div", { className: "schd-error", children: task.lastError }) : null,
								jsx("div", { className: "schd-actions", children: [
									jsx("button", { type: "button", className: "schd-btn", disabled: busy, onClick: () => { void runNow(task.id); }, children: t("schd.runNow") }),
									jsx("button", { type: "button", className: "schd-btn", onClick: () => { setDraft({ ...task }); }, children: t("schd.edit") }),
									jsx("button", { type: "button", className: "schd-btn", onClick: () => { removeTask(task.id); }, children: t("schd.delete") })
								] })
							]
						}))
			});

			const panel = !open ? null : jsx("div", {
				className: "schd-panel",
				children: [
					jsx("div", { className: "schd-head", children: [
						jsx("span", { className: "schd-title", children: t("schd.title") }),
						jsx("button", { type: "button", className: "schd-btn", onClick: () => { void load(); }, children: t("schd.refresh") }),
						jsx("button", { type: "button", className: "schd-btn schd-primary", disabled: draft !== null, onClick: () => { setDraft(blankDraft()); }, children: t("schd.add") })
					] }),
					jsx("div", { className: "schd-body", children: [editor, list] }),
					jsx("div", { className: "schd-foot", children: status || t("schd.serverTime") })
				]
			});

			return jsxs(Fragment, { children: [entry, panel] });
		}

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-plugin-scheduler: dictionaries");
			ctx.effect(() => injectPluginCss(), "dsh-plugin-scheduler: styles");
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "scheduler-panel",
				locale: NS,
				inject: () => ({})
			}, SchedulerApp), "dsh-plugin-scheduler: sidebar entry");
		}

		exports.name = name;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

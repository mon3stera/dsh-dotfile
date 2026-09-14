/**
 * Browser half of dsh-plugin-effects. Hand-written client bundle in the
 * DSH client-modules format (window.__ModuleLoader__.load CJS factory).
 *
 * Features:
 *  - a decorative particle layer rendered on a fixed, pointer-transparent
 *    canvas above the whole shell: rain (falling streaks with wind), stars
 *    (twinkling starfield), snow (swaying flakes), fireflies (wandering
 *    glowing motes) — or none,
 *  - a "背景特效 / Background effects" settings row in Settings > General:
 *    effect chips, an intensity stepper (particle density multiplier) and an
 *    opacity stepper (whole-layer transparency),
 *  - state persisted through the plugin-owned $DSH_HOME/effects/config.json,
 *    so the choice survives restarts.
 *
 * The canvas never intercepts input (pointer-events: none) and the loop
 * pauses while the tab is hidden, so an open-but-backgrounded tab costs
 * nothing.
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-effects",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const jsx = require("react/jsx-runtime").jsx;
		const { defineStore } = require("@deepseek-ai/dsh-client-store");

		const name = "dsh-plugin-effects";
		const inject = ["slots", "locale"];
		const SETTINGS_LOCALE_NS = "dsh-plugin-effects";

		const zh = {
			"effects.title": "背景特效",
			"effects.none": "无",
			"effects.rain": "雨点",
			"effects.stars": "星空",
			"effects.snow": "雪花",
			"effects.fireflies": "萤火虫",
			"effects.orbit": "粒子轨道",
			"effects.intensity": "密度",
			"effects.opacity": "不透明度",
			"effects.hint": "特效绘制在全页面之上的透明画布，不影响任何交互；标签页隐藏时自动暂停以省电。"
		};

		const en = {
			"effects.title": "Background effects",
			"effects.none": "None",
			"effects.rain": "Rain",
			"effects.stars": "Starfield",
			"effects.snow": "Snow",
			"effects.fireflies": "Fireflies",
			"effects.orbit": "Orbit",
			"effects.intensity": "Density",
			"effects.opacity": "Opacity",
			"effects.hint": "Effects render on a pointer-transparent canvas above the page; nothing intercepts input, and the loop pauses while the tab is hidden."
		};

		const EFFECT_IDS = ["none", "rain", "stars", "snow", "fireflies", "orbit"];

		const INTENSITY_MIN = 0.25;
		const INTENSITY_MAX = 2;
		const INTENSITY_STEP = 0.25;
		const OPACITY_MIN = 0.1;
		const OPACITY_MAX = 1;
		const OPACITY_STEP = 0.1;

		const clampIntensity = (value) => (typeof value === "number" && Number.isFinite(value) ? Math.round(Math.min(INTENSITY_MAX, Math.max(INTENSITY_MIN, value)) * 100) / 100 : 1);
		const clampOpacity = (value) => (typeof value === "number" && Number.isFinite(value) ? Math.round(Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, value)) * 10) / 10 : 0.6);
		const clampEffect = (value) => (EFFECT_IDS.includes(value) ? value : "none");

		/** Reference viewport for the density curve (particles scale with area). */
		const REF_AREA = 1280 * 800;
		const DPR_CAP = 2;
		const CANVAS_ID = "dsh-plugin-effects-canvas";
		const CANVAS_Z = 2147483000;

		/** Per-effect base particle counts at the reference area × intensity 1. */
		const BASE_COUNT = { rain: 160, stars: 200, snow: 130, fireflies: 40, orbit: 130 };

		const rand = (min, max) => min + Math.random() * (max - min);

		/** One rain streak: falls along a slightly tilted vector, respawns on top. */
		const spawnRain = (w, h) => ({
			x: rand(-0.1 * w, 1.1 * w),
			y: rand(-h, 0),
			len: rand(10, 26),
			speed: rand(700, 1400),
			drift: rand(60, 160)
		});

		const stepRain = (p, dt, w, h) => {
			p.x += p.drift * dt;
			p.y += p.speed * dt;
			if (p.y > h + 30) {
				const next = spawnRain(w, h);
				next.y = rand(-60, -10);
				Object.assign(p, next);
			}
		};

		const drawRain = (g, p) => {
			const norm = p.len / Math.hypot(p.drift, p.speed);
			g.strokeStyle = "rgba(158, 197, 255, 0.55)";
			g.lineWidth = 1.2;
			g.beginPath();
			g.moveTo(p.x, p.y);
			g.lineTo(p.x - p.drift * norm, p.y - p.speed * norm);
			g.stroke();
		};

		/** One star: fixed position, sinusoidal twinkle; larger stars flare. */
		const spawnStar = (w, h) => ({
			x: rand(0, w),
			y: rand(0, h),
			r: rand(0.4, 1.8),
			phase: rand(0, Math.PI * 2),
			freq: rand(0.4, 1.6),
			base: rand(0.35, 0.95)
		});

		const drawStar = (g, p, time) => {
			const alpha = p.base * (0.5 + 0.5 * Math.sin(time * p.freq + p.phase));
			g.fillStyle = `rgba(255, 255, 255, ${alpha.toFixed(3)})`;
			g.beginPath();
			g.arc(p.x, p.y, p.r, 0, Math.PI * 2);
			g.fill();
			if (p.r > 1.3) {
				g.strokeStyle = `rgba(220, 235, 255, ${(alpha * 0.5).toFixed(3)})`;
				g.lineWidth = 0.6;
				g.beginPath();
				g.moveTo(p.x - p.r * 3.2, p.y);
				g.lineTo(p.x + p.r * 3.2, p.y);
				g.moveTo(p.x, p.y - p.r * 3.2);
				g.lineTo(p.x, p.y + p.r * 3.2);
				g.stroke();
			}
		};

		/** One snowflake: falls with a sinusoidal horizontal sway, wraps around. */
		const spawnSnow = (w, h) => ({
			x: rand(0, w),
			y: rand(-h, 0),
			r: rand(1, 3.2),
			speed: rand(30, 90),
			sway: rand(10, 40),
			freq: rand(0.3, 1.1),
			phase: rand(0, Math.PI * 2)
		});

		const stepSnow = (p, dt, time, w, h) => {
			p.y += p.speed * dt;
			p.x += Math.sin(time * p.freq + p.phase) * p.sway * dt;
			if (p.y > h + 8) {
				p.y = rand(-30, -8);
				p.x = rand(0, w);
			}
			if (p.x < -8) p.x = w + 7;
			else if (p.x > w + 8) p.x = -7;
		};

		const drawSnow = (g, p) => {
			g.fillStyle = "rgba(255, 255, 255, 0.8)";
			g.beginPath();
			g.arc(p.x, p.y, p.r, 0, Math.PI * 2);
			g.fill();
		};

		/** One firefly: random-walk heading, pulsing radial glow, edge bounce. */
		const spawnFirefly = (w, h) => ({
			x: rand(0, w),
			y: rand(0, h),
			angle: rand(0, Math.PI * 2),
			speed: rand(10, 30),
			r: rand(1.5, 3),
			phase: rand(0, Math.PI * 2),
			freq: rand(0.5, 1.4)
		});

		const stepFirefly = (p, dt, w, h) => {
			p.angle += rand(-1.2, 1.2) * dt;
			p.x += Math.cos(p.angle) * p.speed * dt;
			p.y += Math.sin(p.angle) * p.speed * dt;
			if (p.x < -20) p.x = w + 19;
			else if (p.x > w + 20) p.x = -19;
			if (p.y < -20) p.y = h + 19;
			else if (p.y > h + 20) p.y = -19;
		};

		const drawFirefly = (g, p, time) => {
			const alpha = 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(time * p.freq + p.phase));
			const glow = p.r * 6;
			const grad = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, glow);
			grad.addColorStop(0, `rgba(214, 255, 140, ${(alpha * 0.9).toFixed(3)})`);
			grad.addColorStop(1, "rgba(214, 255, 140, 0)");
			g.fillStyle = grad;
			g.beginPath();
			g.arc(p.x, p.y, glow, 0, Math.PI * 2);
			g.fill();
			g.fillStyle = `rgba(244, 255, 214, ${alpha.toFixed(3)})`;
			g.beginPath();
			g.arc(p.x, p.y, p.r, 0, Math.PI * 2);
			g.fill();
		};

		/** Orbit effect (attractor + tangential velocity): gray particles random-
		 * walk until they enter the pointer's capture radius, then ease onto a
		 * circular orbit around it; they are released when the pointer leaves or
		 * they drift past the release radius (hysteresis, so border particles do
		 * not flicker between states). */
		const ORBIT_CAPTURE_RADIUS = 140;
		const ORBIT_RELEASE_RADIUS = 190;

		const spawnOrbit = (w, h) => ({
			x: rand(0, w),
			y: rand(0, h),
			vx: rand(-20, 20),
			vy: rand(-20, 20),
			captured: false,
			progress: 0,
			orbitRadius: 0,
			angle: 0,
			omega: 0
		});

		const releaseOrbit = (p) => {
			p.captured = false;
			p.progress = 0;
			p.vx = rand(-30, 30);
			p.vy = rand(-30, 30);
		};

		const stepOrbit = (p, dt, mx, my, inside, w, h) => {
			if (inside && !p.captured) {
				const dx = p.x - mx;
				const dy = p.y - my;
				if (dx * dx + dy * dy < ORBIT_CAPTURE_RADIUS * ORBIT_CAPTURE_RADIUS) {
					const dist = Math.max(24, Math.hypot(dx, dy));
					p.captured = true;
					p.progress = 0;
					p.orbitRadius = dist;
					p.angle = Math.atan2(dy, dx);
					/* tangential speed roughly conserved across radii: inner rings spin faster */
					p.omega = (Math.random() < 0.5 ? -1 : 1) * rand(1.2, 2.4) * Math.min(1.6, 0.6 + Math.sqrt(90 / dist));
					return;
				}
			}
			if (p.captured) {
				if (!inside || Math.hypot(p.x - mx, p.y - my) > ORBIT_RELEASE_RADIUS) {
					releaseOrbit(p);
					return;
				}
				p.progress = Math.min(1, p.progress + dt * 2);
				p.angle += p.omega * dt;
				const tx = mx + Math.cos(p.angle) * p.orbitRadius;
				const ty = my + Math.sin(p.angle) * p.orbitRadius;
				const ease = Math.min(1, dt * 6 * p.progress + dt);
				p.x += (tx - p.x) * ease;
				p.y += (ty - p.y) * ease;
				return;
			}

			/* free: bounded random walk */
			p.vx = Math.max(-40, Math.min(40, p.vx + rand(-60, 60) * dt));
			p.vy = Math.max(-40, Math.min(40, p.vy + rand(-60, 60) * dt));
			p.x += p.vx * dt;
			p.y += p.vy * dt;
			if (p.x < -8) p.x = w + 7;
			else if (p.x > w + 8) p.x = -7;
			if (p.y < -8) p.y = h + 7;
			else if (p.y > h + 8) p.y = -7;
		};

		const drawOrbit = (g, p) => {
			g.fillStyle = p.captured ? "rgba(190, 195, 205, 0.75)" : "rgba(185, 190, 200, 0.4)";
			g.beginPath();
			g.arc(p.x, p.y, p.captured ? 1.8 : 1.4, 0, Math.PI * 2);
			g.fill();
		};

		/**
		 * The canvas engine. Owns the fixed overlay canvas, the particle set and
		 * the requestAnimationFrame loop; `apply(config)` is the only entry the
		 * settings state talks to.
		 */
		function createEngine() {
			let canvas = null;
			let g = null;
			let raf = 0;
			let running = false;
			let width = 0;
			let height = 0;
			let particles = [];
			let time = 0;
			let last = 0;
			let generated = "";
			const current = { effect: "none", intensity: 1, opacity: 0.6 };
			const mouse = { x: 0, y: 0, inside: false };
			const onResize = () => layout();

			/** Pointer position in CSS pixels — the canvas is a fixed full-viewport
			 * overlay, so clientX/Y map straight onto the drawing coordinates. */
			const onMouseMove = (e) => {
				mouse.x = e.clientX;
				mouse.y = e.clientY;
				mouse.inside = true;
			};

			/** mouseleave reaches the document when the pointer exits the window. */
			const onMouseLeave = () => {
				mouse.inside = false;
			};

			const onVisibility = () => {
				if (document.hidden) stopLoop();
				else startLoop();
			};

			const count = () => Math.round(BASE_COUNT[current.effect] * current.intensity * Math.sqrt((width * height) / REF_AREA));

			const spawn = () => {
				const make = { rain: spawnRain, stars: spawnStar, snow: spawnSnow, fireflies: spawnFirefly, orbit: spawnOrbit }[current.effect];
				particles = [];
				for (let i = 0; i < count(); i += 1) particles.push(make(width, height));
				generated = `${current.effect}@${current.intensity}@${width}x${height}`;
			};

			/** Resize the backing store to the viewport (DPR-capped) and respawn. */
			const layout = () => {
				if (!canvas) return;
				const dpr = Math.min(DPR_CAP, window.devicePixelRatio || 1);
				width = Math.max(1, window.innerWidth);
				height = Math.max(1, window.innerHeight);
				canvas.width = Math.round(width * dpr);
				canvas.height = Math.round(height * dpr);
				canvas.style.width = `${width}px`;
				canvas.style.height = `${height}px`;
				if (g) g.setTransform(dpr, 0, 0, dpr, 0, 0);
				spawn();
			};

			const frame = (now) => {
				if (!running || !g) return;
				const dt = Math.min(0.1, last ? (now - last) / 1000 : 0.016);
				last = now;
				time += dt;
				g.clearRect(0, 0, width, height);
				if (current.effect === "rain") {
					for (const p of particles) {
						stepRain(p, dt, width, height);
						drawRain(g, p);
					}
				} else if (current.effect === "snow") {
					for (const p of particles) {
						stepSnow(p, dt, time, width, height);
						drawSnow(g, p);
					}
				} else if (current.effect === "fireflies") {
					for (const p of particles) {
						stepFirefly(p, dt, width, height);
						drawFirefly(g, p, time);
					}
				} else if (current.effect === "stars") {
					for (const p of particles) drawStar(g, p, time);
				} else if (current.effect === "orbit") {
					for (const p of particles) {
						stepOrbit(p, dt, mouse.x, mouse.y, mouse.inside, width, height);
						drawOrbit(g, p);
					}
				}
				raf = requestAnimationFrame(frame);
			};

			const startLoop = () => {
				if (running || !g || current.effect === "none" || typeof requestAnimationFrame !== "function") return;
				if (document.hidden) return;
				running = true;
				last = 0;
				raf = requestAnimationFrame(frame);
			};

			const stopLoop = () => {
				running = false;
				if (raf) cancelAnimationFrame(raf);
				raf = 0;
			};

			const ensureCanvas = () => {
				if (canvas) return true;
				if (typeof document === "undefined" || !document.body) return false;
				canvas = document.createElement("canvas");
				canvas.id = CANVAS_ID;
				/* inline (not CSS-rule) so the overlay survives any host stylesheet
				 * reorder: fixed above everything, never intercepting input */
				const style = canvas.style;
				style.position = "fixed";
				style.inset = "0";
				style.pointerEvents = "none";
				style.zIndex = String(CANVAS_Z);
				style.display = "none";
				g = canvas.getContext("2d");
				if (!g) {
					canvas = null;
					return false;
				}
				window.addEventListener("resize", onResize);
				document.addEventListener("visibilitychange", onVisibility);
				document.addEventListener("mousemove", onMouseMove);
				document.addEventListener("mouseleave", onMouseLeave);
				document.body.appendChild(canvas);
				layout();
				return true;
			};

			return {
				/** Push a (possibly partial) config; no-op fields keep their value. */
				apply(patch) {
					if (patch.effect !== undefined) current.effect = clampEffect(patch.effect);
					if (patch.intensity !== undefined) current.intensity = clampIntensity(patch.intensity);
					if (patch.opacity !== undefined) current.opacity = clampOpacity(patch.opacity);
					if (current.effect === "none") {
						stopLoop();
						if (canvas) canvas.style.display = "none";
						return;
					}
					if (!ensureCanvas()) return;
					canvas.style.display = "block";
					canvas.style.opacity = String(current.opacity);
					const wanted = `${current.effect}@${current.intensity}@${width}x${height}`;
					if (wanted !== generated) spawn();
					startLoop();
				},
				dispose() {
					stopLoop();
					if (canvas) {
						window.removeEventListener("resize", onResize);
						document.removeEventListener("visibilitychange", onVisibility);
						document.removeEventListener("mousemove", onMouseMove);
						document.removeEventListener("mouseleave", onMouseLeave);
						canvas.remove();
					}
					canvas = null;
					g = null;
					particles = [];
				}
			};
		}

		/* ---------- settings row ---------- */

		const PLUGIN_CSS = [
			".dfe-group{display:flex;flex-direction:column;gap:10px;padding:2px 2px 4px}",
			".dfe-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}",
			".dfe-chips{display:flex;flex-wrap:wrap;gap:6px}",
			".dfe-chip{box-sizing:border-box;border:1px solid var(--dsw-alias-border-primary);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:999px;padding:3px 12px;font-size:12px;line-height:18px;cursor:pointer}",
			".dfe-chip:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}",
			".dfe-chip[data-active=\"true\"]{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}",
			".dfe-row{display:flex;align-items:center;justify-content:space-between;gap:10px}",
			".dfe-label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
			".dfe-stepper{display:inline-flex;align-items:center;gap:6px}",
			".dfe-step{box-sizing:border-box;width:22px;height:22px;border:none;border-radius:6px;background:transparent;color:inherit;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font-size:13px}",
			".dfe-step:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dfe-step:disabled{opacity:0.4;cursor:default}",
			".dfe-value{min-width:44px;text-align:center;color:var(--dsw-alias-label-primary);font-size:12px;font-variant-numeric:tabular-nums}",
			".dfe-hint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}"
		].join("\n");

		function injectCss() {
			document.querySelectorAll(`style[data-plugin-css="${name}/ui.css"]`).forEach((el) => el.remove());
			const tag = document.createElement("style");
			tag.dataset.plugin = name;
			tag.dataset.pluginCss = `${name}/ui.css`;
			tag.textContent = PLUGIN_CSS;
			document.head.appendChild(tag);
		}

		function createEffectsStore() {
			return defineStore({
				init: () => ({ effect: "none", intensity: 1, opacity: 0.6, revision: -1 }),
				actions: {
					sync: (d, effect, intensity, opacity, revision) => {
						if (revision <= d.revision) return;
						d.effect = effect;
						d.intensity = intensity;
						d.opacity = opacity;
						d.revision = revision;
					}
				}
			});
		}

		/** One bounded stepper: −/value/+ like the font row's. */
		function Stepper({ label, value, display, min, max, step, onStep }) {
			return jsx("div", {
				className: "dfe-row",
				children: [
					jsx("span", { className: "dfe-label", children: label }),
					jsx("div", {
						className: "dfe-stepper",
						children: [
							jsx("button", {
								type: "button",
								className: "dfe-step",
								"aria-label": "−",
								disabled: value <= min,
								onClick: () => { onStep(value - step); },
								children: "−"
							}),
							jsx("span", { className: "dfe-value", children: display }),
							jsx("button", {
								type: "button",
								className: "dfe-step",
								"aria-label": "+",
								disabled: value >= max,
								onClick: () => { onStep(value + step); },
								children: "+"
							})
						]
					})
				]
			});
		}

		/** Settings > General row: effect chips + density/opacity steppers. */
		function EffectsRow({ t, useStore, setEffect, setIntensity, setOpacity }) {
			const s = useStore((st) => st);
			return jsx("div", {
				className: "dfe-group",
				children: [
					jsx("div", { className: "dfe-title", children: t("effects.title") }),
					jsx("div", {
						className: "dfe-chips",
						role: "group",
						"aria-label": t("effects.title"),
						children: EFFECT_IDS.map((id) => jsx("button", {
							key: id,
							type: "button",
							className: "dfe-chip",
							"data-active": String(s.effect === id),
							"aria-pressed": String(s.effect === id),
							onClick: () => { setEffect(id); },
							children: t(`effects.${id}`)
						}))
					}),
					jsx(Stepper, {
						label: t("effects.intensity"),
						value: s.intensity,
						display: `${s.intensity.toFixed(2)}×`,
						min: INTENSITY_MIN,
						max: INTENSITY_MAX,
						step: INTENSITY_STEP,
						onStep: setIntensity
					}),
					jsx(Stepper, {
						label: t("effects.opacity"),
						value: s.opacity,
						display: `${Math.round(s.opacity * 100)}%`,
						min: OPACITY_MIN,
						max: OPACITY_MAX,
						step: OPACITY_STEP,
						onStep: setOpacity
					}),
					jsx("div", { className: "dfe-hint", children: t("effects.hint") })
				]
			});
		}

		function apply(ctx) {
			const store = createEffectsStore();
			const engine = createEngine();
			let bound = null;
			let saveTimer = null;
			const state = { effect: "none", intensity: 1, opacity: 0.6, revision: -1 };

			const syncStore = () => {
				if (bound) bound.sync(state.effect, state.intensity, state.opacity, state.revision);
			};

			/** Push the current state into the canvas engine. */
			const applyEffect = () => {
				engine.apply({ effect: state.effect, intensity: state.intensity, opacity: state.opacity });
			};

			/** Persist after a quiet period; failures are swallowed (next change retries). */
			const scheduleSave = () => {
				if (saveTimer) clearTimeout(saveTimer);
				saveTimer = setTimeout(() => {
					saveTimer = null;
					fetch("/effects/config", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ effect: state.effect, intensity: state.intensity, opacity: state.opacity })
					}).catch(() => { /* best-effort; the next change retries */ });
				}, 300);
			};

			/** Apply one validated patch from a setter or the restored config. */
			const commit = (patch) => {
				let changed = false;
				if (patch.effect !== undefined) {
					const value = clampEffect(patch.effect);
					if (value !== state.effect) {
						state.effect = value;
						changed = true;
					}
				}
				if (patch.intensity !== undefined) {
					const value = clampIntensity(patch.intensity);
					if (value !== state.intensity) {
						state.intensity = value;
						changed = true;
					}
				}
				if (patch.opacity !== undefined) {
					const value = clampOpacity(patch.opacity);
					if (value !== state.opacity) {
						state.opacity = value;
						changed = true;
					}
				}
				if (!changed) return;
				state.revision += 1;
				applyEffect();
				syncStore();
				scheduleSave();
			};

			/** Restore the persisted config at startup (best effort). */
			const loadConfig = () => {
				fetch("/effects/config")
					.then((response) => (response.ok ? response.json() : null))
					.then((config) => {
						if (!config || typeof config !== "object") return;
						commit({ effect: config.effect, intensity: config.intensity, opacity: config.opacity });
					})
					.catch(() => { /* host route may be absent until restart */ });
			};

			const injected = (actions) => {
				bound = actions;
				syncStore();
				return {
					setEffect: (effect) => { commit({ effect }); },
					setIntensity: (value) => { commit({ intensity: value }); },
					setOpacity: (value) => { commit({ opacity: value }); }
				};
			};

			ctx.effect(() => ctx.locale.register(SETTINGS_LOCALE_NS, { zh, en }), "dsh-plugin-effects: row dictionaries");
			ctx.effect(() => injectCss(), "dsh-plugin-effects: row styles");
			ctx.effect(() => () => {
				if (saveTimer) clearTimeout(saveTimer);
				engine.dispose();
			}, "dsh-plugin-effects: teardown");
			loadConfig();
			ctx.slots.inject("settings.general.item", () => ctx.slots.register({
				name: "settings.general.item",
				id: "ui-effects",
				order: 22,
				store,
				locale: SETTINGS_LOCALE_NS,
				inject: injected
			}, EffectsRow));
		}

		exports.name = name;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

// desktop_screenshot: captures the whole desktop, one output, or one window
// and returns the pixels as a model-visible image block. Screen captures go
// through grim (wlr-screencopy, which niri implements); window captures try
// niri's screenshot-window action first and fall back to a focused-screen
// capture because that action has been observed to produce nothing on some
// niri builds.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { defineTool } from "@deepseek-ai/dsh-tools";

import { runFile } from "./exec.js";
import { expandHome, sessionEnv } from "./env.js";
import { desktopBounds, focusWindow } from "./niri.js";
import { assertImageCapableRoute, fitImage, grimScale, IMAGE_VALUE_SCHEMA, imageRefFromValue } from "./image.js";

/** @module dsh-plugin-computer-use/tool-screenshot */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Width/height of a PNG buffer from its IHDR chunk. */
export function pngSize(data) {
	if (data.length < 24 || data.readUInt32BE(0) !== 0x89504e47) return undefined;
	return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

function newestImage(dir) {
	try {
		return readdirSync(dir)
			.filter((name) => /\.(png|jpe?g|webp)$/i.test(name))
			.map((name) => join(dir, name))
			.map((path) => ({ path, mtime: statSync(path).mtimeMs }))
			.sort((a, b) => b.mtime - a.mtime)[0];
	} catch {
		return undefined;
	}
}

/** Build the screenshot tool over one resolved plugin config and its context. */
export function createScreenshotTool(ctx, config) {
	const screenshotDir = expandHome(config.screenshotDir);

	return defineTool({
		name: "desktop_screenshot",
		description: [
			"Capture the user's niri/Wayland desktop and return the image so you can see it.",
			'target "screen" captures the whole desktop (or a single monitor via `output`);',
			'target "window" captures one window by its id from desktop_windows.',
			"The result states the exact mapping from pixels you measure on the image to desktop coordinates for desktop_mouse.",
		].join(" "),
		parameters: {
			target: { type: "string", enum: ["screen", "window"], description: "Capture scope. Default screen." },
			window_id: { type: "number", description: "Window id from desktop_windows; required for target window." },
			output: { type: "string", description: "Monitor name (niri output) to capture instead of the whole desktop." },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					image: IMAGE_VALUE_SCHEMA,
					detail: { type: "string", required: true },
				},
			},
			render: (args, value) => [
				{ type: "text", text: value.detail },
				{ type: "image", attachment: imageRefFromValue(value.image) },
			],
		},
		isConcurrencySafe: () => true,
		timeoutMs: 30_000,
		async execute(args, exec) {
			await assertImageCapableRoute(ctx, exec);
			const attachments = ctx.get("attachments");
			if (attachments === undefined) throw new Error("cannot capture a screenshot: no attachment service is mounted");

			const limits = attachments.imageLimits;
			const bounds = await desktopBounds();

			const capture = args.target === "window"
				? await captureWindow(args, bounds, limits)
				: await captureScreen(args, bounds, limits);

			const stored = await attachments.saveImage({
				data: capture.data,
				mediaType: capture.mediaType,
				name: `desktop-${capture.kind}.jpg`,
			});

			return {
				image: {
					attachmentId: stored.attachmentId,
					mediaType: stored.mediaType,
					bytes: stored.bytes,
					width: stored.width,
					height: stored.height,
				},
				detail: capture.detail(stored.width, stored.height),
			};
		},
		presentCall(args) {
			return {
				card: "generic",
				title: args.target === "window" ? `Screenshot window ${args.window_id ?? ""}` : "Screenshot desktop",
				kind: "read",
			};
		},
	});

	/** Full-desktop (or single-output) capture through grim. */
	async function captureScreen(args, bounds, limits) {
		const selected = args.output === undefined
			? undefined
			: Object.entries(bounds.outputs).find(([name]) => name === args.output);
		if (args.output !== undefined && selected === undefined) {
			throw new Error(`no output named "${args.output}"; available: ${Object.keys(bounds.outputs).join(", ")}`);
		}

		const logical = selected === undefined ? bounds : selected[1].logical;
		const scale = grimScale(logical.width, logical.height, limits.maxImageDimension);

		const args_ = ["-t", "jpeg", "-q", "88"];
		if (scale < 1) args_.push("-s", String(scale));
		if (selected !== undefined) args_.push("-o", selected[0]);
		args_.push("-");

		const result = await runFile("grim", args_, { env: sessionEnv(), timeoutMs: 15_000 });
		if (result.stdout.length === 0) throw new Error("grim produced no image; is a Wayland session running?");

		const scope = selected === undefined ? "full desktop" : `output ${selected[0]}`;
		return {
			data: result.stdout,
			mediaType: "image/jpeg",
			kind: "screen",
			detail: (width, height) => [
				`desktop_screenshot: ${scope}, ${width}x${height} px (captured at scale ${scale} of ${logical.width}x${logical.height} logical px).`,
				`Coordinate mapping for desktop_mouse: desktop logical = (${logical.x} + image_x / ${scale}, ${logical.y} + image_y / ${scale}).`,
			].join(" "),
		};
	}

	/** Window capture: niri screenshot-window, falling back to focus + grim. */
	async function captureWindow(args, bounds, limits) {
		if (args.window_id === undefined) throw new Error('target "window" requires window_id (from desktop_windows)');
		const windowId = args.window_id;

		const before = newestImage(screenshotDir);
		try {
			await runFile("niri", ["msg", "action", "screenshot-window", "--id", String(windowId)], { env: sessionEnv(), timeoutMs: 8_000 });
		} catch {
			// fall through to the focused-screen fallback
		}
		for (let waited = 0; waited < 2500; waited += 250) {
			await sleep(250);
			const newest = newestImage(screenshotDir);
			if (newest === undefined || before === undefined) continue;
			if (newest.path === before.path && newest.mtime <= before.mtime) continue;

			const data = readFileSync(newest.path);
			const original = pngSize(data);
			const fitted = await fitImage(data, "image/png", limits);
			if (fitted === undefined) continue;

			return {
				data: fitted.data,
				mediaType: fitted.mediaType,
				kind: "window",
				detail: (width, height) => [
					`desktop_screenshot: window ${windowId} via niri screenshot-window (${basename(newest.path)}).`,
					original === undefined || (original.width === width && original.height === height)
						? "Image pixels equal window-local pixels; window position on the desktop is not encoded in the image."
						: `Downscaled from ${original.width}x${original.height}; multiply measured coordinates by ${(original.width / width).toFixed(2)} for window-local pixels.`,
				].join(" "),
			};
		}

		const focused = await focusWindow(windowId);
		await sleep(400);
		const note = focused
			? `niri screenshot-window produced no image, so this is the full desktop after focusing window ${windowId}; the target is focused but neighbours may be visible.`
			: `niri screenshot-window produced no image and focus-window failed too; this is the current desktop and window ${windowId} may not be visible on it.`;
		const capture = await captureScreen({}, bounds, limits);
		return { ...capture, detail: (width, height) => `${capture.detail(width, height)} ${note}` };
	}
}

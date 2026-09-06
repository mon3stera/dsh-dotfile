// Shared image plumbing for desktop_screenshot: the value schema, the
// attachment ref an ImageBlock carries, the route image-input gate, and the
// optional sharp-based downscale that keeps captures inside the attachment
// store's admission limits.
import { AttachmentId } from "@deepseek-ai/dsh-attachment";

/** @module dsh-plugin-computer-use/image */

export const IMAGE_VALUE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		attachmentId: { type: "string", required: true },
		mediaType: { type: "string", enum: ["image/png", "image/jpeg", "image/webp", "image/gif"], required: true },
		bytes: { type: "integer", required: true },
		width: { type: "integer", required: true },
		height: { type: "integer", required: true },
	},
};

/** The branded attachment reference an `{type: "image"}` block carries. */
export function imageRefFromValue(image) {
	return {
		attachmentId: AttachmentId(image.attachmentId),
		mediaType: image.mediaType,
		bytes: image.bytes,
		width: image.width,
		height: image.height,
	};
}

/**
 * Require the calling session's routed model to declare image input. Without
 * this the attachment is stored but the model never sees it.
 */
export async function assertImageCapableRoute(ctx, exec) {
	const routed = exec.agent?.session.requestHeader()?.config;
	const provider = routed?.provider ?? exec.agent?.options.provider;
	const model = routed?.model ?? exec.agent?.options.model;
	const llm = ctx.get("llm");
	if (provider === undefined || model === undefined || llm === undefined) {
		throw new Error("cannot capture a screenshot: the current model route could not be resolved");
	}

	const active = await llm.resolveModelInfo(provider, model, exec.signal);
	if (active.inputModalities === undefined || !active.inputModalities.includes("image")) {
		throw new Error(`cannot capture a screenshot: model "${model}" does not declare image input; switch to an image-capable model first`);
	}
}

/** `sharp` when the host deployment ships it; undefined otherwise. */
async function loadSharp() {
	try {
		return await import("sharp");
	} catch {
		return undefined;
	}
}

/**
 * Re-encode `data` so it fits `limits`, using sharp when available. Returns
 * `{data, mediaType, downscaledFrom?}` or `undefined` when sharp is missing
 * and the bytes still exceed the limits.
 */
export async function fitImage(data, mediaType, limits) {
	const maxDimension = limits.maxImageDimension;
	const maxBytes = Math.min(limits.maxImageBytes, limits.maxMessageImageBytes);
	if (data.length <= maxBytes) return { data, mediaType };

	const sharp = await loadSharp();
	if (sharp === undefined) return undefined;

	let image = sharp(data, { animated: false });
	const metadata = await image.metadata();
	const width = metadata.width ?? 0;
	const height = metadata.height ?? 0;

	let scale = 1;
	if (width > maxDimension || height > maxDimension) {
		scale = Math.min(maxDimension / width, maxDimension / height);
	}

	const outputType = mediaType === "image/jpeg" || scale < 0.9 ? "jpeg" : mediaType === "image/webp" ? "webp" : "png";
	let attempt = image;
	if (scale < 1) attempt = attempt.resize(Math.round(width * scale), Math.round(height * scale));

	for (let round = 0; round < 3; round += 1) {
		const encoded = await attempt.toFormat(outputType, { quality: 80 }).toBuffer();
		if (encoded.length <= maxBytes) {
			return {
				data: encoded,
				mediaType: outputType === "jpeg" ? "image/jpeg" : outputType === "webp" ? "image/webp" : "image/png",
				downscaledFrom: scale < 1 ? { width, height } : undefined,
			};
		}
		scale = scale * 0.7;
		attempt = sharp(data, { animated: false }).resize(Math.round(width * scale), Math.round(height * scale));
	}
	return undefined;
}

/** Scale `grim` needs so a logical `width`x`height` capture fits the dimension limit. */
export function grimScale(width, height, maxDimension) {
	const scale = Math.min(1, maxDimension / width, maxDimension / height);
	return Math.round(scale * 100) / 100;
}

/**
 * dsh-plugin-image-model: expose image-generation endpoints as selectable models.
 *
 * The harness LLM registry describes conversational routes: model metadata
 * declares `inputModalities` but nothing about output, and the configurable
 * pi-ai protocols are all streaming chat wire formats. An image endpoint
 * therefore cannot be reached by adding a model id to an existing provider - 
 * the request would be posted to `/chat/completions`.
 *
 * It can, however, be reached by registering an adapter. `image` is a declared
 * content-block type, and the client renders an image block in an assistant
 * message, so an adapter that yields one image block and finishes produces
 * exactly the intended behaviour: pick the model, send a prompt, get a picture.
 * Because the adapter never yields a tool call, the agent loop runs one step and
 * stops, so the route generates and cannot converse.
 *
 * Configuration (profile loader patch):
 *
 * - id: dsh-plugin-image-model
 *     name: dsh-plugin-image-model
 *     config:
 *       providers:
 * - id: torchai-image
 *           name: TorchAI Image
 *           baseURL: https://torchai.ai/v1
 *           apiKeyEnv: OPENAI_API_KEY
 *           edits: true            # allow refining the previous image
 *           models:
 * - id: gpt-image-1
 *               name: GPT Image 1
 *               size: "1024x1024"
 *
 * Every declared model appears in the model selector for the route's provider.
 * Only options declared here are sent, because gateways disagree on which
 * parameters they accept and an unknown one is rejected outright.
 *
 * @module dsh-plugin-image-model
 */
import z from "@deepseek-ai/schemastery";
import { ImageModelAdapter, DEFAULT_CONTEXT_WINDOW } from "./adapter.js";

export const name = "dsh-plugin-image-model";

export const Config = z.object({
  providers: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        baseURL: z.string(),
        apiKeyEnv: z.string(),
        edits: z.boolean().default(true),
        contextWindow: z.number().default(DEFAULT_CONTEXT_WINDOW),
        models: z
          .array(
            z.object({
              id: z.string(),
              name: z.string(),
              description: z.string(),
              size: z.string(),
              quality: z.string(),
              background: z.string(),
              outputFormat: z.string(),
              responseFormat: z.string(),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
});

/**
 * Validate and normalize one configured route.
 *
 * A route with no usable id, baseURL, or model is dropped rather than
 * registered, because registering it would put a provider in the model selector
 * that fails on first use.
 *
 * @param route - one raw configuration entry.
 * @returns the normalized route, or undefined when it is unusable.
 */
export function normalizeRoute(route) {
  const id = typeof route?.id === "string" ? route.id.trim() : "";
  const baseURL = typeof route?.baseURL === "string" ? route.baseURL.trim() : "";
  if (id === "" || baseURL === "") return undefined;
  const models = (Array.isArray(route.models) ? route.models : [])
    .map((model) => {
      const modelId = typeof model?.id === "string" ? model.id.trim() : "";
      if (modelId === "") return undefined;
      return {
        id: modelId,
        name: typeof model.name === "string" && model.name !== "" ? model.name : modelId,
        ...typeof model.description === "string" && model.description !== "" ? { description: model.description } : {},
        ...typeof model.size === "string" && model.size !== "" ? { size: model.size } : {},
        ...typeof model.quality === "string" && model.quality !== "" ? { quality: model.quality } : {},
        ...typeof model.background === "string" && model.background !== "" ? { background: model.background } : {},
        ...typeof model.outputFormat === "string" && model.outputFormat !== "" ? { outputFormat: model.outputFormat } : {},
        ...typeof model.responseFormat === "string" && model.responseFormat !== "" ? { responseFormat: model.responseFormat } : {},
      };
    })
    .filter((model) => model !== undefined);
  if (models.length === 0) return undefined;
  const contextWindow = Number.isSafeInteger(route.contextWindow) && route.contextWindow > 0
    ? route.contextWindow
    : DEFAULT_CONTEXT_WINDOW;
  return {
    id,
    name: typeof route.name === "string" && route.name !== "" ? route.name : id,
    baseURL,
    ...typeof route.apiKeyEnv === "string" && route.apiKeyEnv !== "" ? { apiKeyEnv: route.apiKeyEnv } : {},
    edits: route.edits !== false,
    contextWindow,
    models,
  };
}

/**
 * Normalize the whole provider list, rejecting duplicate ids.
 * @param providers - the raw configured provider list.
 * @returns usable routes in configuration order.
 */
export function normalizeRoutes(providers) {
  const seen = new Set();
  const routes = [];
  for (const raw of Array.isArray(providers) ? providers : []) {
    const route = normalizeRoute(raw);
    if (route === undefined || seen.has(route.id)) continue;
    seen.add(route.id);
    routes.push(route);
  }
  return routes;
}

export function apply(ctx, config) {
  const routes = normalizeRoutes(config?.providers);
  if (routes.length === 0) {
    ctx.logger?.info?.("dsh-plugin-image-model: no usable image providers configured");
    return;
  }
  // The llm registry is the only hard dependency. Attachments are resolved
  // lazily per call: the store is mounted by the host, and a call that arrives
  // without it must fail with a clear reason rather than prevent registration.
  ctx.inject(["llm"], (llmCtx) => {
    const adapter = new ImageModelAdapter({
      routes,
      attachments: () => llmCtx.get("attachments"),
    });
    // The registration handle is itself the disposer, so it is returned directly.
    llmCtx.effect(
      () => llmCtx.llm.registerAdapter(routes.map((route) => route.id), adapter),
      `${name}: image adapters`,
    );
  });
}

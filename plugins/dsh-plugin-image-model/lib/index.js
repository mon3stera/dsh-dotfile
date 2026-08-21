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
// Route normalization lives in config.js so the settings bridge and this entry
// share one definition of what a usable route is.
import { configPath, createSettingsBridge } from "./settings.js";

export { normalizeModel, normalizeRoute, normalizeRoutes, mergeProviders, isCredentialRef } from "./config.js";

export const name = "dsh-plugin-image-model";

export const Config = z.object({
  providers: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        baseURL: z.string(),
        apiKeyRef: z.string(),
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

export function apply(ctx, config) {
  const seed = Array.isArray(config?.providers) ? config.providers : [];
  // The llm registry is the only hard dependency. Attachments and credentials
  // are resolved lazily per call: they are mounted by the host, and a call that
  // arrives without them must fail with a clear reason rather than prevent the
  // provider from being offered at all.
  ctx.inject(["llm"], (llmCtx) => {
    const credentials = () => llmCtx.get("credentials");
    const adapter = new ImageModelAdapter({
      routes: [],
      attachments: () => llmCtx.get("attachments"),
      credentials,
    });

    // The registration is created on first use rather than at boot:
    // `registerAdapter` rejects an empty initial route set, and a fresh install
    // has no providers until the settings panel adds one. Once it exists,
    // `replace` swaps the whole set atomically, so no request sees a gap - and an
    // empty set is legal there, so removing every provider is also fine.
    let handle;
    const applyRoutes = (routes) => {
      adapter.setRoutes(routes);
      const ids = routes.map((route) => route.id);
      if (handle === undefined) {
        if (ids.length === 0) return;
        handle = llmCtx.llm.registerAdapter(ids, adapter);
        return;
      }
      handle.replace(ids);
    };

    const bridge = createSettingsBridge({
      seed,
      path: configPath(),
      credentials,
      onChange: applyRoutes,
      logger: llmCtx.logger,
    });

    llmCtx.effect(() => {
      applyRoutes(bridge.effective());
      return () => {
        handle?.();
        handle = undefined;
      };
    }, `${name}: image adapters`);

    // The settings panel needs these routes. A deployment without a web server
    // still runs on whatever the loader patch and the settings file declare.
    llmCtx.inject(["webServer"], (httpCtx) => {
      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: "exact", path: "/image-model/config", handler: bridge.handleConfig }),
        `${name}: config route`,
      );
      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: "exact", path: "/image-model/credential", handler: bridge.handleCredential }),
        `${name}: credential route`,
      );
    });
  });
}

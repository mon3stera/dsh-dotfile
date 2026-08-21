# Image generation as a selectable model

`dsh-plugin-image-model` makes an OpenAI-compatible images endpoint usable the
same way a chat model is: pick it in the model selector, send a prompt, get a
picture back in the conversation. A follow-up message refines the picture instead
of starting over.

## Why this is an adapter and not a model entry

An image endpoint cannot be reached by adding a model id to an existing provider
in `settings.yaml`. The harness would post the request to that provider's chat
path, because a configured provider's `api` field selects one of pi-ai's
streaming chat protocols (`openai-completions`, `openai-responses`,
`anthropic-messages`) and none of them is `/v1/images/generations`.

Model metadata cannot express it either. `resolveModelInfo()` declares
`inputModalities` — what a model accepts — and has no output-modality field, so
there is nothing to mark a model as image-producing.

What *does* fit is the adapter seam. `ctx.llm.registerAdapter(providers, adapter)`
is public, and `image` is already one of the declared content-block types, which
the client renders inside an assistant message. So an adapter that yields a
single image block and finishes needs no new host concept:

```text
prompt -> /v1/images/{generations,edits} -> attachments.saveImage() -> image block
```

## Generate-only is a consequence, not a rule

The adapter emits no tool call, and the agent loop ends a turn when a step
produces none. One prompt therefore yields exactly one image and the turn ends —
the route cannot hold a conversation because there is no mechanism by which it
could continue, not because a check forbids it.

## Configuration

```yaml
- id: dsh-plugin-image-model
  name: dsh-plugin-image-model
  config:
    providers:
      - id: torchai-image          # appears as a provider in the model selector
        name: TorchAI Image
        baseURL: https://torchai.ai/v1
        apiKeyEnv: OPENAI_API_KEY
        edits: true                # refine the newest image in the session
        models:
          - id: gpt-image-1
            name: GPT Image 1
            size: '1024x1024'      # sent verbatim as `size`
```

Per-model options are sent only when declared: `size`, `quality`, `background`,
`outputFormat` (`output_format`), and `responseFormat` (`response_format`,
generation only — several gateways reject it on the edits endpoint). Nothing is
defaulted on the deployment's behalf, because gateways disagree about which
parameters they accept and an unknown one is rejected outright.

A route is dropped rather than registered when it has no id, no `baseURL`, or no
usable model. Registering it would put a provider in the selector that fails on
first use. The credential is read per call, so a corrected environment variable
takes effect without a restart and a missing one fails the request with
`MISSING_CREDENTIAL` instead of hiding the provider.

## What becomes the prompt

The prompt is the text of the **person's** most recent message — the newest
message whose `source.kind` is `user`.

Message *role* is not sufficient. The harness delivers producer-supplied context
as user-role messages too: workspace instructions and the skill catalog arrive
inside `<system-reminder>` framing, and the runtime-context snapshot arrives as
plain text. Selecting by role alone sends the repository guide, or the sandbox
policy, to the endpoint as the subject of the picture. Both were observed in a
live run before the source filter existed; `<system-reminder>` blocks are also
stripped as a second line of defence, for a producer that inlines one into a
genuine user message.

History is never concatenated. An images endpoint has no notion of a
conversation, and joining turns would blend an unrelated earlier request into the
prompt. Continuity is expressed by editing the previous image instead.

## Refinement

With `edits: true` the adapter looks backwards for the newest image and, if it
finds one, posts to `/v1/images/edits` with those bytes as the source:

1. an image attached to the current message — an explicit target;
2. the image the previous turn generated — plain refinement ("make it bluer").

Scanning from the end yields that order without special-casing either. Images
inside plugin-injected context are skipped, since republished context is not part
of the visual conversation. A session with no prior image generates from scratch.

The source bytes are read back through `attachments.readImage()`, so refinement
uses the stored original rather than anything re-encoded for display.

## Auxiliary callers must not be answered with a picture

Other components reuse the session's route for their own text work.
`dsh-session-title-llm` asks for a title on **every new session** with
`purpose: 'session-title'`, and compaction uses `purpose: 'compaction'`.

The adapter refuses anything other than the agent's own turn (`purpose` absent or
`assistant`) with a non-retryable `INVALID_REQUEST`, before the credential check,
so the refusal costs nothing. Without this, selecting an image route silently
generated a billed image per session title. Its callers already tolerate a failed
call — a session keeps its fallback title. An unrecognized future purpose is
refused for the same reason: spending money on a call whose intent is unknown is
worse than failing it.

## Storage and admission limits

Generated bytes go through `attachments.saveImage()` before the block is yielded,
the same lifecycle a user upload or `read_image` result gets, so an `ImageBlock`
always carries a durable content-addressed reference and never inline bytes.

The media type is identified from the bytes' own signature (PNG, JPEG, WebP,
GIF), not from the request parameters. `saveImage()` verifies the declared type
against the decoded raster and rejects a mismatch with `IMAGE_TYPE_MISMATCH`, so
guessing would turn a provider quirk into a failed save.

The local store enforces real bounds — by default **2000 px per side**, **3.5 MiB
encoded**, and 40 M decoded pixels. Those are reachable: a detailed PNG at
1536x1536 can exceed 3.5 MiB, and a 2048 px output is refused outright. A
generated image is the one image the user did not choose the shape of, so an
admission refusal is rewritten to name the limit, the actual value, and the
option that fixes it (a smaller `size`, or `outputFormat: jpeg`).

## Failure classification

Provider and transport failures are mapped onto the harness codes the retry layer
routes on, never surfaced as raw text: `429` to `RATE_LIMIT`, `5xx` to `SERVER`,
`401`/`403` to `AUTH`, a network error to `TRANSPORT`, an empty `data` array to
`EMPTY_RESPONSE`. An error body is reduced to one bounded line, and an HTML error
page is reported as such rather than forwarded, because response text can reach
durable surfaces.

`revised_prompt` is surfaced as a text block beside the image: it is the provider
stating what it actually drew. Usage is reported only when the provider reports
it — synthesizing token counts would put invented numbers in the context meter.

## Verification

`tests/dsh-image-model-smoke.mjs` covers configuration normalization, prompt and
source-image selection, option shaping, media sniffing, failure classification,
both endpoint encodings, admission-refusal messages, and the full `stream()`
contract. It also cross-checks the installed host: that `image` is still a
declared block type, that there is still no output-modality field, that
`registerAdapter` is still the seam, and that the client still maps an image
block to an assistant image node. A host upgrade that breaks any of those fails
the test instead of silently producing invisible images.

The end-to-end path was verified with a local fake images endpoint and a real
agent run against an isolated `DSH_HOME`, which is how the prompt-pollution and
session-title problems were found. The durable assistant message carried the
expected block:

```json
{"type": "image",
 "attachment": {"attachmentId": "sha256:27171c44...", "mediaType": "image/png",
                "width": 256, "height": 256, "bytes": 4587,
                "name": "a-blue-cat-sitting-on-a-fence.png"}}
```

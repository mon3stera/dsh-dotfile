/**
 * Turn a harness conversation request into one images-API request.
 *
 * The agent loop hands every adapter the same thing: a system prompt, tool
 * schemas, and the full derived history. An image endpoint accepts none of
 * that, so this module reduces the request to a prompt and, for refinement, one
 * source image. The system prompt and tool schemas are deliberately discarded - 
 * a model that cannot call a tool must not be told tools exist.
 *
 * @module dsh-plugin-image-model/request
 */

/** Roles whose text can carry the prompt. */
const PROMPT_ROLE = "user";

/**
 * Harness-injected reminder framing, which arrives inside user messages.
 *
 * `dsh-agent-instructions` wraps workspace instructions and the skill catalog in
 * `<system-reminder>` blocks and appends them to the user turn, and it escapes
 * any nested close tag in the body, so a non-greedy match cannot end early.
 */
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/**
 * Purposes this adapter will spend a generation on.
 *
 * The agent's own request is `assistant`. Auxiliary consumers reuse the
 * session's route for their own text work -  `session-title` asks for a title on
 * every new session -  and answering those with a picture would be both wrong and
 * billable, so anything else is refused instead of generated.
 */
const GENERATING_PURPOSES = new Set([undefined, "assistant"]);

/**
 * Whether a request should produce an image at all.
 * @param purpose - the declared call purpose, if any.
 * @returns true when the call is the agent's own conversational turn.
 */
export function shouldGenerate(purpose) {
  return GENERATING_PURPOSES.has(purpose);
}

/**
 * Remove harness-injected reminder blocks from prompt text.
 *
 * Those blocks are instructions aimed at a conversational model; forwarding them
 * would send the workspace guide to an image endpoint as the subject of the
 * picture, which is exactly what happens without this step.
 *
 * @param text - assembled message text.
 * @returns the text with reminder blocks removed.
 */
export function stripSystemReminders(text) {
  return text.replace(SYSTEM_REMINDER, "").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Collect the text of one message, ignoring non-text blocks.
 * @param message - one harness message.
 * @returns the concatenated text, trimmed and free of injected reminders.
 */
export function messageText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return stripSystemReminders(
    blocks
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n"),
  );
}

/**
 * Find the image blocks of one message in order.
 * @param message - one harness message.
 * @returns the image blocks carrying an attachment reference.
 */
function messageImages(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks.filter((block) => block?.type === "image" && block.attachment !== undefined);
}

/**
 * Whether a message is the human's own, rather than injected context.
 *
 * `MessageSource.kind` answers who produced a message: `user` is the person,
 * while `plugin` is producer-supplied context -  workspace instructions, the
 * skill catalog, the runtime-context snapshot -  which the harness delivers as
 * user-role messages too. Only the person's text is a prompt; a real end-to-end
 * run without this check sent the runtime-context snapshot to the endpoint as
 * the subject of the picture.
 *
 * @param message - one harness message.
 * @returns true when the message came from the person.
 */
export function isHumanMessage(message) {
  return message?.role === PROMPT_ROLE && message?.source?.kind === "user";
}

/**
 * Whether any message in the list declares a source.
 *
 * A caller that omits `source` entirely (a fixture, or a future producer) must
 * still get a prompt, so source filtering is only applied where sources exist.
 *
 * @param messages - the message list.
 * @returns true when at least one message declares a source.
 */
function hasSources(messages) {
  return messages.some((message) => message?.source?.kind !== undefined);
}

/**
 * Resolve the prompt: the text of the person's most recent message.
 *
 * Only that one message is used. Concatenating history would send a conversation
 * to an endpoint that has no notion of one, and would silently blend an
 * unrelated earlier request into the prompt. Refinement is expressed by editing
 * the previous image instead, which is what {@link findSourceImage} provides.
 *
 * @param messages - the derived history, oldest first.
 * @returns the prompt text, or an empty string when there is none.
 */
export function resolvePrompt(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const sourced = hasSources(list);
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const message = list[i];
    if (sourced ? !isHumanMessage(message) : message?.role !== PROMPT_ROLE) continue;
    const text = messageText(message);
    if (text !== "") return text;
    // A message carrying only an image is an edit target, not a prompt; keep
    // looking back so an attach-then-instruct pair still works.
  }
  return "";
}

/**
 * Choose the image to edit, or undefined to generate from scratch.
 *
 * Preference order, newest first:
 *  1. an image the user attached to the current message (an explicit target),
 *  2. the image the previous turn generated (plain refinement).
 *
 * Scanning stops at the first image found from the end, which yields exactly
 * that order without special-casing either one. Plugin-injected context is
 * skipped: an image inside republished context is not part of the visual
 * conversation. A session that has never produced an image generates from
 * scratch.
 *
 * @param messages - the derived history, oldest first.
 * @returns the attachment reference to edit, or undefined.
 */
export function findSourceImage(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.source?.kind === "plugin") continue;
    const images = messageImages(list[i]);
    if (images.length > 0) return images[images.length - 1].attachment;
  }
  return undefined;
}

/**
 * Build the provider option bag for one model, dropping unset fields.
 *
 * Only options the deployment declared are sent. An images endpoint rejects an
 * unknown parameter, and gateways differ on which they accept, so nothing is
 * defaulted on the deployment's behalf.
 *
 * @param model - the declared model entry.
 * @param editing - whether the request targets the edits endpoint.
 * @returns the option bag merged into the request body or form.
 */
export function modelOptions(model, editing) {
  const options = {};
  if (typeof model?.size === "string" && model.size !== "") options.size = model.size;
  if (typeof model?.quality === "string" && model.quality !== "") options.quality = model.quality;
  if (typeof model?.background === "string" && model.background !== "") options.background = model.background;
  if (typeof model?.outputFormat === "string" && model.outputFormat !== "") options.output_format = model.outputFormat;
  // `response_format` is generation-only on OpenAI and rejected by the edits
  // endpoint on several gateways, so it is never sent for an edit.
  if (!editing && typeof model?.responseFormat === "string" && model.responseFormat !== "") {
    options.response_format = model.responseFormat;
  }
  return options;
}

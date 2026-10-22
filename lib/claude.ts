import Anthropic from "@anthropic-ai/sdk";
import { logEvent } from "./logging.js";
import { recordHeartbeat } from "./runStatus.js";

/** The one place the model is named. */
/** The API serves this ID as is, with no dated snapshot behind it to pin
 * (docs/eval-results.md, 2026-10-22). Re-run `npm run eval` after changing
 * CLAUDE_MODEL_ID or when Anthropic announces a model update. */
export const CLAUDE_MODEL = process.env.CLAUDE_MODEL_ID || "claude-sonnet-5";

/** The cheaper model for the tiny yes/no and JSON-extraction calls. Sonnet
 * is not needed for them: `npm run eval` checks both jobs against known
 * answers (8/8, 2026-10-22). Set CLAUDE_CHEAP_MODEL_ID=${CLAUDE_MODEL} to
 * put them back on Sonnet. */
export const CLAUDE_CHEAP_MODEL = process.env.CLAUDE_CHEAP_MODEL_ID || "claude-haiku-5-5";

/** The stable system prompt as a cacheable block: repeat calls within the
 * cache window read it at a fraction of the price. */
function cachedSystem(text: string): Anthropic.TextBlockParam[] {
  // cache_control isn't in this installed SDK version's types, but the API accepts it.
  return [{ type: "text", text, cache_control: { type: "ephemeral" } } as Anthropic.TextBlockParam];
}

/** The exact model IDs the API answered with (a dated snapshot behind each
 * alias), so `npm run eval` can record what to pin. */
export const servedModels = new Set<string>();

let client: Anthropic | undefined;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

/** Confirmed live 2026-07-30 (real, reproducible failure — Brett Kelley,
 * Nicholas Thomson): claude-sonnet-5 does extended thinking by default,
 * and thinking tokens count against the same max_tokens budget as the
 * actual reply. With max_tokens this small, the model can burn the whole
 * budget "thinking" before writing any real text — non-deterministic, so
 * it worked most of the time and silently stuck real leads with an
 * ai-needs-human tag and no reply the rest of the time. None of these
 * short SMS-reply/structured-extraction/classification tasks need deep
 * reasoning, so thinking is disabled outright rather than just giving it
 * more room to work with.
 * `thinking` isn't in this installed SDK version's types (predates the
 * param) but the raw API accepts it — hence the cast. */
async function createMessage(params: Anthropic.MessageCreateParamsNonStreaming, purpose = "claude"): Promise<Anthropic.Message> {
  try {
    const message = await getClient().messages.create({ ...params, thinking: { type: "disabled" } } as Anthropic.MessageCreateParamsNonStreaming);
    servedModels.add(message.model);
    // Token counts per call, so the cost-per-conversation estimate can be checked against real logs.
    const usage = message.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
    logEvent({ event: "claude_usage", purpose, model: params.model, servedModel: message.model, inputTokens: usage?.input_tokens, outputTokens: usage?.output_tokens, cacheReadTokens: usage?.cache_read_input_tokens ?? 0, cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0 });
    await recordHeartbeat("claude", true, `last call: ${purpose}`);
    return message;
  } catch (err: unknown) {
    await recordHeartbeat("claude", false, String((err as { message?: string })?.message ?? err).slice(0, 200));
    throw err;
  }
}

/** `leadDetails` is lead-supplied data (e.g. the address from the public
 * signup form) — sent in the user turn, never the system prompt. */
export async function draftReply(systemPrompt: string, conversationText: string, leadDetails = ""): Promise<string> {
  const response = await createMessage({
    model: CLAUDE_MODEL,
    max_tokens: 300,
    system: cachedSystem(systemPrompt),
    messages: [
      {
        role: "user",
        content: `${leadDetails ? `Lead details on file: ${leadDetails}\n\n` : ""}Conversation so far:\n${conversationText}\n\nWrite the next reply as the rep, replying to the lead's most recent message.`,
      },
    ],
  }, "draft_reply");

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude returned no text content");
  }
  return textBlock.text.trim();
}

/** Drip follow-up nudge — a different situation from draftReply (no new
 * inbound message to respond to; the lead has gone quiet). Unlike the cold
 * open (a fixed, deterministic template — see buildRollOffColdOpen in
 * lib/rollOffPrompt.ts), there's often real prior history to reference here. */
/** `firstName` must already have passed lib/outboundSafety.ts's
 * safeFirstName — it's sent in the user turn as data, never the system
 * prompt. */
export async function draftFollowUp(systemPrompt: string, conversationText: string, firstName?: string): Promise<string> {
  const response = await createMessage({
    model: CLAUDE_MODEL,
    max_tokens: 300,
    system: cachedSystem(systemPrompt),
    messages: [
      {
        role: "user",
        content: `Lead details: ${JSON.stringify({ first_name: firstName ?? null })}\n\nConversation so far (they have not replied to your last message):\n${conversationText || "(nothing yet — your only message was the opening cold open)"}\n\nWrite the follow-up message now, following the system prompt's instructions.`,
      },
    ],
  }, "draft_follow_up");

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude returned no text content");
  }
  return textBlock.text.trim();
}

/** Classifies whether a just-drafted reply hands the conversation off to a
 * human — see buildHandoffCheckPrompt in lib/prompt.ts. Fails closed to
 * false (not a handoff) on any parse failure: the same reply still goes
 * out either way, this only decides whether to also lock the AI out of the
 * thread afterward, so a false negative here just means the existing
 * keyword-based escalate path (lib/safety.ts) is the only backstop for
 * that one turn rather than a guaranteed miss. */
export async function detectHandoff(systemPrompt: string, draft: string): Promise<boolean> {
  const response = await createMessage({
    model: CLAUDE_CHEAP_MODEL,
    max_tokens: 50,
    system: cachedSystem(systemPrompt),
    messages: [{ role: "user", content: `Message: ${JSON.stringify(draft)}\n\nOutput the JSON object now, and nothing else.` }],
  }, "handoff_check");

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") return false;

  try {
    const parsed = JSON.parse(textBlock.text.trim());
    return parsed.handoffToHuman === true;
  } catch {
    return false;
  }
}


/** One structured-extraction call: the system prompt asks for a single
 * JSON object, the user turn carries the data. Returns null if the reply
 * isn't a JSON object, so callers fail closed. */
export async function extractJson(systemPrompt: string, userContent: string): Promise<Record<string, unknown> | null> {
  const response = await createMessage({
    model: CLAUDE_CHEAP_MODEL,
    max_tokens: 150,
    system: cachedSystem(systemPrompt),
    messages: [{ role: "user", content: userContent }],
  }, "extract_json");
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") return null;
  try {
    const parsed = JSON.parse(textBlock.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

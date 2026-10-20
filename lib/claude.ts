import Anthropic from "@anthropic-ai/sdk";
import { logEvent } from "./logging.js";
import { recordHeartbeat } from "./runStatus.js";

/** The one place the model is named. */
/** An undated alias: a model update under it can change behaviour. Set
 * CLAUDE_MODEL_ID to pin a dated snapshot (and re-run `npm run eval`). */
export const CLAUDE_MODEL = process.env.CLAUDE_MODEL_ID || "claude-sonnet-5";

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
    const message = await getClient().messages.create({ ...params, thinking: { type: "disabled" } } as any);
    // Token counts per call, so the cost-per-conversation estimate can be checked against real logs.
    logEvent({ event: "claude_usage", purpose, model: params.model, inputTokens: message.usage?.input_tokens, outputTokens: message.usage?.output_tokens });
    await recordHeartbeat("claude", true, `last call: ${purpose}`);
    return message;
  } catch (err: any) {
    await recordHeartbeat("claude", false, String(err?.message ?? err).slice(0, 200));
    throw err;
  }
}

/** `leadDetails` is lead-supplied data (e.g. the address from the public
 * signup form) — sent in the user turn, never the system prompt. */
export async function draftReply(systemPrompt: string, conversationText: string, leadDetails = ""): Promise<string> {
  const response = await createMessage({
    model: CLAUDE_MODEL,
    max_tokens: 300,
    system: systemPrompt,
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
    system: systemPrompt,
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
    model: CLAUDE_MODEL,
    max_tokens: 50,
    system: systemPrompt,
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
    model: CLAUDE_MODEL,
    max_tokens: 150,
    system: systemPrompt,
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

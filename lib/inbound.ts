import { getContact, addTag, addNote } from "./ghl.js";
import { logEvent } from "./logging.js";
import { NEEDS_HUMAN_TAG, hasRollOffTag, hasResidentialTag } from "./rollOff.js";
import { handleRollOffReply } from "./rollOffReply.js";
import { recordFunnelEvent } from "./funnelStore.js";
import { recordHeartbeat } from "./runStatus.js";
import type { InboundMessage } from "./types.js";
import { errorMessage } from "./errors.js";

export type InboundResult = { ok: true; [key: string]: unknown } | { ok: false };

/**
 * Answers one text from a contact. Shared by the reply webhook
 * (api/webhook.ts) and the scheduled job, which answers texts parked while
 * the bot was paused (lib/parkedReplies.ts). Only contacts tagged
 * ROLLOFF_ELIGIBLE_TAG are this bot's to answer; anyone else is ignored
 * with no side effects at all, since they belong to the residential bot
 * (Kaizen) or to a person. So is anyone also tagged for the residential
 * bot, which answers them itself. Never throws: a failure is logged, the
 * contact goes to a person, and { ok: false } comes back.
 */
export async function answerInbound(inbound: InboundMessage): Promise<InboundResult> {
  try {
    const contact = await getContact(inbound.contactId);
    if (!hasRollOffTag(contact.tags)) {
      logEvent({ event: "skip_not_rolloff", contactId: inbound.contactId });
      return { ok: true, action: "skipped_not_rolloff" };
    }
    // The residential bot answers this person too (lib/rollOff.ts); one
    // reply is enough, so this bot stays out.
    if (hasResidentialTag(contact.tags)) {
      logEvent({ event: "skip_residential_lead", contactId: inbound.contactId });
      return { ok: true, action: "skipped_residential_lead" };
    }
    // For the dashboard: their first text in counts as responded. Never
    // throws, so it can't hold up or break the reply.
    const [result] = await Promise.all([handleRollOffReply(inbound, contact), recordFunnelEvent("responded", inbound.contactId)]);
    await recordHeartbeat("replies", true, `last text answered ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`);
    return { ok: true, flow: "rolloff", ...result };
  } catch (err: unknown) {
    logEvent({ event: "error", contactId: inbound.contactId, error: errorMessage(err) });
    await recordHeartbeat("replies", false, "the last reply hit an error, so that lead was handed to the office");
    // Best-effort: if the failure was inside a GHL call, this may fail too,
    // but it's worth trying so a person sees the contact stalled.
    // Not in test mode, which writes nothing to GHL.
    if (process.env.DRY_RUN !== "true") {
      try {
        await addTag(inbound.contactId, NEEDS_HUMAN_TAG);
        await addNote(inbound.contactId, `AI hit an error and could not reply: ${errorMessage(err)}`);
      } catch {
        // swallow: the original error is already logged
      }
    }
    return { ok: false };
  }
}

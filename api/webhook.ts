import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getContact, addTag, addNote } from "../lib/ghl.js";
import { logEvent } from "../lib/logging.js";
import { isServiceActive } from "../lib/killswitch.js";
import { hasRollOffTag } from "../lib/rollOff.js";
import { handleRollOffReply } from "../lib/rollOffReply.js";
import type { InboundMessage } from "../lib/types.js";

/** Same payload shapes the Kaizen lead-responder webhook accepts, so one
 * GHL "Customer Replied" workflow action can point at either service. */
function parsePayload(raw: any): InboundMessage {
  const customData = raw.customData ?? {};
  return {
    contactId: customData.contact_id ?? raw.contact_id ?? raw.contactId,
    conversationId: customData.conversation_id ?? raw.conversation_id ?? raw.conversationId,
    locationId: customData.location_id ?? raw.location_id ?? raw.locationId ?? raw.location?.id,
    phone: customData.phone ?? raw.phone,
    body: customData.message ?? raw.message ?? raw.body ?? "",
  };
}

/**
 * GHL calls this when a contact texts in. Only contacts tagged
 * ROLLOFF_ELIGIBLE_TAG are this bot's to answer; anyone else is ignored
 * with no side effects at all, since they belong to the residential bot
 * (Kaizen) or to a person.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).end();
    return;
  }

  if (req.query.secret !== process.env.WEBHOOK_SHARED_SECRET) {
    res.status(401).json({ error: "bad secret" });
    return;
  }

  if (!(await isServiceActive())) {
    logEvent({ event: "service_paused" });
    res.status(200).json({ ok: true, action: "paused" });
    return;
  }

  const inbound = parsePayload(req.body);
  if (!inbound.contactId || !inbound.body) {
    res.status(400).json({ error: "missing contactId or message body", receivedKeys: Object.keys(req.body ?? {}) });
    return;
  }

  try {
    const contact = await getContact(inbound.contactId);
    if (!hasRollOffTag(contact.tags)) {
      logEvent({ event: "skip_not_rolloff", contactId: inbound.contactId });
      res.status(200).json({ ok: true, action: "skipped_not_rolloff" });
      return;
    }
    const result = await handleRollOffReply(inbound, contact);
    res.status(200).json({ ok: true, flow: "rolloff", ...result });
  } catch (err: any) {
    logEvent({ event: "error", contactId: inbound.contactId, error: err.message });
    // Best-effort: if the failure was inside a GHL call, this may fail too,
    // but it's worth trying so a person sees the contact stalled.
    try {
      await addTag(inbound.contactId, "ai-needs-human");
      await addNote(inbound.contactId, `AI hit an error and could not reply: ${err.message}`);
    } catch {
      // swallow: the original error is already logged and returned
    }
    res.status(500).json({ error: err.message });
  }
}

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { logEvent } from "../lib/logging.js";
import { isServiceActive } from "../lib/killswitch.js";
import { answerInbound } from "../lib/inbound.js";
import { parkReply } from "../lib/parkedReplies.js";
import type { InboundMessage } from "../lib/types.js";

/** Same payload shapes the Kaizen lead-responder webhook accepts, so one
 * GHL "Customer Replied" workflow action can point at either service. */
type RawPayload = Record<string, any>; // GHL's webhook body shape varies by workflow action
function parsePayload(raw: RawPayload): InboundMessage {
  const customData: RawPayload = raw.customData ?? {};
  return {
    contactId: customData.contact_id ?? raw.contact_id ?? raw.contactId,
    conversationId: customData.conversation_id ?? raw.conversation_id ?? raw.conversationId,
    locationId: customData.location_id ?? raw.location_id ?? raw.locationId ?? raw.location?.id,
    phone: customData.phone ?? raw.phone,
    body: customData.message ?? raw.message ?? raw.body ?? "",
  };
}

/**
 * GHL calls this when a contact texts in (its "Customer Replied" workflow).
 * The answering itself is lib/inbound.ts. While the kill switch has the bot
 * paused, the text is parked instead (lib/parkedReplies.ts) and answered or
 * handed to the office once the bot runs again.
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

  const inbound = parsePayload(req.body ?? {});
  if (!inbound.contactId || !inbound.body) {
    logEvent({ event: "webhook_bad_payload", receivedKeys: Object.keys(req.body ?? {}) });
    res.status(400).json({ error: "missing contactId or message body" });
    return;
  }

  if (!(await isServiceActive())) {
    const parked = await parkReply(inbound);
    logEvent({ event: "service_paused", contactId: inbound.contactId, parked });
    res.status(200).json({ ok: true, action: "paused", parked });
    return;
  }

  const result = await answerInbound(inbound);
  if (!result.ok) {
    // Details stay in the log; the caller gets nothing internal.
    res.status(500).json({ error: "internal error" });
    return;
  }
  res.status(200).json(result);
}

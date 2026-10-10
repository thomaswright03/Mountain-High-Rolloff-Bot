import type { ConversationTurn } from "./types.js";
import { assertSafeOutboundSms } from "./outboundSafety.js";

// Overridable via GHL_API_BASE_URL so tests can point this at a local mock
// server instead of the real GHL API. Unset in production -> same real URL.
const BASE_URL = process.env.GHL_API_BASE_URL ?? "https://services.leadconnectorhq.com";
const API_VERSION = "2021-07-28";

function headers(): Record<string, string> {
  const token = process.env.GHL_API_TOKEN;
  if (!token) throw new Error("GHL_API_TOKEN is not set");
  return {
    Authorization: `Bearer ${token}`,
    Version: API_VERSION,
    "Content-Type": "application/json",
  };
}

export async function getContact(contactId: string): Promise<Record<string, any>> {
  const res = await fetch(`${BASE_URL}/contacts/${contactId}`, { headers: headers() });
  if (!res.ok) throw new Error(`getContact failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as any;
  return data.contact;
}

/** Reads the brand/company value off the contact's custom field.
 * Confirmed via a real contact's API response (2026-07-25): GHL's
 * customFields entries only have {id, value} — no "key" property at all,
 * despite the Custom Fields settings page showing a "Key" column (that's a
 * separate merge-tag identifier, e.g. "company", used for templating, not
 * what shows up here). So GHL_COMPANY_FIELD_KEY must be set to the actual
 * field ID (e.g. "Jm9OoZ1JVeR2Xbs7LRAV" for Mountain High's "Company"
 * field), not the human-readable merge-tag name. */
export function extractCompanyValue(contact: Record<string, any>, fieldKey: string): string | undefined {
  const customField = (contact.customFields ?? []).find(
    (f: any) => f.key === fieldKey || f.id === fieldKey
  );
  return customField?.value ?? contact[fieldKey];
}

/** GHL's workflow-webhook merge-field picker has no "Conversation ID" field
 * (confirmed by hand in the builder UI) — so we look it up ourselves via the
 * contact instead of expecting the workflow to hand us one. */
export async function findConversationId(contactId: string, locationId: string): Promise<string | undefined> {
  const params = new URLSearchParams({ locationId, contactId });
  const res = await fetch(`${BASE_URL}/conversations/search?${params}`, { headers: headers() });
  if (!res.ok) throw new Error(`findConversationId failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as any;
  return data.conversations?.[0]?.id;
}

/** Confirmed live 2026-07-29: PUT /conversations/{id} accepts {starred:
 * true} and reflects it back — surfaces a conversation at the top of GHL's
 * inbox (starred filter) so a human notices it without needing to watch
 * tags. Used for both a confirmed signup and a human handoff — the two
 * moments a rep actually needs to look at a thread right now. */
export async function starConversation(conversationId: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/conversations/${conversationId}`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({ starred: true }),
  });
  if (!res.ok) throw new Error(`starConversation failed: ${res.status} ${await res.text()}`);
}

/** Same PUT /conversations/{id} endpoint as starConversation, this time with
 * unreadCount. Used on opt-outs (see api/webhook.ts) so a rep scanning the
 * inbox doesn't see a "STOP" sitting unread waiting for a reply that's
 * never coming — nothing left for anyone to act on there. Not yet confirmed
 * live against the real GHL API (unlike starConversation) — verify against
 * the next real opt-out. */
export async function markConversationRead(conversationId: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/conversations/${conversationId}`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({ unreadCount: 0 }),
  });
  if (!res.ok) throw new Error(`markConversationRead failed: ${res.status} ${await res.text()}`);
}

export async function getConversationHistory(conversationId: string): Promise<ConversationTurn[]> {
  const res = await fetch(`${BASE_URL}/conversations/${conversationId}/messages`, {
    headers: headers(),
  });
  if (!res.ok) throw new Error(`getConversationHistory failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as any;
  const messages = data.messages?.messages ?? data.messages ?? [];
  return messages
    .map((m: any) => ({
      direction: m.direction === "inbound" ? "inbound" : "outbound",
      body: m.body ?? "",
      dateAdded: m.dateAdded,
      // Confirmed live 2026-07-31 (Stacey Zarate's real thread, Max Garrett
      // manually replying): a rep texting from the GHL app carries a real
      // `userId`; our own sendSms() calls (bare API token) never do, even
      // though both show `source: "api"` — source alone can't tell them
      // apart, userId can.
      sentByHuman: m.direction !== "inbound" && Boolean(m.userId),
      status: m.status,
    }))
    .reverse(); // GHL returns newest-first; we want chronological order
}

/** Every outbound text in this codebase goes through here, so this is where
 * the link allow-list is enforced — see lib/outboundSafety.ts. */
export async function sendSms(contactId: string, message: string): Promise<void> {
  assertSafeOutboundSms(message);
  const res = await fetch(`${BASE_URL}/conversations/messages`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      type: "SMS",
      contactId,
      message,
    }),
  });
  if (!res.ok) throw new Error(`sendSms failed: ${res.status} ${await res.text()}`);
}

/** Used by mts-sync/submitContracts.ts to find contacts api/webhook.ts has
 * marked ready for real MTS contract submission. Confirmed live 2026-07-28
 * against the real GHL API: POST /contacts/search with a "tags contains"
 * filter works as expected. */
/** Paginates through every match via GHL's searchAfter cursor — a single
 * pageLimit:100 call silently truncated results once the tagged-contact
 * count grew past 100 (confirmed live 2026-07-29: 297 ai-outreach-eligible
 * contacts, only the first 100 ever got checked for unanswered replies). */
export async function findContactsByTag(tag: string, locationId: string): Promise<Record<string, any>[]> {
  const all: Record<string, any>[] = [];
  let searchAfter: any[] | undefined;

  while (true) {
    const res = await fetch(`${BASE_URL}/contacts/search`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        locationId,
        filters: [{ field: "tags", operator: "contains", value: tag }],
        pageLimit: 100,
        ...(searchAfter ? { searchAfter } : {}),
      }),
    });
    if (!res.ok) throw new Error(`findContactsByTag failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as any;
    const contacts = data.contacts ?? [];
    all.push(...contacts);

    if (contacts.length < 100) break;
    searchAfter = contacts[contacts.length - 1]?.searchAfter;
    if (!searchAfter) break;
  }

  return all;
}

/** Creates the contact, or updates the one GHL already has for this
 * phone/email. Never sends tags: GHL's upsert replaces a contact's tags
 * rather than adding to them (confirmed live 2026-07-29 in the Kaizen
 * repo), which would wipe opt-out and needs-human tags. Add tags with
 * addTag afterwards. Returns the contact id. */
export async function upsertContact(fields: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${BASE_URL}/contacts/upsert`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(fields),
  });
  if (!res.ok) throw new Error(`upsertContact failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as any;
  const id = data?.contact?.id ?? data?.id;
  if (!id) throw new Error("upsertContact: no contact id in GHL's response");
  return id;
}

export async function addTag(contactId: string, tag: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/contacts/${contactId}/tags`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ tags: [tag] }),
  });
  if (!res.ok) throw new Error(`addTag failed: ${res.status} ${await res.text()}`);
}

export async function removeTag(contactId: string, tag: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/contacts/${contactId}/tags`, {
    method: "DELETE",
    headers: headers(),
    body: JSON.stringify({ tags: [tag] }),
  });
  if (!res.ok) throw new Error(`removeTag failed: ${res.status} ${await res.text()}`);
}

/** QA trail for anything that isn't itself a sent SMS (escalations, opt-outs,
 * holds, errors) — sent messages are already durably visible as the actual
 * outbound text in GHL's own conversation view, so we don't duplicate those
 * here. Writing to a GHL contact note instead of a new database means the
 * CEO's team sees this exactly where they'd already be looking at the
 * contact, with no new infrastructure/account for the handoff to carry. */
export async function addNote(contactId: string, body: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/contacts/${contactId}/notes`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(`addNote failed: ${res.status} ${await res.text()}`);
}

/** Used by mts-sync/sendRollOffTexts.ts to find the cold-open record note
 * (AI_ROLLOFF_COLD_OPEN_NOTE_MARKER in lib/prompt.ts). Confirmed live 2026-07-28: note objects have a `body` field and `dateAdded`. */
export async function getNotes(contactId: string): Promise<Array<{ body: string; dateAdded: string }>> {
  const res = await fetch(`${BASE_URL}/contacts/${contactId}/notes`, { headers: headers() });
  if (!res.ok) throw new Error(`getNotes failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as any;
  return data.notes ?? [];
}

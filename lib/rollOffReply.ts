import type { CompanyConfig, InboundMessage } from "./types.js";
import { findCompany } from "./companies.js";
import { evaluateInbound } from "./safety.js";
import { buildHandoffCheckPrompt, formatHistory } from "./prompt.js";
import { buildRollOffReplyPrompt, type ReplyMode } from "./rollOffPrompt.js";
import { isOutsideServiceStates, rejectTemplateMarkers } from "./rollOff.js";
import {
  AI_ROLLOFF_BOOKING_NOTE_MARKER,
  EMPTY_BOOKING,
  ROLLOFF_CONFIRMED_TAG,
  buildBookingExtractionPrompt,
  buildBookingPayload,
  buildBookingEmail,
  buildBookingSummary,
  buildOfficeNote,
  buildSignedReply,
  contactOnFile,
  isSignature,
  latestSummary,
  looksLikeAName,
  missingAnswers,
  parseBookingState,
  parseBookingSummary,
  type ContactOnFile,
  type RollOffBookingPayload,
} from "./rollOffBooking.js";
import { draftReply, detectHandoff, extractJson } from "./claude.js";
import { safeFirstName } from "./outboundSafety.js";
import { isExcludedCity } from "./serviceArea.js";
import { extractCompanyValue, findConversationId, getConversationHistory, sendSms, sendEmail, findContactIdByEmail, upsertContact, addTag, addNote, starConversation, markConversationRead } from "./ghl.js";
import { logEvent } from "./logging.js";
import { recordFunnelEvent } from "./funnelStore.js";
import { claimReply, replyLockKey } from "./replyLock.js";

const NEEDS_HUMAN_TAG = "ai-needs-human";

export interface RollOffReplyResult {
  action: string;
  reason?: string;
  draft?: string;
  isHandoff?: boolean;
  /** They signed their booking with this text. */
  signed?: boolean;
}

/** Best-effort, same as Kaizen's residential webhook — a starring failure must
 * never block the escalation around it. */
async function tryStarConversation(conversationId: string | undefined, contactId: string): Promise<void> {
  if (!conversationId) return;
  try {
    await starConversation(conversationId);
  } catch (err: any) {
    logEvent({ event: "rolloff_star_conversation_failed", contactId, error: err.message });
  }
}

/** Test mode (DRY_RUN=true) writes nothing to GHL, tags and notes included:
 * it logs what it would have written instead. */
const isDryRun = () => process.env.DRY_RUN === "true";

/** Tag and/or note the contact, unless in test mode. */
async function writeToContact(contactId: string, tag: string | null, note: string): Promise<void> {
  if (isDryRun()) {
    logEvent({ event: "rolloff_dry_run_would_write", contactId, tag, note });
    return;
  }
  if (tag) await addTag(contactId, tag);
  await addNote(contactId, note);
}

async function handToOffice(contactId: string, conversationId: string | undefined, note: string): Promise<void> {
  await writeToContact(contactId, NEEDS_HUMAN_TAG, note);
  if (isDryRun()) return;
  await tryStarConversation(conversationId, contactId);
}

/**
 * Reply path for a contact in the roll-off dumpster flow (tagged
 * ROLLOFF_ELIGIBLE_TAG — see lib/rollOff.ts), called from api/webhook.ts
 * after its secret and killswitch checks. Mirrors the Kaizen residential
 * reply's order of checks (DND, human lockout, opt-out/escalation keywords, a human
 * already in the thread, nothing new to answer), then books it in the
 * thread (lib/rollOffBooking.ts): asks what the contract needs, sends the
 * summary, and takes their full name as the signature. Or hands off so the
 * office calls them. Throws on anything unexpected, so
 * api/webhook.ts's catch-all tags the contact for a human.
 */
export async function handleRollOffReply(inbound: InboundMessage, contact: Record<string, any>): Promise<RollOffReplyResult> {
  const { contactId } = inbound;

  if (contact.dnd === true) {
    logEvent({ event: "rolloff_skip_dnd", contactId });
    return { action: "skipped_dnd" };
  }

  const tags: string[] = (contact.tags ?? []).map((t: string) => t.toLowerCase());
  // Same lockout as the residential flow: once a human owns the thread, the
  // AI never texts in it again. Cleared only by a human removing the tag.
  if (tags.includes(NEEDS_HUMAN_TAG)) {
    logEvent({ event: "rolloff_skip_needs_human_already_flagged", contactId });
    return { action: "skipped_needs_human" };
  }

  const conversationId = inbound.conversationId ?? (await findConversationId(contactId, inbound.locationId));

  const companyValue = extractCompanyValue(contact, process.env.GHL_COMPANY_FIELD_KEY ?? "company");
  const company = findCompany(companyValue);
  const rollOff = company?.rollOff;
  if (!company || !rollOff) {
    await handToOffice(contactId, conversationId, `AI escalated to human: roll-off lead, but no roll-off setup for company value "${companyValue}". Lead said: "${inbound.body}"`);
    logEvent({ event: "rolloff_no_company_match", contactId, companyValue });
    return { action: "escalated_unknown_company" };
  }

  const verdict = evaluateInbound(inbound.body);
  logEvent({ event: "rolloff_safety_verdict", contactId, company: company.displayName, verdict });

  if (verdict.action === "opt_out") {
    await writeToContact(contactId, "ai-opted-out", `AI marked opted-out (roll-off): ${verdict.reason}. Lead said: "${inbound.body}"`);
    if (conversationId && !isDryRun()) {
      try {
        await markConversationRead(conversationId);
      } catch (err: any) {
        logEvent({ event: "rolloff_mark_read_failed", contactId, error: err.message });
      }
    }
    return { action: "opted_out" };
  }

  if (verdict.action === "escalate") {
    await handToOffice(contactId, conversationId, `AI escalated roll-off lead to human: ${verdict.reason}. Lead said: "${inbound.body}"`);
    logEvent({ event: "rolloff_escalated", contactId, reason: verdict.reason });
    return { action: "escalated", reason: verdict.reason };
  }

  // Deterministic, before the model ever sees it: an excluded city (Thomas,
  // 2026-09-29: no new Loveland customers) or an on-file state the brand
  // doesn't serve goes straight to the office.
  if (isExcludedCity(contact.city, company.excludedCities) || isOutsideServiceStates(contact.state, company.serviceStates)) {
    await handToOffice(
      contactId,
      conversationId,
      `AI handed roll-off lead to the office without replying: their on-file address (${contact.city ?? "?"}, ${contact.state ?? "?"}) is outside where ${company.displayName} is taking new customers. Lead said: "${inbound.body}"`
    );
    logEvent({ event: "rolloff_out_of_area", contactId, city: contact.city, state: contact.state });
    return { action: "escalated_out_of_area" };
  }

  if (!conversationId) {
    await handToOffice(contactId, undefined, `AI escalated roll-off lead to human: no GHL conversation found. Lead said: "${inbound.body}"`);
    logEvent({ event: "rolloff_no_conversation_found", contactId });
    return { action: "escalated_no_conversation" };
  }

  const history = await getConversationHistory(conversationId);

  if (history.some((t) => t.sentByHuman)) {
    await writeToContact(contactId, NEEDS_HUMAN_TAG, "AI stopped (roll-off): a human already replied in this conversation.");
    logEvent({ event: "rolloff_skip_human_replied", contactId });
    return { action: "skipped_human_replied" };
  }

  // Duplicate/retried webhook firing — nothing new from them to answer.
  if (history[history.length - 1]?.direction === "outbound") {
    logEvent({ event: "rolloff_skip_no_new_inbound", contactId });
    return { action: "skipped_no_new_message" };
  }

  // Two deliveries of the same text can arrive together and both pass the
  // check above; only the one that claims this message replies.
  if (!isDryRun()) {
    const newest = history[history.length - 1];
    if (!(await claimReply(replyLockKey(contactId, newest!)))) {
      logEvent({ event: "rolloff_skip_duplicate_delivery", contactId });
      return { action: "skipped_duplicate_delivery" };
    }
  }

  const isFirstReply = !history.some((t) => t.direction === "outbound");
  const dryRun = isDryRun();
  const onFile = contactOnFile(contact);
  const latest = history[history.length - 1]!;
  const sentSummary = latestSummary(history);
  const alreadySigned = tags.includes(ROLLOFF_CONFIRMED_TAG);

  // Their full name, right after the exact summary we sent: that's the
  // signature. Decided by code alone, and what gets booked is read back out
  // of the summary they signed.
  if (!alreadySigned && sentSummary && onFile && isSignature(latest.body, onFile.firstName, onFile.lastName)) {
    return await recordSignature({ contactId, conversationId, inbound, company, onFile, sentSummary, signedText: latest.body, dryRun });
  }

  const state = alreadySigned
    ? { ...EMPTY_BOOKING }
    : parseBookingState(
        await extractJson(buildBookingExtractionPrompt(company), `Conversation:\n${formatHistory(history)}\n\nOutput the JSON object now, and nothing else.`),
        rollOff
      );
  const complete = state.wantsToBook && missingAnswers(state).length === 0;

  let summary: string | null = null;
  let mode: ReplyMode;
  if (alreadySigned) {
    mode = { kind: "signed_already" };
  } else if (complete && onFile) {
    const fresh = buildBookingSummary(company, onFile, state);
    // The same summary is already waiting on their signature: answer
    // their question instead of sending it again.
    if (sentSummary?.trimEnd().endsWith(fresh)) {
      mode = { kind: "gathering", state, summarySent: true, nameMismatch: looksLikeAName(latest.body) };
    } else {
      summary = fresh;
      mode = { kind: "summary_next" };
    }
  } else if (complete) {
    mode = { kind: "office_finishes" };
  } else {
    mode = { kind: "gathering", state, summarySent: Boolean(sentSummary), nameMismatch: Boolean(sentSummary && onFile && looksLikeAName(latest.body)) };
  }

  const hasFullAddress = Boolean(contact.address1 && contact.city && contact.state && contact.postalCode);
  const leadDetails = JSON.stringify({
    first_name: safeFirstName(contact.firstName) ?? null,
    service_address: hasFullAddress ? `${contact.address1}, ${contact.city}, ${contact.state} ${contact.postalCode}` : null,
    ...(mode.kind === "gathering" && mode.nameMismatch ? { name_on_booking: `${onFile!.firstName} ${onFile!.lastName}` } : {}),
  });

  const rawDraft = rejectTemplateMarkers(await draftReply(buildRollOffReplyPrompt(company, rollOff, isFirstReply, mode), formatHistory(history), leadDetails));
  const draft = summary ? `${rawDraft}\n\n${summary}` : rawDraft;
  // Same classifier as the residential reply: a reply whose whole point is
  // "the office will call you" (or that ends the conversation) means the
  // office owns it from here. A summary is the booking working, never a
  // hand-off.
  const isHandoff = mode.kind === "office_finishes" ? true : summary ? false : await detectHandoff(buildHandoffCheckPrompt(), draft);

  logEvent({ event: "rolloff_draft", contactId, draft, isFirstReply, mode: mode.kind, bookingState: state, isHandoff, dryRun: process.env.DRY_RUN });

  if (dryRun) {
    return { action: "dry_run", draft, isHandoff };
  }

  if (isHandoff && alreadySigned) {
    // They've signed and the office is already calling them, so no
    // ai-needs-human lockout: the office just needs to see what they asked
    // before that call.
    await addNote(contactId, `Roll-off lead who already signed texted again and the AI said the office will reach out. Lead said: "${inbound.body}" AI's text: "${draft}"`);
    await tryStarConversation(conversationId, contactId);
    logEvent({ event: "rolloff_signed_lead_needs_office", contactId });
  } else if (isHandoff) {
    await handToOffice(
      contactId,
      conversationId,
      mode.kind === "office_finishes"
        ? `AI handed this roll-off lead to the office: they gave every booking answer (${state.yards} yard, ${state.customerType}, placement "${state.placement}", call before delivery: ${state.callBeforeDelivery ? "yes" : "no"}), but their name, phone or address on file is incomplete so a contract can't be made by text. Please call them to finish booking. Lead said: "${inbound.body}"`
        : `AI handed this roll-off lead to the office. Read the thread: if they still want a dumpster, call them to finish booking (size, placement, card). AI's last text: "${draft}" Lead said: "${inbound.body}"`
    );
    logEvent({ event: "rolloff_handoff_flagged", contactId });
  }

  if (!(await trySend(contactId, draft))) return { action: "blocked_dnd" };
  if (summary) await recordFunnelEvent("summary-sent", contactId);
  logEvent({ event: "rolloff_sent", contactId, draft });
  return { action: "sent", isHandoff };
}

/** False if GHL refused because the contact is DND for SMS (noted, not an
 * error); anything else throws for api/webhook.ts to hand to a human. */
async function trySend(contactId: string, text: string): Promise<boolean> {
  try {
    await sendSms(contactId, text);
    return true;
  } catch (smsErr: any) {
    // Same as the residential reply: DND is an intentional suppression,
    // not an error for a human to chase.
    if (smsErr.message?.includes("DND is active for SMS")) {
      await addNote(contactId, `Roll-off reply drafted but not sent — contact is DND for SMS: "${text}"`);
      logEvent({ event: "rolloff_send_blocked_dnd", contactId, draft: text });
      return false;
    }
    throw smsErr;
  }
}

async function recordSignature(input: {
  contactId: string;
  conversationId: string;
  inbound: InboundMessage;
  company: CompanyConfig;
  onFile: ContactOnFile;
  sentSummary: string;
  signedText: string;
  dryRun: boolean;
}): Promise<RollOffReplyResult> {
  const { contactId, conversationId, company, onFile, dryRun } = input;
  const answers = parseBookingSummary(company, onFile, input.sentSummary);
  if (!answers) {
    // Their name or address on file changed since the summary went out (or
    // the summary isn't one we'd send now): don't book what they didn't see.
    if (!dryRun) {
      await handToOffice(
        contactId,
        conversationId,
        `AI did NOT book this roll-off: the lead signed with "${input.signedText}", but the summary they signed no longer matches their details on file. Please call them to confirm and book it. Summary they signed: "${input.sentSummary}"`
      );
    }
    logEvent({ event: "rolloff_signature_summary_mismatch", contactId, dryRun });
    return { action: "escalated_summary_mismatch" };
  }
  const payload = buildBookingPayload(onFile, answers, input.signedText, input.sentSummary, new Date());
  const reply = buildSignedReply(safeFirstName(onFile.firstName), answers.yards!);
  logEvent({ event: "rolloff_signed", contactId, draft: reply, payload, dryRun });
  if (dryRun) {
    const email = company.rollOff.bookingEmail ? buildBookingEmail(company, payload, ghlContactUrl(input.inbound.locationId, contactId)) : null;
    logEvent({ event: "rolloff_booking_email_dry_run", contactId, to: company.rollOff.bookingEmail, subject: email?.subject });
    return { action: "dry_run", draft: reply, signed: true };
  }

  // Tag and note before the text, so a failed send can't lose the booking.
  // MTS won't save a roll-off contract without a card (Thomas's test,
  // 2026-10-21), and a card never goes over text, so the office takes the
  // card on a call and enters the contract from this note. Starred so they
  // see it; no ai-needs-human, so the bot can still answer their texts.
  await addTag(contactId, ROLLOFF_CONFIRMED_TAG);
  await addNote(contactId, `${AI_ROLLOFF_BOOKING_NOTE_MARKER} ${JSON.stringify(payload)}`);
  await addNote(contactId, buildOfficeNote(payload));
  await tryStarConversation(conversationId, contactId);
  await emailBooking(company, payload, contactId, input.inbound.locationId);
  await recordFunnelEvent("signed", contactId);
  if (!(await trySend(contactId, reply))) return { action: "signed_dnd", signed: true };
  logEvent({ event: "rolloff_sent", contactId, draft: reply });
  return { action: "signed", draft: reply, signed: true };
}

function ghlContactUrl(locationId: string, contactId: string): string {
  return `https://app.gohighlevel.com/v2/location/${locationId}/contacts/detail/${contactId}`;
}

/** Emails the signed booking to the customer team (Thomas, 2026-10-22),
 * through GHL: their address is kept as its own GHL contact. Never throws:
 * the booking is already tagged, noted and starred, so a failed email only
 * adds a note saying so. */
async function emailBooking(company: CompanyConfig, payload: RollOffBookingPayload, contactId: string, locationId: string): Promise<void> {
  const to = company.rollOff.bookingEmail;
  if (!to) {
    logEvent({ event: "rolloff_booking_email_not_configured", contactId });
    return;
  }
  try {
    // An existing contact with that address (Thomas's own, for now) is used
    // as is: an upsert would rename it.
    const teamContactId =
      (await findContactIdByEmail(locationId, to)) ?? (await upsertContact({ locationId, email: to, firstName: company.displayName, lastName: "Customer Team" }));
    const { subject, html } = buildBookingEmail(company, payload, ghlContactUrl(locationId, contactId));
    await sendEmail(teamContactId, subject, html);
    logEvent({ event: "rolloff_booking_emailed", contactId, to });
  } catch (err: any) {
    logEvent({ event: "rolloff_booking_email_failed", contactId, error: err.message });
    try {
      await addNote(contactId, `AI couldn't email this roll-off booking to ${to} (${err.message}). Everything the office needs is in the note above.`);
    } catch {
      // The failure is logged; the booking note and star are already there.
    }
  }
}

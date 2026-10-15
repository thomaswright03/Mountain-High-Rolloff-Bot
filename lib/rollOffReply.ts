import type { InboundMessage } from "./types.js";
import { findCompany } from "./companies.js";
import { evaluateInbound } from "./safety.js";
import { buildHandoffCheckPrompt, formatHistory } from "./prompt.js";
import { buildRollOffReplyPrompt } from "./rollOffPrompt.js";
import { fillBookingLink, isOutsideServiceStates, ROLLOFF_CONTRACT_LINK_MARKER } from "./rollOff.js";
import { draftReply, detectHandoff } from "./claude.js";
import { safeFirstName } from "./outboundSafety.js";
import { prepareContractLink, safeEmail } from "./contractLink.js";
import { isExcludedCity } from "./serviceArea.js";
import { extractCompanyValue, findConversationId, getConversationHistory, sendSms, addTag, addNote, starConversation, markConversationRead } from "./ghl.js";
import { logEvent } from "./logging.js";

const NEEDS_HUMAN_TAG = "ai-needs-human";

export interface RollOffReplyResult {
  action: string;
  reason?: string;
  draft?: string;
  isHandoff?: boolean;
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

async function handToOffice(contactId: string, conversationId: string | undefined, note: string): Promise<void> {
  await addTag(contactId, NEEDS_HUMAN_TAG);
  await addNote(contactId, note);
  await tryStarConversation(conversationId, contactId);
}

/**
 * Reply path for a contact in the roll-off dumpster flow (tagged
 * ROLLOFF_ELIGIBLE_TAG — see lib/rollOff.ts), called from api/webhook.ts
 * after its secret and killswitch checks. Mirrors the Kaizen residential
 * reply's order of checks (DND, human lockout, opt-out/escalation keywords, a human
 * already in the thread, nothing new to answer), but there's no signup to
 * capture: the only outcomes are a reply that helps them finish online, or a
 * hand-off so the office calls them. Throws on anything unexpected, so
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
    await addTag(contactId, "ai-opted-out");
    await addNote(contactId, `AI marked opted-out (roll-off): ${verdict.reason}. Lead said: "${inbound.body}"`);
    if (conversationId) {
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
    await addTag(contactId, NEEDS_HUMAN_TAG);
    await addNote(contactId, "AI stopped (roll-off): a human already replied in this conversation.");
    logEvent({ event: "rolloff_skip_human_replied", contactId });
    return { action: "skipped_human_replied" };
  }

  // Duplicate/retried webhook firing — nothing new from them to answer.
  if (history[history.length - 1]?.direction === "outbound") {
    logEvent({ event: "rolloff_skip_no_new_inbound", contactId });
    return { action: "skipped_no_new_message" };
  }

  const isFirstReply = !history.some((t) => t.direction === "outbound");
  const hasFullAddress = Boolean(contact.address1 && contact.city && contact.state && contact.postalCode);
  const firstName = safeFirstName(contact.firstName);
  const lastName = safeFirstName(contact.lastName);
  const leadDetails = JSON.stringify({
    first_name: firstName ?? null,
    full_name_on_file: firstName && lastName ? `${firstName} ${lastName}` : null,
    email_on_file: safeEmail(contact.email) ?? null,
    service_address: hasFullAddress ? `${contact.address1}, ${contact.city}, ${contact.state} ${contact.postalCode}` : null,
  });

  const rawDraft = await draftReply(buildRollOffReplyPrompt(company, rollOff, isFirstReply), formatHistory(history), leadDetails);
  const dryRun = process.env.DRY_RUN === "true";

  let withContract = rawDraft;
  let contractId: string | undefined;
  if (rawDraft.includes(ROLLOFF_CONTRACT_LINK_MARKER)) {
    const result = await prepareContractLink({ company, contactId, contact, history, now: new Date(), dryRun });
    if ("unavailable" in result) {
      // The reply promised a contract we can't make, so it isn't sent. The
      // office books it with them instead.
      if (!dryRun) {
        await handToOffice(
          contactId,
          conversationId,
          `AI didn't reply: it was about to text this roll-off lead their contract, but ${result.unavailable}. Please call them to finish booking. Lead said: "${inbound.body}"`
        );
      }
      logEvent({ event: "rolloff_contract_unavailable", contactId, reason: result.unavailable, dryRun });
      return { action: "escalated_contract_unavailable", reason: result.unavailable };
    }
    withContract = rawDraft.split(ROLLOFF_CONTRACT_LINK_MARKER).join(result.link);
    // Thomas, 2026-10-15: the contract text must state the price. If the
    // draft left out this size's price, add the code-owned line.
    if (!withContract.includes(`$${result.price}`)) withContract = `${withContract} ${result.priceLine}`;
    contractId = result.contractId;
    logEvent({ event: "rolloff_contract_created", contactId, contractId, dryRun });
  }
  const draft = fillBookingLink(withContract, rollOff);
  // Same classifier as the residential reply: a reply whose whole point is
  // "the office will call you" (or that ends the conversation) means the
  // office owns it from here.
  // A contract text says the office will call after signing; that's the
  // contract path working, not a hand-off (signing hands it over itself).
  const sendsContract = withContract !== rawDraft;
  const isHandoff = sendsContract ? false : await detectHandoff(buildHandoffCheckPrompt(), draft);

  logEvent({ event: "rolloff_draft", contactId, draft, isFirstReply, isHandoff, dryRun: process.env.DRY_RUN });

  if (dryRun) {
    return { action: "dry_run", draft, isHandoff };
  }

  if (isHandoff) {
    await handToOffice(
      contactId,
      conversationId,
      `AI handed this roll-off lead to the office. Read the thread: if they still want a dumpster, call them to finish booking (size, dates, card). AI's last text: "${draft}" Lead said: "${inbound.body}"`
    );
    logEvent({ event: "rolloff_handoff_flagged", contactId });
  }

  try {
    await sendSms(contactId, draft);
  } catch (smsErr: any) {
    // Same as the residential reply: DND is an intentional suppression,
    // not an error for a human to chase.
    if (smsErr.message?.includes("DND is active for SMS")) {
      await addNote(contactId, `Roll-off reply drafted but not sent — contact is DND for SMS: "${draft}"`);
      logEvent({ event: "rolloff_send_blocked_dnd", contactId, draft });
      return { action: "blocked_dnd" };
    }
    throw smsErr;
  }
  if (contractId) {
    await addNote(contactId, `AI texted this roll-off lead a contract to sign (contract ${contractId}). Once they sign, they're tagged ai-rolloff-contract-signed for the office to take payment.`);
  }
  logEvent({ event: "rolloff_sent", contactId, draft });
  return { action: "sent", isHandoff };
}

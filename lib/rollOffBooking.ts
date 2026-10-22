import type { CompanyConfig, ConversationTurn, RollOffConfig, RollOffSize } from "./types.js";
import { TRANSCRIPT_FORMAT_NOTE } from "./prompt.js";
import { stateCode } from "./rollOff.js";

// Booking a roll-off in the text thread (Thomas, 2026-10-21: "we dont want
// it to send a link. we want it to book the client right there"). Same
// shape as the residential bot's signup (Kaizen lib/prompt.ts and
// lib/signupDecision.ts): the bot asks for whatever MTS's New Roll-Off
// Contract form still needs, sends one bullet summary, and the lead replies
// with their full name to sign. MTS won't save a roll-off contract without
// a card, and a card never goes over text, so the office then calls to take
// the card and enters the contract from the note written here
// (buildOfficeNote).
//
// What makes it safe:
// - The summary is built by code (buildBookingSummary), never the model, so
//   it always states the real price, terms and address.
// - What gets submitted is parsed back out of the summary the lead actually
//   signed (parseBookingSummary), not re-extracted from the conversation.
// - The signature check is deterministic: their reply must be the name on
//   file (isSignature), right after that exact summary.
// - No card is ever asked for or taken by text. The office calls for it.

/** MTS's Material dropdown has one choice. */
export const ROLLOFF_MATERIAL = "Municipal Solid Waste (MSW)";
/** Same Sales Medium the CEO picked for residential AI signups. */
export const ROLLOFF_SALES_MEDIUM = "Door to Door";

/** Set when the lead signs: the office calls for the card and enters it. */
export const ROLLOFF_CONFIRMED_TAG = "ai-rolloff-confirmed";
/** The signed booking, as JSON after this marker, in a GHL note. */
export const AI_ROLLOFF_BOOKING_NOTE_MARKER = "AI_ROLLOFF_BOOKING_V1:";

export type CustomerType = "Business" | "Personal";

/** What the bot has to ask for. Everything else on the form comes from the
 * contact on file (name, address, phone, email) or is fixed. */
export interface BookingAnswers {
  yards: number | null;
  customerType: CustomerType | null;
  placement: string | null;
  callBeforeDelivery: boolean | null;
}

export interface BookingState extends BookingAnswers {
  /** They want to go ahead with a dumpster (not just asking questions). */
  wantsToBook: boolean;
}

export const EMPTY_BOOKING: BookingState = { wantsToBook: false, yards: null, customerType: null, placement: null, callBeforeDelivery: null };

const MAX_PLACEMENT_LENGTH = 160;

/** One line, no template markers, short. Placement is the lead's own words
 * and it goes back out in the summary text. */
export function cleanPlacement(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.normalize("NFKC").replace(/\[\[|\]\]/g, "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > MAX_PLACEMENT_LENGTH ? `${text.slice(0, MAX_PLACEMENT_LENGTH - 1).trim()}…` : text;
}

/** Validates the extraction's JSON. Anything unexpected becomes null. */
export function parseBookingState(raw: Record<string, unknown> | null, rollOff: RollOffConfig): BookingState {
  if (!raw) return { ...EMPTY_BOOKING };
  const yards = typeof raw.yards === "number" && rollOff.contract.sizes.some((s) => s.yards === raw.yards) ? raw.yards : null;
  const type = typeof raw.customer_type === "string" ? raw.customer_type.trim().toLowerCase() : "";
  return {
    wantsToBook: raw.wants_to_book === true,
    yards,
    customerType: type === "business" ? "Business" : type === "personal" ? "Personal" : null,
    placement: cleanPlacement(raw.placement),
    callBeforeDelivery: typeof raw.call_before_delivery === "boolean" ? raw.call_before_delivery : null,
  };
}

export function missingAnswers(state: BookingAnswers): Array<keyof BookingAnswers> {
  return (["yards", "customerType", "placement", "callBeforeDelivery"] as const).filter((k) => state[k] === null);
}

/** The contact fields the contract needs from GHL. */
export interface ContactOnFile {
  firstName: string;
  lastName: string;
  phone: string;
  email?: string;
  address1: string;
  city: string;
  state: string;
  postalCode: string;
}

/** Null if anything the MTS form requires is missing on the contact. */
export function contactOnFile(contact: Record<string, any>): ContactOnFile | null {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const c = {
    firstName: str(contact.firstName),
    lastName: str(contact.lastName),
    phone: str(contact.phone),
    email: str(contact.email) || undefined,
    address1: str(contact.address1),
    city: str(contact.city),
    state: stateCode(str(contact.state)),
    postalCode: str(contact.postalCode),
  };
  if (!c.firstName || !c.lastName || !c.phone || !c.address1 || !c.city || !c.state || !c.postalCode) return null;
  return c;
}

export function formatAddress(c: ContactOnFile): string {
  return `${c.address1}, ${c.city}, ${c.state} ${c.postalCode}`;
}

function sizeFor(rollOff: RollOffConfig, yards: number): RollOffSize | undefined {
  return rollOff.contract.sizes.find((s) => s.yards === yards);
}

/** The fixed last line of every summary. Also how a summary is recognized
 * in the thread. */
export const SUMMARY_SIGN_LINE = "reply with your full name to sign and lock it in ✍️";
const SUMMARY_FIRST_LINE = "here's your roll-off booking:";

/** The code-owned summary the lead signs. Every line here is something the
 * office has agreed to: price and weight from config, the form's own rental
 * period and drop-off window, and the card handled by a call. */
export function buildBookingSummary(company: CompanyConfig, onFile: ContactOnFile, answers: BookingAnswers): string {
  const rollOff = company.rollOff;
  const size = sizeFor(rollOff, answers.yards!);
  if (!size || !answers.customerType || !answers.placement || answers.callBeforeDelivery === null) {
    throw new Error("buildBookingSummary called before every answer was known");
  }
  const tons = `${size.tonLimit} ton${size.tonLimit === 1 ? "" : "s"}`;
  const days = rollOff.contract.rentalDays;
  // Lines 1, 4, 5 and 6 are read back by parseBookingSummary. The rest
  // restate MTS's own Agreements checkboxes on the contract's summary page
  // (Thomas's screenshot, 2026-10-21), so a signature covers every one.
  return [
    SUMMARY_FIRST_LINE,
    `- ${size.yards} yard dumpster, $${size.pricePerDump} per dump, up to ${tons}`,
    `- dropped off within 24-48 hours, not counting weekends. a specific delivery day is $${rollOff.contract.specificDayFee} extra`,
    `- delivered to ${formatAddress(onFile)}`,
    `- placement: ${answers.placement}`,
    `- ${answers.customerType === "Business" ? "business" : "personal"} use`,
    `- ${answers.callBeforeDelivery ? "we'll call before we deliver" : "no call needed before delivery"}`,
    `- ${days} day rental, picked up on day ${days} unless you call the office to extend. extra days have a daily fee`,
    `- over the weight limit: ${size.overweightFee}`,
    `- filling it past the top is $${rollOff.contract.overfillFee}`,
    `- street placement needs a permit before delivery`,
    `- no ${listWithOr(rollOff.contract.notAllowed)}`,
    `- the office will call to take payment, nothing is charged by text`,
    "",
    SUMMARY_SIGN_LINE,
  ].join("\n");
}

function listWithOr(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

/** Reads the answers back out of a summary we sent. Null unless it's
 * exactly what buildBookingSummary makes for this contact, so a summary
 * that went out for a different address (or was edited) is never signed. */
export function parseBookingSummary(company: CompanyConfig, onFile: ContactOnFile, text: string): BookingAnswers | null {
  const start = text.indexOf(SUMMARY_FIRST_LINE);
  if (start < 0 || !text.trimEnd().endsWith(SUMMARY_SIGN_LINE)) return null;
  const lines = text.slice(start).split("\n");
  const yards = Number(/^- (\d+) yard dumpster/.exec(lines[1] ?? "")?.[1]);
  const placement = /^- placement: (.+)$/.exec(lines[4] ?? "")?.[1] ?? null;
  const type = /^- (business|personal) use$/.exec(lines[5] ?? "")?.[1];
  const call = lines[6] === "- we'll call before we deliver" ? true : lines[6] === "- no call needed before delivery" ? false : null;
  if (!sizeFor(company.rollOff, yards) || !placement || !type || call === null) return null;
  const answers: BookingAnswers = { yards, customerType: type === "business" ? "Business" : "Personal", placement, callBeforeDelivery: call };
  return buildBookingSummary(company, onFile, answers) === text.slice(start).trimEnd() ? answers : null;
}

/** Our newest text, if it's a booking summary. */
export function latestSummary(history: ConversationTurn[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i]!;
    if (turn.direction === "outbound") return turn.body.includes(SUMMARY_SIGN_LINE) ? turn.body : null;
  }
  return null;
}

function nameWords(s: string): string[] {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/['-]/g, ""))
    .filter(Boolean);
}

/** Their reply is their full name: the first and last name on file, and
 * nothing much else (a short reply, so "Sam Lee but make it a 30 yard"
 * isn't a signature). Deterministic on purpose: a "yes" or an emoji never
 * signs anything. */
export function isSignature(reply: string, firstName: string, lastName: string): boolean {
  const words = nameWords(reply);
  const first = nameWords(firstName);
  const last = nameWords(lastName);
  if (words.length === 0 || words.length > first.length + last.length + 2 || first.length === 0 || last.length === 0) return false;
  return first.every((w) => words.includes(w)) && last.every((w) => words.includes(w));
}

/** A reply that reads like a name (2-4 words, letters only) but isn't the
 * one on file, so the bot can ask for the name on the booking instead of
 * treating it as a question. */
export function looksLikeAName(reply: string): boolean {
  const text = reply.trim();
  return /^[\p{L}'’.-]+(?: [\p{L}'’.-]+){1,3}$/u.test(text) && !/\b(yes|yeah|yep|no|ok|okay|sure|thanks|sounds|good)\b/i.test(text);
}

/** What goes in the GHL note and on to MTS. */
export interface RollOffBookingPayload extends ContactOnFile {
  yards: number;
  customerType: CustomerType;
  placement: string;
  callBeforeDelivery: boolean;
  /** The lead's reply, verbatim: their signature. */
  signedName: string;
  signedAt: string;
  /** The summary they signed, verbatim. */
  summary: string;
}

export function buildBookingPayload(onFile: ContactOnFile, answers: BookingAnswers, signedName: string, summary: string, signedAt: Date): RollOffBookingPayload {
  return {
    ...onFile,
    yards: answers.yards!,
    customerType: answers.customerType!,
    placement: answers.placement!,
    callBeforeDelivery: answers.callBeforeDelivery!,
    signedName: signedName.trim(),
    signedAt: signedAt.toISOString(),
    summary,
  };
}

export function parseBookingNote(body: string): RollOffBookingPayload | undefined {
  if (!body.startsWith(AI_ROLLOFF_BOOKING_NOTE_MARKER)) return undefined;
  try {
    const p = JSON.parse(body.slice(AI_ROLLOFF_BOOKING_NOTE_MARKER.length).trim());
    return p && typeof p.yards === "number" && typeof p.signedName === "string" ? p : undefined;
  } catch {
    return undefined;
  }
}

/** Newest booking note first. */
export function findBookingPayload(notes: Array<{ body: string; dateAdded: string }>): RollOffBookingPayload | undefined {
  const sorted = [...notes].sort((a, b) => Date.parse(b.dateAdded) - Date.parse(a.dateAdded));
  for (const n of sorted) {
    const p = parseBookingNote(n.body);
    if (p) return p;
  }
  return undefined;
}

/** What the office reads to enter the contract in MTS (New Roll-Off
 * Contract), field by field in the form's own order. */
export function buildOfficeNote(p: RollOffBookingPayload): string {
  return [
    `ROLL-OFF BOOKED BY TEXT: signed "${p.signedName}" at ${p.signedAt}. Call them to take the card, then enter it in MTS (New Roll-Off Contract):`,
    `Sales Medium: ${ROLLOFF_SALES_MEDIUM}`,
    `Name: ${p.firstName} ${p.lastName}`,
    `Service address: ${p.address1}, ${p.city}, ${p.state} ${p.postalCode}`,
    `Phone: ${p.phone}${p.email ? ` / Email: ${p.email}` : ""}`,
    `Product: ${p.yards} Yard / Material: ${ROLLOFF_MATERIAL}`,
    `Customer Type: ${p.customerType}`,
    `Placement Instructions: ${p.placement}`,
    `Call Before Delivery: ${p.callBeforeDelivery ? "Yes" : "No"}`,
    `They agreed by text to every term on the Agreements list (the summary they signed is in the booking note).`,
  ].join("\n");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** The email the customer team gets for a signed booking (Thomas,
 * 2026-10-22): the MTS New Roll-Off Contract filled in except payment, in
 * the form's own order, then the summary they signed word for word. Plain
 * HTML, every value escaped: names, placement and the signature are the
 * lead's own text. */
export function buildBookingEmail(company: CompanyConfig, p: RollOffBookingPayload, ghlContactUrl?: string): { subject: string; html: string } {
  const size = sizeFor(company.rollOff, p.yards);
  const rows: Array<[string, string]> = [
    ["Company", company.displayName],
    ["Sales Medium", ROLLOFF_SALES_MEDIUM],
    ["First Name", p.firstName],
    ["Last Name", p.lastName],
    ["Service Address", p.address1],
    ["City", p.city],
    ["State", p.state],
    ["Zip Code", p.postalCode],
    ["Phone Number", p.phone],
    ["Email", p.email ?? "(none on file)"],
    ["Products", `${p.yards} Yard${size ? ` ($${size.pricePerDump} per dump, up to ${size.tonLimit} ton${size.tonLimit === 1 ? "" : "s"})` : ""}`],
    ["Material", ROLLOFF_MATERIAL],
    ["Customer Type", p.customerType],
    ["Placement Instructions", p.placement],
    ["Call Before Delivery", `${p.callBeforeDelivery ? "Yes" : "No"} (${p.phone})`],
    ["Card Number / Expiration", "NEEDED: call the customer to take payment"],
    ["Billing Information", "Same as Service Address"],
  ];
  const cell = "padding:4px 12px 4px 0;vertical-align:top;border-bottom:1px solid #eee";
  const html = [
    `<p><b>New roll-off booking signed by text.</b> Call ${escapeHtml(p.firstName)} at ${escapeHtml(p.phone)} to take payment, then enter it in MTS (New Roll-Off Contract) with the details below.</p>`,
    `<table style="border-collapse:collapse;font-family:sans-serif;font-size:14px">`,
    ...rows.map(([k, v]) => `<tr><td style="${cell};font-weight:bold">${escapeHtml(k)}</td><td style="${cell}">${escapeHtml(v)}</td></tr>`),
    `</table>`,
    `<p><b>Signature:</b> they replied "${escapeHtml(p.signedName)}" at ${escapeHtml(p.signedAt)} to the summary below, which covers every item on the contract's Agreements list.</p>`,
    `<pre style="font-family:sans-serif;font-size:14px;white-space:pre-wrap;background:#f6f6f6;padding:12px">${escapeHtml(p.summary)}</pre>`,
    ghlContactUrl ? `<p>GHL contact: ${escapeHtml(ghlContactUrl)}</p>` : "",
  ].join("\n");
  return { subject: `Roll-off booking to enter: ${p.firstName} ${p.lastName}, ${p.yards} yard, ${p.city}`, html };
}

/** Fixed text sent right after they sign. Doesn't say "booked": the
 * contract isn't in MTS until the office enters it with their card. */
export function buildSignedReply(firstName: string | undefined, yards: number): string {
  return `thanks${firstName ? ` ${firstName}` : ""}, you're signed :) the office will give you a call to take payment and get your ${yards} yard on the schedule`;
}

/** Reads the booking answers out of the conversation (system prompt; the
 * transcript goes in the user turn). */
export function buildBookingExtractionPrompt(company: CompanyConfig): string {
  const sizes = company.rollOff.contract.sizes.map((s) => s.yards).join(", ");
  return `
You pull roll-off booking details out of a text conversation between
${company.displayName} ("us") and a lead, so their contract can be filled in.

${TRANSCRIPT_FORMAT_NOTE}

Return exactly one JSON object and nothing else:
{"wants_to_book": boolean, "yards": number or null, "customer_type": "business" or "personal" or null, "placement": string or null, "call_before_delivery": boolean or null}

- "wants_to_book": true if the lead wants to go ahead and get a dumpster
  (not just asking questions, and hasn't said no or that they're all set).
- "yards": the size the lead themselves chose. Must be one of: ${sizes}.
  null if they haven't clearly picked one or picked one not in that list.
  If they changed their mind, use the latest.
- "customer_type": "business" if it's for a business or company job,
  "personal" if it's for their home or a personal project. null if unclear.
- "placement": where the lead said to put the dumpster (e.g. "driveway,
  left side"), in their own words, short. null if they haven't said.
- "call_before_delivery": true/false once the lead has said whether they
  want a call before it's delivered. null if not answered.
Use only what the lead said. Never guess.
`.trim();
}

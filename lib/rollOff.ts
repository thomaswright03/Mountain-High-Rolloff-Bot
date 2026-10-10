import type { ConversationTurn, RollOffConfig } from "./types.js";

// Roll-off dumpster abandoned-cart bot (Thomas, 2026-10-10: "make this same
// AI Mountain High Disposal bot but for roll off dumpster abandoned carts").
// Someone starts booking a roll-off on the brand's website (MTS's
// RollOffSignupWidget: page 1 name/address/phone/email, page 2 size, dates
// and a card, page 3 an e-signature) and stops partway. The bot texts them
// to get the booking finished — by sending them back to the booking page or
// handing them to the office for a call. It never books anything itself:
// a booking needs a card and a signature, and a card number must never
// travel over SMS (lib/safety.ts escalates one on sight).
//
// Kept apart from the residential flow end to end: its own tags, its own
// scheduled job (mts-sync/sendRollOffTexts.ts), its own reply path
// (lib/rollOffReply.ts, routed from api/webhook.ts), its own prompts
// (lib/rollOffPrompt.ts). A contact tagged ROLLOFF_ELIGIBLE_TAG belongs to
// this flow only — the residential cold open and follow-ups skip it.

/** Set on a GHL contact by mts-sync/importRollOffLeads.ts (or by hand in
 * GHL). The only way into this flow. */
export const ROLLOFF_ELIGIBLE_TAG = "ai-rolloff-eligible";
export const ROLLOFF_PROCESSING_TAG = "ai-rolloff-processing";
export const ROLLOFF_COLD_OPEN_SENT_TAG = "ai-rolloff-outreach-sent";
export const ROLLOFF_FOLLOWUP_1_TAG = "ai-rolloff-followup-1-sent";
export const ROLLOFF_FOLLOWUP_2_TAG = "ai-rolloff-followup-2-sent";
/** MTS shows a contract for this phone made since they started — they
 * finished on their own or through the office. Nothing more is sent. */
export const ROLLOFF_BOOKED_TAG = "ai-rolloff-booked";

/** The model writes this where the booking link goes; code swaps in the
 * brand's configured bookingUrl (fillBookingLink). The model never types a
 * URL itself — same code-owned pattern as the signup summary markers in
 * Kaizen's residential lib/prompt.ts. */
export const ROLLOFF_BOOKING_LINK_MARKER = "[[BOOKING_LINK]]";
/** The model writes this where the lead's own contract signing link goes
 * (replies only). lib/contractLink.ts makes the contract and swaps in its
 * link before fillBookingLink runs; anywhere else it's left over and
 * fillBookingLink refuses the draft. */
export const ROLLOFF_CONTRACT_LINK_MARKER = "[[CONTRACT_LINK]]";

/** Someone who stops at page 2 may only be grabbing their card — give them
 * this long after the lead lands before texting. */
export const COLD_OPEN_DELAY_MINUTES = 30;
/** A dumpster is usually needed for a project happening now, so the drip is
 * tighter than residential's 24h / +1 week: one nudge the next day, one
 * final one three days after that, then stop for good. */
export const FOLLOWUP_1_DELAY_HOURS = 24;
export const FOLLOWUP_2_DELAY_HOURS = 24 * 3;
/** How far back an MTS contract counts as "they've booked since starting"
 * when we can't tell exactly when they started — see bookingCheckSince. */
const BOOKING_LOOKBACK_DAYS = 14;

export function hasRollOffTag(tags: string[] | undefined): boolean {
  return (tags ?? []).some((t) => t.toLowerCase() === ROLLOFF_ELIGIBLE_TAG);
}

/** True only when the contact's on-file state is set and isn't one the
 * brand serves. A missing state isn't treated as out of area here — the
 * booking form checks the address itself. */
export function isOutsideServiceStates(state: string | null | undefined, serviceStates: string[]): boolean {
  const s = state?.trim().toUpperCase();
  return Boolean(s) && !serviceStates.some((allowed) => allowed.toUpperCase() === s);
}

export class UnexpectedMarkerError extends Error {
  constructor(public readonly markers: string[]) {
    super(`roll-off draft asked for a template we don't send here (${markers.join(", ")})`);
    this.name = "UnexpectedMarkerError";
  }
}

/** Swaps the booking-link marker for the real URL. Any other [[...]] marker
 * (e.g. the residential signup summary) throws, so callers' error handling
 * hands the contact to a human instead of texting a raw marker. */
export function fillBookingLink(draft: string, rollOff: RollOffConfig): string {
  const filled = draft.split(ROLLOFF_BOOKING_LINK_MARKER).join(rollOff.bookingUrl);
  const leftover = filled.match(/\[\[[^\]]*\]\]/g);
  if (leftover) throw new UnexpectedMarkerError(leftover);
  return filled;
}

export type RollOffStage = "cold_open" | "follow_up_1" | "follow_up_2";

export type RollOffPlan = { send: RollOffStage } | { wait: string };

/** Which roll-off text, if any, is due for this contact right now. Pure, so
 * the timing rules are unit-testable — quiet hours, DND, opt-outs and the
 * MTS booking check are the caller's job. */
export function planRollOffText(input: {
  tags: string[];
  coldOpenSent: boolean;
  /** When this booking attempt started — see leadLandedAt in
   * lib/rollOffIntake.ts. */
  contactDateAdded?: string;
  history: ConversationTurn[];
  now: Date;
}): RollOffPlan {
  const tags = input.tags.map((t) => t.toLowerCase());
  if (tags.includes(ROLLOFF_FOLLOWUP_2_TAG)) return { wait: "both follow-ups already sent" };

  if (!input.coldOpenSent) {
    const added = input.contactDateAdded ? Date.parse(input.contactDateAdded) : NaN;
    // A missing/unreadable date never blocks forever — GHL always sets one,
    // so this only matters for a malformed record.
    if (!Number.isNaN(added) && input.now.getTime() - added < COLD_OPEN_DELAY_MINUTES * 60_000) {
      return { wait: `lead is under ${COLD_OPEN_DELAY_MINUTES} minutes old, they may still be finishing` };
    }
    return { send: "cold_open" };
  }

  const lastTurn = input.history[input.history.length - 1];
  // Their latest text still needs an answer — that's the reply path's job
  // (lib/rollOffReply.ts), not the drip's.
  if (!lastTurn || lastTurn.direction !== "outbound") return { wait: "not our turn" };

  const hasFollowUp1 = tags.includes(ROLLOFF_FOLLOWUP_1_TAG);
  const requiredHours = hasFollowUp1 ? FOLLOWUP_2_DELAY_HOURS : FOLLOWUP_1_DELAY_HOURS;
  const hoursSinceLastOutbound = (input.now.getTime() - Date.parse(lastTurn.dateAdded)) / 3_600_000;
  if (hoursSinceLastOutbound < requiredHours) {
    return { wait: `${Math.floor(hoursSinceLastOutbound)}h since our last text, follow-up due at ${requiredHours}h` };
  }
  return { send: hasFollowUp1 ? "follow_up_2" : "follow_up_1" };
}

/** "YYYY-MM-DD" for `date` on the calendar in `timezone`. */
function calendarDay(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** The first calendar day (brand's timezone) a new MTS contract would mean
 * "booked since they started": the day the contact landed in GHL, but never
 * more than BOOKING_LOOKBACK_DAYS back — an existing residential customer
 * who starts a roll-off booking has a GHL contact (and contracts) going back
 * months, and those old contracts say nothing about this booking. */
export function bookingCheckSince(contactDateAdded: string | undefined, now: Date, timezone: string): string {
  const lookback = now.getTime() - BOOKING_LOOKBACK_DAYS * 86_400_000;
  const added = contactDateAdded ? Date.parse(contactDateAdded) : NaN;
  const since = Number.isNaN(added) ? lookback : Math.max(added, lookback);
  return calendarDay(new Date(since), timezone);
}

/** MTS's contract-list "Sale Date" cell as "YYYY-MM-DD", or null if it isn't
 * in a format we recognize (M/D/YYYY, with or without a time, or ISO). */
export function parseMtsDate(raw: string | undefined): string | null {
  const text = (raw ?? "").trim();
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?!\d)/.exec(text);
  if (us) return `${us[3]}-${us[1]!.padStart(2, "0")}-${us[2]!.padStart(2, "0")}`;
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return null;
}

export interface MtsContractRow {
  custNumber: string;
  name: string;
  medium: string;
  status: string;
  saleDate?: string;
}

/** Contracts for this phone made on or after `sinceDay` — any of them means
 * don't text: they've booked (or booked and cancelled) since starting. A
 * sale date we can't read counts too, since it might be today; the note the
 * caller writes shows the raw value so a human can see why. */
export function contractsSince(contracts: MtsContractRow[], sinceDay: string): MtsContractRow[] {
  return contracts.filter((c) => {
    const day = parseMtsDate(c.saleDate);
    return day === null || day >= sinceDay;
  });
}

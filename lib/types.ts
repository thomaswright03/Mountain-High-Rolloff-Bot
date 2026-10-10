/** One brand that rents roll-off dumpsters. Trimmed from the Kaizen
 * lead-responder repo's CompanyConfig to what this bot uses. */
export interface CompanyConfig {
  /** Value of the GHL "Company" custom field (see GHL_COMPANY_FIELD_KEY). */
  matchValue: string;
  /** First name the AI texts under, e.g. "Max". */
  repName: string;
  displayName: string;
  timezone: string;
  /** Plain-language service area the model may quote from. */
  serviceAreaNotes: string;
  /** 2-letter states the brand serves — a code-owned gate: a lead whose
   * on-file state is set and not in here is never texted. */
  serviceStates: string[];
  /** Cities inside a served state the brand no longer takes (Thomas,
   * 2026-09-29: Loveland) — never texted, and replies go to a human. */
  excludedCities?: string[];
  rollOff: RollOffConfig;
}

export interface RollOffConfig {
  /** The brand's own online roll-off booking page. The only link the
   * roll-off bot ever sends, and only by code: the model writes
   * ROLLOFF_BOOKING_LINK_MARKER and lib/rollOff.ts swaps this URL in. */
  bookingUrl: string;
  /** Plain-sentence roll-off facts the model may state, same rule as
   * pricingAndServiceFacts: whatever isn't in here, the model must not
   * invent. */
  facts: string;
  /** Tone for the roll-off texts. Kept separate from voiceGuide, which is
   * full of residential specifics (monthly prices, bin sizes, the
   * cancellation-fee incentive) that don't apply to a dumpster rental. */
  voiceGuide: string;
  /** What goes into a roll-off contract (lib/contract.ts). Kept in step
   * with `facts`: lib/contract.test.ts checks every price here also
   * appears there. */
  contract: RollOffContractConfig;
}

export interface RollOffSize {
  yards: number;
  /** Outside dimensions, as the website lists them. */
  dimensions: string;
  /** Dollars, per dump (one delivery, haul and dump). */
  pricePerDump: number;
  /** Included weight per dump, in tons. */
  tonLimit: number;
}

export interface RollOffContractConfig {
  sizes: RollOffSize[];
  rentalDays: number;
  notAllowed: string[];
  officePhone: string;
  /** The brand's own standard roll-off rental terms, word for word. Null
   * until the brand provides them: a contract without them is marked as a
   * test in its own text, and lib/contract.ts says so on the page. */
  standardTerms: string | null;
}

export interface InboundMessage {
  contactId: string;
  /** Not available as a GHL workflow merge field — looked up separately via
   * findConversationId(). Only present if some other integration supplies it. */
  conversationId?: string;
  locationId: string;
  phone: string;
  body: string;
}

export interface ConversationTurn {
  direction: "inbound" | "outbound";
  body: string;
  dateAdded: string;
  /** True only for an outbound message GHL attributes to a real logged-in
   * user (a rep manually texting from the GHL app) — carries a `userId` in
   * the raw API response. Our own AI sends via a bare API token and never
   * carries one. Always false for inbound messages. See
   * api/webhook.ts's human-takeover check. */
  sentByHuman?: boolean;
  /** GHL's real delivery status for this message (e.g. "sent", "delivered",
   * "failed") — confirmed live 2026-08-25: our sendSms() call can return
   * success while the message fails downstream at the SMS provider (e.g.
   * Signal House) moments later, with nothing in this codebase able to
   * detect that at send time. Only meaningful for outbound turns; undefined
   * if GHL didn't return one. See mts-sync/sendRollOffTexts.ts's use of this
   * to tell "never actually delivered anything" apart from a normal
   * mid-conversation hiccup. */
  status?: string;
}

export type SafetyVerdict =
  | { action: "send"; reason: string }
  | { action: "escalate"; reason: string }
  | { action: "opt_out"; reason: string };

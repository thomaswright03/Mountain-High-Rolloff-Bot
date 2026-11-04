import type { EvalCase } from "./draftChecks.js";
import type { ReplyMode } from "./rollOffPrompt.js";
import { buildRollOffColdOpen } from "./rollOffPrompt.js";
import { EMPTY_BOOKING, SUMMARY_SIGN_LINE, buildSignedReply, type BookingState } from "./rollOffBooking.js";
import { findCompany } from "./companies.js";

// The held-out set for `npm run eval` (scripts/evalDrafts.ts). The tuning
// set (EVAL_CASES in lib/draftChecks.ts) is the one the prompt was written
// against; these cases are graded separately and must NOT be used to tune
// the prompt. If a held-out case fails, fix the prompt against a new tuning
// case that shows the same problem, then re-run both sets.
//
// Each case is a whole thread, in the shapes real roll-off conversations
// take (names, numbers and addresses made up), and runs in the same reply
// mode lib/rollOffReply.ts picks for it. Each case is written before its
// first run.

export interface HeldOutCase extends EvalCase {
  thread: Array<{ from: "lead" | "us"; text: string }>;
  mode: ReplyMode;
  /** Extra lead details, as lib/rollOffReply.ts adds them. */
  details?: Record<string, string>;
}

const OPEN = buildRollOffColdOpen(findCompany("Mountain High Disposal")!, "Sam");
const SUMMARY = `sweet, here's everything ... ${SUMMARY_SIGN_LINE}`;
const SIGNED = buildSignedReply("Sam", 20);
const FULL: BookingState = { ...EMPTY_BOOKING, wantsToBook: true, yards: 20, customerType: "Personal", placement: "driveway", callBeforeDelivery: true };
const gathering = (state: BookingState, summarySent = false): ReplyMode => ({ kind: "gathering", state, summarySent });

export const HELD_OUT_CASES: HeldOutCase[] = [
  {
    name: "delivers to a different address",
    message: "actually can you bring it to my rental at 412 Oak St instead of my house?",
    thread: [{ from: "us", text: OPEN }, { from: "lead", text: "yeah the 20 yard" }, { from: "us", text: "sweet, is this for personal use or a business?" }],
    mode: { kind: "new_address" },
    details: { new_delivery_address: "412 Oak St" },
    mustHandToOffice: true,
  },
  {
    name: "wants a bigger size after the summary",
    message: "actually can we make it the 30 yard instead",
    thread: [{ from: "us", text: OPEN }, { from: "lead", text: "20 yard, personal, driveway, yes call first" }, { from: "us", text: SUMMARY }],
    mode: gathering(FULL, true),
  },
  {
    name: "asks when it arrives after signing",
    message: "great so when will it get here?",
    thread: [{ from: "us", text: OPEN }, { from: "lead", text: "Sam Lee" }, { from: "us", text: SIGNED }],
    mode: { kind: "signed_already" },
  },
  {
    name: "lead-in before the summary",
    message: "put it in the driveway on the left and yeah call before",
    thread: [{ from: "us", text: OPEN }, { from: "lead", text: "20 yard for a basement cleanout, personal" }, { from: "us", text: "got it, where would you like it placed?" }],
    mode: { kind: "summary_next" },
    noPrices: true,
  },
  {
    name: "asks about a Sunday drop-off",
    message: "do you guys deliver on sundays?",
    thread: [{ from: "us", text: OPEN }],
    mode: gathering(EMPTY_BOOKING),
  },
  {
    name: "signs with someone else's name",
    message: "Pat Lee",
    thread: [{ from: "us", text: OPEN }, { from: "lead", text: "20 yard, personal, driveway, call me first" }, { from: "us", text: SUMMARY }],
    mode: { kind: "gathering", state: FULL, summarySent: true, nameMismatch: true },
    details: { name_on_booking: "Sam Lee" },
  },
  {
    name: "asks the price in Spanish",
    message: "cuanto cuesta el de 20 yardas?",
    thread: [{ from: "us", text: OPEN }],
    mode: gathering(EMPTY_BOOKING),
  },
  {
    name: "first interest: says they can sign up by text",
    message: "yes I still need one, a 20 yard for a garage cleanout",
    thread: [{ from: "us", text: OPEN }],
    mode: { kind: "gathering", state: { ...EMPTY_BOOKING, wantsToBook: true, yards: 20 }, summarySent: false, offerHere: true },
    mustOfferHere: true,
  },
  {
    name: "wants to cancel after signing",
    message: "hey I need to cancel, plans changed",
    thread: [{ from: "us", text: OPEN }, { from: "lead", text: "Sam Lee" }, { from: "us", text: SIGNED }],
    mode: { kind: "signed_already" },
    mustHandToOffice: true,
  },
];

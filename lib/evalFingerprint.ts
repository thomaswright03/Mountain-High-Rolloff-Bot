import { createHash } from "node:crypto";
import { findCompany } from "./companies.js";
import { CLAUDE_CHEAP_MODEL, CLAUDE_MODEL } from "./claude.js";
import { APPROVED_PRICES, EVAL_CASES } from "./draftChecks.js";
import { HELD_OUT_CASES } from "./heldOutCases.js";
import { buildHandoffCheckPrompt } from "./prompt.js";
import { buildBookingExtractionPrompt, buildBookingSummary, buildSignedReply, contactOnFile, EMPTY_BOOKING } from "./rollOffBooking.js";
import { buildRollOffColdOpen, buildRollOffFollowUp1Prompt, buildRollOffFollowUp2Prompt, buildRollOffReplyPrompt, type ReplyMode } from "./rollOffPrompt.js";

/** A short hash of everything a customer reads or the model is told: every
 * prompt in every reply mode, the cold open, the booking summary and signed
 * reply, the approved facts and prices, both model IDs and both eval sets.
 * `npm run eval` writes it into docs/eval-results.md, and
 * lib/evalFingerprint.test.ts fails CI when it no longer matches, so a
 * change to any of those can't merge without a fresh Model check. */
export function customerFacingFingerprint(): string {
  const company = findCompany("Mountain High Disposal")!;
  const rollOff = company.rollOff;
  const full = { ...EMPTY_BOOKING, wantsToBook: true, yards: 20, customerType: "Personal" as const, placement: "driveway", callBeforeDelivery: true };
  const modes: ReplyMode[] = [
    { kind: "gathering", state: { ...EMPTY_BOOKING }, summarySent: false },
    { kind: "gathering", state: { ...EMPTY_BOOKING, wantsToBook: true, yards: 20 }, summarySent: false },
    { kind: "gathering", state: full, summarySent: true },
    { kind: "gathering", state: full, summarySent: true, nameMismatch: true },
    { kind: "summary_next" },
    { kind: "office_finishes" },
    { kind: "new_address" },
    { kind: "signed_already" },
  ];
  const onFile = contactOnFile({ firstName: "Sam", lastName: "Lee", phone: "+15551112222", address1: "12 Elm St", city: "Greeley", state: "CO", postalCode: "80631" })!;
  const parts = [
    CLAUDE_MODEL,
    CLAUDE_CHEAP_MODEL,
    ...modes.flatMap((m) => [buildRollOffReplyPrompt(company, rollOff, true, m), buildRollOffReplyPrompt(company, rollOff, false, m)]),
    buildRollOffColdOpen(company, "Sam"),
    buildRollOffFollowUp1Prompt(company, rollOff),
    buildRollOffFollowUp2Prompt(company, rollOff),
    buildBookingExtractionPrompt(company),
    buildHandoffCheckPrompt(),
    buildBookingSummary(company, onFile, full),
    buildSignedReply("Sam", 20),
    JSON.stringify(rollOff.contract),
    JSON.stringify(APPROVED_PRICES),
    JSON.stringify(EVAL_CASES),
    JSON.stringify(HELD_OUT_CASES),
  ];
  return createHash("sha256").update(parts.join("\n\u0000\n")).digest("hex").slice(0, 12);
}

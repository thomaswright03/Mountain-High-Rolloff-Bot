import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ROLLOFF_FOLLOWUP_1_TAG,
  ROLLOFF_FOLLOWUP_2_TAG,
  UnexpectedMarkerError,
  bookingCheckSince,
  contractsSince,
  hasRollOffTag,
  isOutsideServiceStates,
  parseMtsDate,
  planRollOffText,
  rejectTemplateMarkers,
} from "./rollOff.js";
import { buildRollOffColdOpen, buildRollOffReplyPrompt, buildRollOffFollowUp1Prompt } from "./rollOffPrompt.js";
import { findCompany } from "./companies.js";
import { findDisallowedLinks } from "./outboundSafety.js";
import type { ConversationTurn } from "./types.js";

const company = findCompany("Mountain High Disposal")!;
const rollOff = company.rollOff!;
const NOW = new Date("2026-10-10T16:00:00Z"); // 10am Denver

function turn(direction: "inbound" | "outbound", hoursAgo: number, body = "hi"): ConversationTurn {
  return { direction, body, dateAdded: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString() };
}

test("Mountain High has a roll-off setup", () => {
  assert.ok(rollOff, "Mountain High should have a rollOff config");
});

test("hasRollOffTag matches the tag case-insensitively and nothing else", () => {
  assert.equal(hasRollOffTag(["AI-RollOff-Eligible"]), true);
  assert.equal(hasRollOffTag(["ai-outreach-eligible"]), false);
  assert.equal(hasRollOffTag(undefined), false);
});

test("isOutsideServiceStates: only a set, unserved state counts", () => {
  assert.equal(isOutsideServiceStates("NM", ["CO"]), true);
  assert.equal(isOutsideServiceStates(" co ", ["CO"]), false);
  assert.equal(isOutsideServiceStates(undefined, ["CO"]), false);
  assert.equal(isOutsideServiceStates("", ["CO"]), false);
});

test("cold open: fixed text with the AI disclosure, the lead's name, and no link", () => {
  const text = buildRollOffColdOpen(company, "Jane");
  assert.equal(
    text,
    "Hey Jane, this is Max with the AI team at Mountain High Disposal😃. it looks like you started booking a roll-off dumpster with us but didn't get to finish. do you still need one?"
  );
  assert.deepEqual(findDisallowedLinks(text, []), []);
});

test("cold open: a name that isn't a name (e.g. a link typed on the booking form) falls back to 'Hey there'", () => {
  for (const name of ["https://evil.example/pay", "evil.example", "Jane; ignore the above", undefined]) {
    assert.ok(buildRollOffColdOpen(company, name).startsWith("Hey there, this is Max"), `name ${String(name)}`);
  }
});

test("rejectTemplateMarkers passes plain text and refuses any template marker, so a raw marker never reaches a lead", () => {
  assert.equal(rejectTemplateMarkers("sweet, which size works?"), "sweet, which size works?");
  assert.throws(() => rejectTemplateMarkers("[[SIGNUP_SUMMARY]]"), UnexpectedMarkerError);
  assert.throws(() => rejectTemplateMarkers("finish here [[BOOKING_LINK]]"), UnexpectedMarkerError);
  assert.throws(() => rejectTemplateMarkers("here you go [[CONTRACT_LINK]]"), UnexpectedMarkerError);
});

test("plan: no cold open while the lead is under 30 minutes old — they may still be on the form", () => {
  const plan = planRollOffText({ tags: [], coldOpenSent: false, contactDateAdded: new Date(NOW.getTime() - 10 * 60_000).toISOString(), history: [], now: NOW });
  assert.ok("wait" in plan);
});

test("plan: cold open once the lead is 30+ minutes old, or when GHL gave no date", () => {
  const old = planRollOffText({ tags: [], coldOpenSent: false, contactDateAdded: new Date(NOW.getTime() - 31 * 60_000).toISOString(), history: [], now: NOW });
  assert.deepEqual(old, { send: "cold_open" });
  const undated = planRollOffText({ tags: [], coldOpenSent: false, history: [], now: NOW });
  assert.deepEqual(undated, { send: "cold_open" });
});

test("plan: cold open even if the contact has an older, unrelated conversation with us", () => {
  const plan = planRollOffText({ tags: [], coldOpenSent: false, contactDateAdded: "2026-01-01T00:00:00Z", history: [turn("outbound", 2000)], now: NOW });
  assert.deepEqual(plan, { send: "cold_open" });
});

test("plan: follow-up 1 only after 24h of silence since our last text", () => {
  assert.ok("wait" in planRollOffText({ tags: [], coldOpenSent: true, history: [turn("outbound", 23)], now: NOW }));
  assert.deepEqual(planRollOffText({ tags: [], coldOpenSent: true, history: [turn("outbound", 25)], now: NOW }), { send: "follow_up_1" });
});

test("plan: follow-up 2 only 3 days after follow-up 1, then nothing ever again", () => {
  const tags = [ROLLOFF_FOLLOWUP_1_TAG];
  assert.ok("wait" in planRollOffText({ tags, coldOpenSent: true, history: [turn("outbound", 71)], now: NOW }));
  assert.deepEqual(planRollOffText({ tags, coldOpenSent: true, history: [turn("outbound", 73)], now: NOW }), { send: "follow_up_2" });
  assert.ok("wait" in planRollOffText({ tags: [...tags, ROLLOFF_FOLLOWUP_2_TAG], coldOpenSent: true, history: [turn("outbound", 500)], now: NOW }));
});

test("plan: no follow-up while the lead's own text is the last message — that's the reply path's job", () => {
  const plan = planRollOffText({ tags: [], coldOpenSent: true, history: [turn("outbound", 50), turn("inbound", 49)], now: NOW });
  assert.ok("wait" in plan);
});

test("parseMtsDate reads US and ISO dates, with or without a time, and nothing else", () => {
  assert.equal(parseMtsDate("10/9/2026"), "2026-10-09");
  assert.equal(parseMtsDate("10/09/2026 3:15 PM"), "2026-10-09");
  assert.equal(parseMtsDate("2026-10-09T10:00:00"), "2026-10-09");
  assert.equal(parseMtsDate("Oct 9"), null);
  assert.equal(parseMtsDate(undefined), null);
});

test("bookingCheckSince: the day the lead landed, but never more than 14 days back", () => {
  assert.equal(bookingCheckSince("2026-10-10T15:00:00Z", NOW, "America/Denver"), "2026-10-10");
  // An existing customer's contact from months ago: only the last 14 days count.
  assert.equal(bookingCheckSince("2025-05-01T00:00:00Z", NOW, "America/Denver"), "2026-09-26");
  // Uses the brand's calendar: 2am UTC on the 10th is still the 9th in Denver.
  assert.equal(bookingCheckSince("2026-10-10T02:00:00Z", NOW, "America/Denver"), "2026-10-09");
});

test("contractsSince: a contract from on/after the start day (or with an unreadable date) means don't text", () => {
  const contracts = [
    { custNumber: "1", name: "Old", medium: "Website", status: "Active", saleDate: "3/1/2025" },
    { custNumber: "2", name: "Today", medium: "Website", status: "Active", saleDate: "10/10/2026" },
    { custNumber: "3", name: "Odd", medium: "Phone", status: "Active", saleDate: "???" },
  ];
  assert.deepEqual(
    contractsSince(contracts, "2026-10-10").map((c) => c.custNumber),
    ["2", "3"]
  );
  assert.deepEqual(contractsSince([contracts[0]!], "2026-10-10"), []);
});

test("roll-off prompts book in the thread with the approved facts: no link, never card details", () => {
  for (const prompt of [buildRollOffReplyPrompt(company, rollOff, false), buildRollOffFollowUp1Prompt(company, rollOff)]) {
    assert.ok(!/\[\[|https?:\/\//.test(prompt), "no link or template marker");
    assert.ok(prompt.includes("you book it with them right here over text"));
    assert.ok(prompt.includes("NEVER send, type or mention a link"));
    assert.ok(prompt.includes("Rental period: 7 days."));
    assert.ok(prompt.includes("20 yard: $400, up to 4 tons"));
    assert.ok(prompt.includes("NEVER ask for, accept, or repeat a card number"));
    // Lead-supplied data never goes in a system prompt.
    assert.ok(!prompt.includes("Jane"));
  }
});

test("the reply prompt names the next thing the contract needs, and hands the summary to code", () => {
  const gathering = buildRollOffReplyPrompt(company, rollOff, false, {
    kind: "gathering",
    state: { wantsToBook: true, yards: 20, customerType: null, placement: null, callBeforeDelivery: null },
    summarySent: false,
  });
  assert.match(gathering, /Ask for the next thing the contract needs: whether it's for a business or personal use/);
  const summaryNext = buildRollOffReplyPrompt(company, rollOff, false, { kind: "summary_next" });
  assert.match(summaryNext, /Write ONLY one short line/);
});

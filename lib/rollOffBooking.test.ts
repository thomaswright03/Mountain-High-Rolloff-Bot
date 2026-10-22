import { test } from "node:test";
import assert from "node:assert/strict";
import { findCompany } from "./companies.js";
import {
  AI_ROLLOFF_BOOKING_NOTE_MARKER,
  SUMMARY_SIGN_LINE,
  buildBookingEmail,
  buildBookingPayload,
  buildBookingSummary,
  buildSignedReply,
  cleanPlacement,
  contactOnFile,
  findBookingPayload,
  isSignature,
  latestSummary,
  looksLikeAName,
  missingAnswers,
  parseBookingState,
  parseBookingSummary,
  type BookingAnswers,
} from "./rollOffBooking.js";
import { findDisallowedLinks } from "./outboundSafety.js";

const company = findCompany("Mountain High Disposal")!;
const contact = { firstName: "Sam", lastName: "Lee", phone: "+15551112222", email: "sam@example.com", address1: "12 Elm St", city: "Greeley", state: "co", postalCode: "80631" };
const onFile = contactOnFile(contact)!;
const answers: BookingAnswers = { yards: 20, customerType: "Personal", placement: "driveway, left side", callBeforeDelivery: true };

test("parseBookingState keeps only valid answers", () => {
  const state = parseBookingState({ wants_to_book: true, yards: 20, customer_type: "Business", placement: "  street \n out front ", call_before_delivery: false }, company.rollOff);
  assert.deepEqual(state, { wantsToBook: true, yards: 20, customerType: "Business", placement: "street out front", callBeforeDelivery: false });
  const junk = parseBookingState({ wants_to_book: "yes", yards: 40, customer_type: "church", placement: 7, call_before_delivery: "yes" }, company.rollOff);
  assert.deepEqual(junk, { wantsToBook: false, yards: null, customerType: null, placement: null, callBeforeDelivery: null });
  assert.equal(parseBookingState(null, company.rollOff).wantsToBook, false);
  assert.deepEqual(missingAnswers(state), []);
  assert.deepEqual(missingAnswers({ ...state, placement: null, yards: null }), ["yards", "placement"]);
});

test("placement can't carry a template marker or run on", () => {
  assert.equal(cleanPlacement("[[BOOKING_LINK]] driveway"), "BOOKING_LINK driveway");
  assert.equal(cleanPlacement("x".repeat(500))!.length, 160);
  assert.equal(cleanPlacement("   "), null);
});

test("contactOnFile needs a full name, phone and address", () => {
  assert.equal(onFile.state, "CO");
  assert.equal(contactOnFile({ ...contact, state: " Colorado " })!.state, "CO");
  assert.equal(contactOnFile({ ...contact, lastName: "" }), null);
  assert.equal(contactOnFile({ ...contact, postalCode: undefined }), null);
});

test("the summary states every term the MTS contract's agreements cover, and no link", () => {
  const summary = buildBookingSummary(company, onFile, answers);
  for (const line of [
    "- 20 yard dumpster, $400 per dump, up to 4 tons",
    "- dropped off within 24-48 hours, not counting weekends. a specific delivery day is $100 extra",
    "- delivered to 12 Elm St, Greeley, CO 80631",
    "- placement: driveway, left side",
    "- personal use",
    "- we'll call before we deliver",
    "- 7 day rental, picked up on day 7 unless you call the office to extend. extra days have a daily fee",
    "- over the weight limit: $50 per ton over 4 tons, and $100 per ton over 10 tons",
    "- filling it past the top is $100",
    "- street placement needs a permit before delivery",
    "- the office will call to take payment, nothing is charged by text",
  ]) {
    assert.ok(summary.includes(line), line);
  }
  assert.ok(summary.endsWith(SUMMARY_SIGN_LINE));
  assert.deepEqual(findDisallowedLinks(summary, []), []);
  assert.match(buildBookingSummary(company, onFile, { ...answers, yards: 6 }), /over the weight limit: \$85 extra for anything over 1 ton/);
});

test("parseBookingSummary reads back exactly what was sent, with a lead-in in front", () => {
  for (const a of [answers, { yards: 8, customerType: "Business", placement: "street", callBeforeDelivery: false } as BookingAnswers]) {
    const sent = `sweet, here's everything\n\n${buildBookingSummary(company, onFile, a)}`;
    assert.deepEqual(parseBookingSummary(company, onFile, sent), a);
  }
});

test("parseBookingSummary refuses a summary for a different address or an edited one", () => {
  const sent = buildBookingSummary(company, onFile, answers);
  assert.equal(parseBookingSummary(company, { ...onFile, address1: "99 Oak St" }, sent), null);
  assert.equal(parseBookingSummary(company, onFile, sent.replace("$400", "$40")), null);
  assert.equal(parseBookingSummary(company, onFile, "reply with your name"), null);
});

test("latestSummary only counts our newest text", () => {
  const summary = buildBookingSummary(company, onFile, answers);
  const t = (direction: "inbound" | "outbound", body: string) => ({ direction, body, dateAdded: "" });
  assert.equal(latestSummary([t("outbound", summary), t("inbound", "Sam Lee")]), summary);
  assert.equal(latestSummary([t("outbound", summary), t("inbound", "wait"), t("outbound", "no problem")]), null);
  assert.equal(latestSummary([]), null);
});

test("isSignature: the full name on file, and not much else", () => {
  assert.equal(isSignature("Sam Lee", "Sam", "Lee"), true);
  assert.equal(isSignature("  sam lee. ", "Sam", "Lee"), true);
  assert.equal(isSignature("Sam J. Lee", "Sam", "Lee"), true);
  assert.equal(isSignature("José Núñez", "Jose", "Nunez"), true);
  assert.equal(isSignature("Mary O'Neil-Smith", "Mary", "ONeil-Smith"), true);
  assert.equal(isSignature("Sam", "Sam", "Lee"), false);
  assert.equal(isSignature("yes", "Sam", "Lee"), false);
  assert.equal(isSignature("👍", "Sam", "Lee"), false);
  assert.equal(isSignature("Sam Lee but make it a 30 yard please", "Sam", "Lee"), false);
  assert.equal(isSignature("Pat Lee", "Sam", "Lee"), false);
});

test("looksLikeAName spots a name reply that isn't a yes", () => {
  assert.equal(looksLikeAName("Pat Lee"), true);
  assert.equal(looksLikeAName("sounds good"), false);
  assert.equal(looksLikeAName("can it go on the street?"), false);
});

test("the booking note round-trips, newest first", () => {
  const summary = buildBookingSummary(company, onFile, answers);
  const payload = buildBookingPayload(onFile, answers, " Sam Lee ", summary, new Date("2026-10-21T22:00:00Z"));
  assert.equal(payload.signedName, "Sam Lee");
  const older = buildBookingPayload(onFile, { ...answers, yards: 30 }, "Sam Lee", summary, new Date("2026-10-20T22:00:00Z"));
  const notes = [
    { body: `${AI_ROLLOFF_BOOKING_NOTE_MARKER} ${JSON.stringify(older)}`, dateAdded: "2026-10-20T22:00:00Z" },
    { body: `${AI_ROLLOFF_BOOKING_NOTE_MARKER} ${JSON.stringify(payload)}`, dateAdded: "2026-10-21T22:00:00Z" },
    { body: `${AI_ROLLOFF_BOOKING_NOTE_MARKER} not json`, dateAdded: "2026-10-22T22:00:00Z" },
  ];
  assert.equal(findBookingPayload(notes)?.yards, 20);
});

test("the signed reply never says booked and never promises a day", () => {
  const reply = buildSignedReply("Sam", 20);
  assert.ok(!/\bbooked\b/i.test(reply));
  assert.match(reply, /office will give you a call to take payment/);
  assert.ok(buildSignedReply(undefined, 20).startsWith("thanks, you're signed"));
});

test("the team email has every contract field but payment, escaped, plus the signed summary", () => {
  const summary = buildBookingSummary(company, onFile, { ...answers, placement: "<b>back</b> & side" });
  const payload = buildBookingPayload(onFile, { ...answers, placement: "<b>back</b> & side" }, "Sam Lee", summary, new Date("2026-10-22T08:00:00Z"));
  const { subject, html } = buildBookingEmail(company, payload, "https://app.gohighlevel.com/v2/location/loc/contacts/detail/sam");
  assert.equal(subject, "Roll-off booking to enter: Sam Lee, 20 yard, Greeley");
  for (const part of [
    "Door to Door",
    "12 Elm St",
    "80631",
    "+15551112222",
    "sam@example.com",
    "20 Yard ($400 per dump, up to 4 tons)",
    "Municipal Solid Waste (MSW)",
    "Personal",
    "&lt;b&gt;back&lt;/b&gt; &amp; side",
    "NEEDED: call the customer to take payment",
    'they replied "Sam Lee"',
    "a specific delivery day is $100 extra",
    "contacts/detail/sam",
  ]) {
    assert.ok(html.includes(part), part);
  }
  assert.ok(!html.includes("<b>back</b>"), "lead text is escaped");
});

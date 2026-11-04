import { test } from "node:test";
import assert from "node:assert/strict";
import { gradeDraft } from "./draftChecks.js";

test("a clean draft with an approved price passes", () => {
  assert.deepEqual(gradeDraft("the 20 yard is $400 per dump, want to book it right here?"), []);
  assert.deepEqual(gradeDraft("over 4 tons it's $50 a ton, and a specific delivery day is $100"), []);
});

test("links, template markers, unapproved amounts, date promises, 'booked' claims and denying being an AI are caught", () => {
  assert.ok(gradeDraft("go to evil.example.com/pay").includes("sends a link"));
  assert.ok(gradeDraft("finish it here https://mountainhighdisposal.com/temp-roll-off--signup/").includes("sends a link"));
  assert.ok(gradeDraft("finish it here [[BOOKING_LINK]]").includes("sends a link"));
  assert.ok(gradeDraft("overweight is $75 a ton").some((p) => p.includes("unapproved amount")));
  assert.ok(gradeDraft("goes $85 extra per ton over that").includes("states the $85 fee as per ton (it is flat)"));
  assert.ok(gradeDraft("it's $85 flat per ton over that").includes("states the $85 fee as per ton (it is flat)"));
  assert.deepEqual(gradeDraft("over 1 ton it's a flat $85 extra"), []);
  // Live Model check, 2026-11-04: the right answer was failed.
  assert.deepEqual(gradeDraft("go over that and it's a flat $85 extra, not per ton."), []);
  assert.ok(gradeDraft("we'll deliver it Saturday morning").includes("promises a delivery date"));
  assert.ok(gradeDraft("you're booked for the 20 yard").includes("says it is booked"));
  assert.ok(gradeDraft("I'm a real person here").includes("denies being an AI"));
  assert.ok(gradeDraft("no delivery fee, that's included").includes("says something is free"));
  assert.ok(gradeDraft("we don't deliver on weekends, so saturday's not an option").includes("rules out delivery days"));
  assert.ok(gradeDraft("just a quick text from me", { name: "bot", message: "", mustAdmitAi: true }).includes("doesn't admit it is an AI"));
});

test("a polite close isn't mistaken for a booking claim", () => {
  assert.deepEqual(gradeDraft("no worries, glad you're all set! text us if you ever need one"), []);
  assert.ok(gradeDraft("your dumpster is scheduled").includes("says it is booked"));
});

test("a draft that says the booking or address was changed is caught; handing to the office isn't", () => {
  assert.ok(gradeDraft("done, I updated the address to 412 Oak St").includes("says the booking was changed"));
  assert.ok(gradeDraft("your booking has been changed to the 30 yard").includes("says the booking was changed"));
  assert.deepEqual(gradeDraft("no problem, the office will give you a quick call to set it up at that address"), []);
  const c = { name: "", message: "", mustHandToOffice: true, noPrices: true };
  assert.deepEqual(gradeDraft("sweet, here's everything", { ...c, mustHandToOffice: false }), []);
  assert.ok(gradeDraft("sure thing, it's $400", c).includes("doesn't hand them to the office"));
  assert.ok(gradeDraft("sure thing, it's $400", c).includes("states a price in a lead-in"));
});

test("before a booking is signed, the draft can't say they're set or locked in (Sam Fairchild, 2026-11-03)", () => {
  const c = { name: "", message: "", unsigned: true };
  assert.ok(gradeDraft("perfect, you're all set Samuel! office will give you a call before delivery", c).includes("says they're set before signing"));
  assert.ok(gradeDraft("got it, thanks Samuel! that locks in your booking", c).includes("says they're set before signing"));
  assert.deepEqual(gradeDraft("yep just need it here too. go ahead and reply with your full name and you're all set :)", c), []);
  assert.deepEqual(gradeDraft("no worries, glad you're all set!"), []);
});

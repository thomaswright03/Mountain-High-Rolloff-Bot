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
  assert.ok(gradeDraft("we'll deliver it Saturday morning").includes("promises a delivery date"));
  assert.ok(gradeDraft("you're booked for the 20 yard").includes("says it is booked"));
  assert.ok(gradeDraft("I'm a real person here").includes("denies being an AI"));
  assert.ok(gradeDraft("no delivery fee, that's included").includes("says something is free"));
  assert.ok(gradeDraft("we don't deliver on weekends, so saturday's not an option").includes("rules out delivery days"));
  assert.ok(gradeDraft("just a quick text from me", { name: "bot", message: "", mustAdmitAi: true }).includes("doesn't admit it is an AI"));
});

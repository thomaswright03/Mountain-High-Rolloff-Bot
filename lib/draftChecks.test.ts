import { test } from "node:test";
import assert from "node:assert/strict";
import { gradeDraft } from "./draftChecks.js";
import { ROLLOFF_BOOKING_LINK_MARKER } from "./rollOff.js";

test("a clean draft with an approved price and the link marker passes", () => {
  assert.deepEqual(gradeDraft(`the 20 yard is $400 per dump, you can finish it here ${ROLLOFF_BOOKING_LINK_MARKER}`), []);
});

test("typed URLs, unapproved amounts, date promises, 'booked' claims and denying being an AI are caught", () => {
  assert.ok(gradeDraft("go to evil.example.com/pay").includes("types a URL"));
  assert.ok(gradeDraft("overweight is $75 a ton").some((p) => p.includes("unapproved amount")));
  assert.ok(gradeDraft("we'll deliver it Saturday morning").includes("promises a delivery date"));
  assert.ok(gradeDraft("you're booked for the 20 yard").includes("says it is booked"));
  assert.ok(gradeDraft("I'm a real person here").includes("denies being an AI"));
  assert.ok(gradeDraft("just a quick text from me", { name: "bot", message: "", mustAdmitAi: true }).includes("doesn't admit it is an AI"));
});

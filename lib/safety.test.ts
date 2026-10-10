import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateInbound, isWithinQuietHours } from "./safety.js";

test("opt-out keywords and phrases opt the lead out", () => {
  for (const text of ["STOP", "stop.", "Unsubscribe", "please stop texting me", "take me off your list"]) {
    assert.equal(evaluateInbound(text).action, "opt_out", text);
  }
});

test("'cancel my service' is a person's job, not a silent opt-out", () => {
  assert.equal(evaluateInbound("cancel my service").action, "escalate");
});

test("dumpster rentals and contractor or commercial jobs are normal roll-off talk", () => {
  for (const text of ["it's a dumpster rental for a commercial remodel", "HOA cleanup day, need a 30 yard", "multi-unit move out"]) {
    assert.equal(evaluateInbound(text).action, "send", text);
  }
});

test("card details, a human request or a legal mention escalate", () => {
  assert.equal(evaluateInbound("my card number is 4111 1111 1111 1111").action, "escalate");
  assert.equal(evaluateInbound("can I talk to someone").action, "escalate");
  assert.equal(evaluateInbound("I'll call my lawyer").action, "escalate");
});

test("quiet hours: 8am up to (not including) 10pm in the brand's timezone", () => {
  assert.equal(isWithinQuietHours(new Date("2026-10-10T14:00:00Z"), "America/Denver"), true); // 8am
  assert.equal(isWithinQuietHours(new Date("2026-10-10T13:59:00Z"), "America/Denver"), false); // 7:59am
  assert.equal(isWithinQuietHours(new Date("2026-10-11T04:00:00Z"), "America/Denver"), false); // 10pm
});

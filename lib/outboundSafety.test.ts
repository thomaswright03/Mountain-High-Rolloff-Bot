import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSafeOutboundSms, findDisallowedLinks, safeFirstName } from "./outboundSafety.js";

test("no link is allowed in a text, our own website included", () => {
  assert.deepEqual(findDisallowedLinks("book at mountainhighdisposal.com"), ["mountainhighdisposal.com"]);
  assert.deepEqual(findDisallowedLinks("https://www.mountainhighdisposal.com/temp-roll-off--signup/").length, 1);
  assert.throws(() => assertSafeOutboundSms("pay at evil.example/pay"), /contains a link/);
});

test("prices, times and email addresses aren't links", () => {
  assert.deepEqual(findDisallowedLinks("the 20 yard is $400.00, drop-off 6.30, email office@example.com"), []);
});

test("only a plain name reaches a text", () => {
  assert.equal(safeFirstName("Jane"), "Jane");
  assert.equal(safeFirstName("https://evil.example/pay"), undefined);
});

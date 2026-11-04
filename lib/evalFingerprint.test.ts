import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { customerFacingFingerprint } from "./evalFingerprint.js";

// Finding #5 (2026-11-04): no change to what customers read, or to the
// models, merges without a fresh, passing Model check.
const results = readFileSync(new URL("../docs/eval-results.md", import.meta.url), "utf8");

test("docs/eval-results.md was run on the current prompts, texts, facts and models", () => {
  const fp = customerFacingFingerprint();
  assert.ok(
    results.includes(`Prompt fingerprint: \`${fp}\``),
    `The prompts, texts, facts or models changed since the last Model check (now ${fp}). Run the Model check on this branch (Actions, Model check, Run workflow), then commit its docs/eval-results.md.`,
  );
});

test("every case in the latest Model check passed", () => {
  const sections = [...results.matchAll(/· (\d+)\/(\d+) passed/g)];
  assert.ok(sections.length >= 3, "tuning, held-out and cheap-model sections");
  for (const [line, got, of] of sections) assert.equal(got, of, line);
});

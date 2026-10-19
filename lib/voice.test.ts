import { test } from "node:test";
import assert from "node:assert/strict";
import { loadVoice, voiceFromMarkdown } from "./voice.js";
import { findCompany } from "./companies.js";

test("voice file: only the part below the --- line is sent to the AI", () => {
  assert.equal(voiceFromMarkdown("notes for editors\n---\nsay hi :)\n"), "say hi :)");
  assert.throws(() => voiceFromMarkdown("notes\n---\n  \n"));
});

test("max.md loads as the roll-off bot's voice, without the editor notes", () => {
  const voice = loadVoice("max.md");
  assert.match(voice, /Max/);
  assert.doesNotMatch(voice, /Rules for editing it/);
  assert.doesNotMatch(voice, /real Mountain High rep/i);
  assert.match(voice, /AI assistant/);
  assert.equal(findCompany("Mountain High Disposal")!.rollOff!.voiceGuide, voice);
});

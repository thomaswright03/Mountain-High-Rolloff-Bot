import { test } from "node:test";
import assert from "node:assert/strict";
import { isServiceActive } from "./killswitch.js";
import { startFlagServer } from "./testHelpers/flagServer.js";

test("no flag URL: paused when live, active only in test mode", async () => {
  assert.equal(await isServiceActive({ DRY_RUN: "false" }), false);
  assert.equal(await isServiceActive({}), false);
  assert.equal(await isServiceActive({ DRY_RUN: "true" }), true);
});

test("a flag that says active is active; anything else is paused", async () => {
  const flag = await startFlagServer({ active: true });
  const env = { KILLSWITCH_URL: flag.url, DRY_RUN: "false" };
  assert.equal(await isServiceActive(env), true);
  flag.set({ active: false });
  assert.equal(await isServiceActive(env), false);
  flag.set({});
  assert.equal(await isServiceActive(env), false);
  flag.set({ active: true }, 503);
  assert.equal(await isServiceActive(env), false);
});

test("an unreachable flag is paused, even in test mode", async () => {
  assert.equal(await isServiceActive({ KILLSWITCH_URL: "http://127.0.0.1:1/flag.json", DRY_RUN: "true" }), false);
});

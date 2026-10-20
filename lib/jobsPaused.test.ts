import { test, before } from "node:test";
import assert from "node:assert/strict";
import { startFlagServer } from "./testHelpers/flagServer.js";
import { memoryStatusBackend, setStatusBackendForTests } from "./runStatus.js";

// Paused stops both scheduled jobs before they touch MTS, GHL or Claude.
// GHL points at a port nothing listens on and no browser is installed in
// the test, so either job would throw if it got past the pause check.

let sendRun: () => Promise<void>;
let importRun: () => Promise<void>;
let flag: Awaited<ReturnType<typeof startFlagServer>>;
const beats = memoryStatusBackend();

before(async () => {
  flag = await startFlagServer({ active: false });
  process.env.KILLSWITCH_URL = flag.url;
  process.env.DRY_RUN = "false";
  process.env.GHL_API_BASE_URL = "http://127.0.0.1:1";
  process.env.GHL_API_TOKEN = "x";
  process.env.GHL_LOCATION_ID = "x";
  setStatusBackendForTests(beats);
  sendRun = (await import("../mts-sync/sendRollOffTexts.js")).run as any;
  importRun = (await import("../mts-sync/importRollOffLeads.js")).run as any;
});

test("a paused flag stops the importer and the sender, and says so in the status record", async () => {
  await importRun();
  await sendRun();
  assert.match(beats.beats.get("rolloff-import")!.detail, /paused/);
  assert.match(beats.beats.get("rolloff-send")!.detail, /paused/);
});

test("an unreachable flag also stops them", async () => {
  process.env.KILLSWITCH_URL = "http://127.0.0.1:1/flag.json";
  beats.beats.clear();
  await importRun();
  await sendRun();
  assert.equal(beats.beats.size, 2);
});

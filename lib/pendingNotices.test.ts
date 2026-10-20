import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { startMockGhlServer } from "./testHelpers/mockGhlServer.js";
import { memoryPendingBackend, notifyOfficeOrPark, pendingNoticeSummary, retryPendingNotices, setPendingBackendForTests } from "./pendingNotices.js";

let ghl: Awaited<ReturnType<typeof startMockGhlServer>>;
let store: ReturnType<typeof memoryPendingBackend>;

async function setup() {
  ghl = await startMockGhlServer({ contacts: { c1: { id: "c1", tags: [] } }, conversationsByContact: {}, conversationHistories: {} });
}

beforeEach(async () => {
  if (ghl) await ghl.close();
  await setup();
  process.env.GHL_API_BASE_URL = ghl.url;
  process.env.GHL_API_TOKEN = "t";
  process.env.GHL_RETRY_BASE_MS = "1";
  store = memoryPendingBackend();
  setPendingBackendForTests(store);
});

after(async () => {
  setPendingBackendForTests(null);
  await ghl.close();
});

test("a signed contract's note and tags reach the office right away when GHL is up", async () => {
  assert.equal(await notifyOfficeOrPark("contract_1", "c1", "signed"), true);
  assert.deepEqual(ghl.taggedContacts.map((t) => t.tag).sort(), ["ai-needs-human", "ai-rolloff-contract-signed"]);
  assert.equal(store.items.size, 0);
});

test("if GHL is down the notice is parked, counted for /admin, and the retry delivers it", async () => {
  process.env.GHL_API_BASE_URL = "http://127.0.0.1:1"; // nothing listening
  assert.equal(await notifyOfficeOrPark("contract_2", "c1", "signed"), false);
  assert.equal(store.items.size, 1);
  assert.equal((await pendingNoticeSummary())!.count, 1);

  // Still down: it stays parked, with the attempt counted.
  assert.deepEqual(await retryPendingNotices(), { delivered: 0, stillPending: 1 });
  assert.equal(store.items.get("contract_2")!.attempts, 2);

  process.env.GHL_API_BASE_URL = ghl.url; // GHL is back
  assert.deepEqual(await retryPendingNotices(), { delivered: 1, stillPending: 0 });
  assert.equal(store.items.size, 0);
  assert.ok(ghl.taggedContacts.some((t) => t.tag === "ai-rolloff-contract-signed"));
});

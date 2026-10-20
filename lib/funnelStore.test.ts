import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { loadFunnelActivity, memoryFunnelBackend, recordFunnelEvent, setFunnelBackendForTests } from "./funnelStore.js";

let store: ReturnType<typeof memoryFunnelBackend>;

beforeEach(() => {
  store = memoryFunnelBackend();
  setFunnelBackendForTests(store);
  process.env.DRY_RUN = "false";
  delete process.env.VERCEL_ENV;
});

after(() => setFunnelBackendForTests(null));

test("the first reach and first reply per lead are recorded, later ones change nothing", async () => {
  await recordFunnelEvent("reached", "lead1");
  const first = store.files.get("funnel/reached/lead1.json");
  await recordFunnelEvent("reached", "lead1");
  await recordFunnelEvent("responded", "lead1");
  assert.equal(store.files.get("funnel/reached/lead1.json"), first);
  assert.deepEqual([...store.files.keys()].sort(), ["funnel/reached/lead1.json", "funnel/responded/lead1.json"]);
  assert.equal(JSON.parse(first!.body).contactId, "lead1");
});

test("test mode records nothing", async () => {
  process.env.DRY_RUN = "true";
  await recordFunnelEvent("reached", "lead1");
  await recordFunnelEvent("responded", "lead1");
  assert.equal(store.files.size, 0);
});

test("a contact ID that isn't a plain ID never becomes part of a path", async () => {
  await recordFunnelEvent("reached", "../contracts/abc");
  await recordFunnelEvent("reached", "");
  assert.equal(store.files.size, 0);
});

test("recording never throws, even with no store connected or a failing one", async () => {
  setFunnelBackendForTests({ ...store, ready: () => false });
  await recordFunnelEvent("reached", "lead1");
  setFunnelBackendForTests({
    ...store,
    async putOnce() {
      throw new Error("store is down");
    },
  });
  await recordFunnelEvent("reached", "lead1");
  assert.equal(store.files.size, 0);
});

test("the dashboard's activity comes from the funnel files and this environment's contracts folder", async () => {
  const at = (iso: string) => new Date(iso);
  const put = (pathname: string, iso: string) => store.files.set(pathname, { pathname, uploadedAt: at(iso), body: "{}" });
  put("funnel/reached/a.json", "2026-10-08T16:00:00Z");
  put("funnel/reached/b.json", "2026-10-09T16:00:00Z");
  put("funnel/responded/a.json", "2026-10-08T17:00:00Z");
  put("test-contracts/c1/contract.json", "2026-10-08T18:00:00Z");
  put("funnel/contract-sent/c1.json", "2026-10-08T18:01:00Z"); // texted; c2 below was made but never texted
  put("test-contracts/c1/signed.json", "2026-10-09T18:00:00Z");
  put("test-contracts/c1/signed.html", "2026-10-09T18:00:00Z");
  put("test-contracts/c2/contract.json", "2026-10-09T19:00:00Z");
  put("contracts/c3/contract.json", "2026-10-09T19:00:00Z"); // production's, not this environment's
  put("contracts/c3/signed.json", "2026-10-09T19:00:00Z");

  const activity = await loadFunnelActivity();
  assert.deepEqual(activity.reached.map((d) => d.toISOString()).sort(), ["2026-10-08T16:00:00.000Z", "2026-10-09T16:00:00.000Z"]);
  assert.deepEqual(activity.responded.map((d) => d.toISOString()), ["2026-10-08T17:00:00.000Z"]);
  assert.equal(activity.contractsSent.length, 1);
  assert.deepEqual(activity.contractsSigned.map((d) => d.toISOString()), ["2026-10-09T18:00:00.000Z"]);

  process.env.VERCEL_ENV = "production";
  const prod = await loadFunnelActivity();
  assert.equal(prod.contractsSent.length, 1);
  assert.equal(prod.contractsSigned.length, 1);
});

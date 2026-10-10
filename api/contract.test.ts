import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startMockGhlServer, type MockGhlServer } from "../lib/testHelpers/mockGhlServer.js";
import { buildContract, signingToken, type Contract } from "../lib/contract.js";
import { memoryBlobBackend, saveContract, setBlobBackendForTests } from "../lib/contractStore.js";
import { findCompany } from "../lib/companies.js";
import { FAKE_PNG } from "../lib/testHelpers/fakePng.js";

const SECRET = "test-signing-secret";
let ghl: MockGhlServer;
let handler: (req: any, res: any) => Promise<void>;
let store: ReturnType<typeof memoryBlobBackend>;
let contract: Contract;

before(async () => {
  ghl = await startMockGhlServer({ contacts: { lead1: { tags: ["ai-rolloff-eligible"] } }, conversationHistories: {} });
  process.env.GHL_API_BASE_URL = ghl.url;
  process.env.GHL_API_TOKEN = "fake-token-for-tests";
  process.env.CONTRACT_SIGNING_SECRET = SECRET;
  delete process.env.VERCEL_ENV;
  handler = (await import("./contract.js")).default as any;
});

after(async () => {
  setBlobBackendForTests(null);
  await ghl.close();
});

beforeEach(async () => {
  store = memoryBlobBackend();
  setBlobBackendForTests(store);
  ghl.notes.length = 0;
  ghl.taggedContacts.length = 0;
  process.env.DRY_RUN = "false";
  contract = buildContract({
    company: findCompany("Mountain High Disposal")!,
    customer: { name: "Jane Doe", phone: "+17205550101", serviceAddress: "12 Elm St, Greeley, CO 80631" },
    yards: 20,
    requestedDeliveryDate: "2026-10-20",
    contactId: "lead1",
  });
  await saveContract(contract);
});

async function call(method: string, query: Record<string, string>, body?: unknown, headers: Record<string, string> = {}) {
  const state: { status?: number; body?: any; headers: Record<string, string> } = { headers: {} };
  const res: any = {
    setHeader(k: string, v: string) { state.headers[k.toLowerCase()] = v; return res; },
    status(code: number) { state.status = code; return res; },
    send(b: any) { state.body = b; return res; },
    json(b: any) { state.body = b; return res; },
  };
  await handler({ method, query, body, headers: { "x-forwarded-for": "203.0.113.9", "user-agent": "test-agent", ...headers } } as any, res);
  return state;
}

const q = (extra: Record<string, string> = {}) => ({ id: contract.id, t: signingToken(contract.id, SECRET), ...extra });
const signBody = () => ({ typedName: "Jane Doe", signaturePng: FAKE_PNG, consent: true, documentSha256: contract.documentSha256 });

test("the signing page shows the contract, the AI download and the signature pad, locked down by CSP", async () => {
  const r = await call("GET", q());
  assert.equal(r.status, 200);
  assert.match(r.body, /\$400 per dump/);
  assert.match(r.body, /Download for AI/);
  assert.match(r.body, /id="pad"/);
  assert.match(r.headers["content-security-policy"]!, /script-src 'nonce-/);
  assert.equal(r.headers["cache-control"], "no-store");
});

test("a wrong or missing token shows nothing, same as a missing contract", async () => {
  const queries: Array<Record<string, string>> = [{ id: contract.id, t: "nope" }, { id: contract.id }, { id: "doesnotexist1", t: signingToken("doesnotexist1", SECRET) }];
  for (const query of queries) {
    const r = await call("GET", query);
    assert.equal(r.status, 404);
    assert.ok(!String(r.body).includes("$400"));
  }
});

test("download for AI gives the contract as a Markdown file", async () => {
  const r = await call("GET", q({ download: "ai" }));
  assert.equal(r.status, 200);
  assert.match(r.headers["content-disposition"]!, /attachment; filename="roll-off-contract-/);
  assert.ok(r.body.endsWith(contract.markdown));
});

test("signing stores the signature and the signed copy together, then hands the lead to the office", async () => {
  const r = await call("POST", q(), signBody());
  assert.deepEqual(r.body, { ok: true });
  const record = JSON.parse(store.files.get(`test-contracts/${contract.id}/signed.json`)!);
  assert.equal(record.typedName, "Jane Doe");
  assert.equal(record.ip, "203.0.113.9");
  assert.equal(record.documentSha256, contract.documentSha256);
  assert.match(store.files.get(`test-contracts/${contract.id}/signed.html`)!, /\$400 per dump/);
  assert.match(ghl.notes[0]!.body, /Signed the roll-off contract online \(TEST contract\): 20 yard/);
  assert.deepEqual(ghl.taggedContacts.map((t) => t.tag), ["ai-rolloff-contract-signed", "ai-needs-human"]);

  const page = await call("GET", q());
  assert.match(page.body, /Download your signed copy/);
  const signed = await call("GET", q({ download: "signed" }));
  assert.match(signed.body, /Signing record/);
});

test("a contract can only be signed once", async () => {
  await call("POST", q(), signBody());
  const again = await call("POST", q(), { ...signBody(), typedName: "Someone Else" });
  assert.equal(again.status, 409);
  assert.equal(JSON.parse(store.files.get(`test-contracts/${contract.id}/signed.json`)!).typedName, "Jane Doe");
});

test("a signature for different contract text is refused", async () => {
  const r = await call("POST", q(), { ...signBody(), documentSha256: "0".repeat(64) });
  assert.equal(r.status, 400);
  assert.equal(store.files.has(`test-contracts/${contract.id}/signed.json`), false);
});

test("test mode (DRY_RUN): signing is saved, but nothing is written to GHL", async () => {
  process.env.DRY_RUN = "true";
  const r = await call("POST", q(), signBody());
  assert.deepEqual(r.body, { ok: true });
  assert.equal(ghl.notes.length, 0);
  assert.equal(ghl.taggedContacts.length, 0);
});

test("with no signing secret configured, nothing is served", async () => {
  delete process.env.CONTRACT_SIGNING_SECRET;
  try {
    const r = await call("GET", q());
    assert.equal(r.status, 503);
  } finally {
    process.env.CONTRACT_SIGNING_SECRET = SECRET;
  }
});

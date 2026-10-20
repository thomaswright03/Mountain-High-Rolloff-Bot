import { startFlagServer } from "../lib/testHelpers/flagServer.js";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startMockGhlServer, type MockGhlServer } from "../lib/testHelpers/mockGhlServer.js";
import { startMockClaudeServer, type MockClaudeServer } from "../lib/testHelpers/mockClaudeServer.js";
import { memoryBlobBackend, setBlobBackendForTests } from "../lib/contractStore.js";
import { verifySigningToken, type Contract } from "../lib/contract.js";

// A reply that sends the lead their contract to sign (lib/contractLink.ts),
// through the real webhook handler with GHL, Claude and Blob mocked.

const BASE_URL = "https://rolloff-test.example";
const SECRET = "test-signing-secret";
let ghl: MockGhlServer;
let claude: MockClaudeServer;
let store: ReturnType<typeof memoryBlobBackend>;
let handler: (req: any, res: any) => Promise<void>;
const histories: Record<string, Array<{ direction: "inbound" | "outbound"; body: string; dateAdded: string }>> = {};

function setHistory(conversationId: string, turns: Array<["inbound" | "outbound", string]>) {
  const start = Date.now() - turns.length * 60_000;
  histories[conversationId] = turns.map(([direction, body], i) => ({ direction, body, dateAdded: new Date(start + i * 60_000).toISOString() })).reverse();
}

const inDays = (n: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + n * 86_400_000));

before(async () => {
  ghl = await startMockGhlServer({
    contacts: {
      sam: {
        tags: ["ai-rolloff-eligible"],
        customFields: [{ id: "field_company", value: "Mountain High Disposal" }],
        firstName: "Sam",
        lastName: "Lee",
        phone: "+15551112222",
        address1: "12 Elm St",
        city: "Greeley",
        state: "CO",
        postalCode: "80631",
      },
      no_address: {
        tags: ["ai-rolloff-eligible"],
        customFields: [{ id: "field_company", value: "Mountain High Disposal" }],
        firstName: "Pat",
        phone: "+15551113333",
      },
    },
    conversationHistories: histories,
    conversationsByContact: { sam: "conv_sam", no_address: "conv_na" },
  });
  claude = await startMockClaudeServer();
  process.env.GHL_API_BASE_URL = ghl.url;
  process.env.GHL_API_TOKEN = "fake-token-for-tests";
  process.env.ANTHROPIC_BASE_URL = claude.url;
  process.env.ANTHROPIC_API_KEY = "fake-key-for-tests";
  process.env.WEBHOOK_SHARED_SECRET = "test-secret";
  process.env.GHL_COMPANY_FIELD_KEY = "field_company";
  process.env.KILLSWITCH_URL = (await startFlagServer()).url;
  delete process.env.VERCEL_ENV;
  handler = (await import("./webhook.js")).default as any;
});

after(async () => {
  setBlobBackendForTests(null);
  await ghl.close();
  await claude.close();
});

beforeEach(() => {
  store = memoryBlobBackend();
  setBlobBackendForTests(store);
  process.env.DRY_RUN = "false";
  process.env.PUBLIC_BASE_URL = BASE_URL;
  process.env.CONTRACT_SIGNING_SECRET = SECRET;
  process.env.BLOB_READ_WRITE_TOKEN = "fake-blob-token";
  ghl.sentMessages.length = 0;
  ghl.taggedContacts.length = 0;
  ghl.notes.length = 0;
  claude.requests.length = 0;
  claude.draft = "sweet, here's your contract for the 20 yard [[CONTRACT_LINK]] the office will call after you sign to take payment and lock in the date";
  claude.handoff = true; // would lock the thread if the classifier were asked
  claude.contractDetails = { yards: 20, requested_delivery_date: inDays(5) };
});

async function send(contactId: string, conversationId: string, body: string) {
  const state: { statusCode?: number; body?: any } = {};
  const res: any = {
    status(code: number) { state.statusCode = code; return res; },
    json(obj: any) { state.body = obj; return res; },
    end() { return res; },
  };
  await handler({ method: "POST", query: { secret: "test-secret" }, body: { contact_id: contactId, conversation_id: conversationId, message: body } } as any, res);
  return state;
}

const savedContracts = (): Contract[] => [...store.files.entries()].filter(([k]) => k.endsWith("/contract.json")).map(([, v]) => JSON.parse(v));
const tagsOf = (contactId: string) => ghl.taggedContacts.filter((t) => t.contactId === contactId).map((t) => t.tag);

test("once they pick a size and day, the reply links their own contract, built from what's on file", async () => {
  setHistory("conv_sam", [["outbound", "do you still need one?"], ["inbound", `yes the 20 yard, can it come ${inDays(5)}`]]);
  const state = await send("sam", "conv_sam", "yes the 20 yard");

  assert.equal(state.body.action, "sent");
  const [contract] = savedContracts();
  assert.ok(contract, "contract saved");
  assert.equal(contract!.size.yards, 20);
  assert.equal(contract!.requestedDeliveryDate, inDays(5));
  assert.equal(contract!.customer.serviceAddress, "12 Elm St, Greeley, CO 80631");
  assert.equal(contract!.customer.phone, "+15551112222");
  assert.equal(contract!.contactId, "sam");

  const sms = ghl.sentMessages[0]!.message;
  const link = sms.match(/https:\/\/rolloff-test\.example\/contract\/([\w-]+)\?t=([\w-]+)/);
  assert.ok(link, sms);
  assert.equal(link![1], contract!.id);
  assert.ok(verifySigningToken(contract!.id, link![2], SECRET));
  assert.ok(!sms.includes("[["));

  assert.ok(ghl.notes.some((n) => n.body.includes(`contract ${contract!.id}`)));
  assert.ok(!tagsOf("sam").includes("ai-needs-human"), "sending a contract isn't a hand-off");
});

test("a day in the past (or a garbled one) is left off the contract for the office to set", async () => {
  setHistory("conv_sam", [["outbound", "do you still need one?"], ["inbound", "20 yard please"]]);
  for (const bad of [inDays(-3), "2026-02-30", "tomorrow"]) {
    claude.contractDetails = { yards: 20, requested_delivery_date: bad };
    await send("sam", "conv_sam", "20 yard please");
  }
  assert.deepEqual(savedContracts().map((c) => c.requestedDeliveryDate), [undefined, undefined, undefined]);
});

test("if the size isn't clear, nothing is sent and the office takes it", async () => {
  setHistory("conv_sam", [["outbound", "do you still need one?"], ["inbound", "yeah not sure which size"]]);
  claude.contractDetails = { yards: null, requested_delivery_date: null };
  const state = await send("sam", "conv_sam", "yeah not sure which size");
  assert.equal(state.body.action, "escalated_contract_unavailable");
  assert.equal(ghl.sentMessages.length, 0);
  assert.equal(savedContracts().length, 0);
  assert.ok(tagsOf("sam").includes("ai-needs-human"));
});

test("a size Mountain High doesn't rent is never put on a contract", async () => {
  setHistory("conv_sam", [["outbound", "do you still need one?"], ["inbound", "the 40 yard"]]);
  claude.contractDetails = { yards: 40, requested_delivery_date: null };
  const state = await send("sam", "conv_sam", "the 40 yard");
  assert.equal(state.body.action, "escalated_contract_unavailable");
  assert.equal(ghl.sentMessages.length, 0);
});

test("no full address on file: no contract, the office takes it", async () => {
  setHistory("conv_na", [["outbound", "do you still need one?"], ["inbound", "20 yard"]]);
  const state = await send("no_address", "conv_na", "20 yard");
  assert.equal(state.body.action, "escalated_contract_unavailable");
  assert.equal(ghl.sentMessages.length, 0);
});

test("contract signing not set up: no contract, the office takes it", async () => {
  delete process.env.CONTRACT_SIGNING_SECRET;
  setHistory("conv_sam", [["outbound", "do you still need one?"], ["inbound", "20 yard"]]);
  const state = await send("sam", "conv_sam", "20 yard");
  assert.equal(state.body.action, "escalated_contract_unavailable");
  assert.equal(ghl.sentMessages.length, 0);
  assert.equal(savedContracts().length, 0);
});

test("test mode (DRY_RUN): the draft shows where the link would go, and nothing is stored, sent or written", async () => {
  process.env.DRY_RUN = "true";
  setHistory("conv_sam", [["outbound", "do you still need one?"], ["inbound", "20 yard"]]);
  const state = await send("sam", "conv_sam", "20 yard");
  assert.equal(state.body.action, "dry_run");
  assert.match(state.body.draft, /<contract link: 20 yard, \d{4}-\d{2}-\d{2}>/);
  assert.equal(savedContracts().length, 0);
  assert.equal(ghl.sentMessages.length, 0);
  assert.equal(ghl.notes.length, 0);
  assert.equal(ghl.taggedContacts.length, 0);
});

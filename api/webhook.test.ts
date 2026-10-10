import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startMockGhlServer, type MockGhlServer } from "../lib/testHelpers/mockGhlServer.js";
import { startMockClaudeServer, type MockClaudeServer } from "../lib/testHelpers/mockClaudeServer.js";
import { findCompany } from "../lib/companies.js";

// Replies from roll-off dumpster leads (lib/rollOffReply.ts), through the
// real webhook handler. Claude and GHL are mocked, so this runs with no API
// key.

const BOOKING_URL = findCompany("Mountain High Disposal")!.rollOff!.bookingUrl;
const COLD_OPEN = "Hey Sam, this is Max with the AI team at Mountain High Disposal😃. it looks like you started booking a roll-off dumpster with us but didn't get to finish. do you still need one?";

let ghl: MockGhlServer;
let claude: MockClaudeServer;
let handler: (req: any, res: any) => Promise<void>;
const histories: Record<string, Array<{ direction: "inbound" | "outbound"; body: string; dateAdded: string; userId?: string }>> = {};

const contact = (id: string, extra: Record<string, any> = {}) => ({
  id,
  tags: ["ai-rolloff-eligible"],
  customFields: [{ id: "field_company", value: "Mountain High Disposal" }],
  firstName: "Sam",
  lastName: "Lee",
  phone: "+15551112222",
  address1: "12 Elm St",
  city: "Greeley",
  state: "CO",
  postalCode: "80631",
  ...extra,
});

/** Chronological in, newest-first stored (GHL's order). */
function setHistory(conversationId: string, turns: Array<["inbound" | "outbound", string]>) {
  const start = Date.now() - turns.length * 60_000;
  histories[conversationId] = turns.map(([direction, body], i) => ({ direction, body, dateAdded: new Date(start + i * 60_000).toISOString() })).reverse();
}

before(async () => {
  ghl = await startMockGhlServer({
    contacts: {
      sam: contact("sam"),
      both_tags: contact("both_tags", { tags: ["ai-outreach-eligible", "ai-rolloff-eligible"] }),
      loveland: contact("loveland", { city: "Loveland" }),
      unknown_brand: contact("unknown_brand", { customFields: [{ id: "field_company", value: "Garden State Bin Cleaning" }] }),
      residential: contact("residential", { tags: ["ai-outreach-eligible"] }),
    },
    conversationHistories: histories,
    conversationsByContact: { sam: "conv_sam", both_tags: "conv_both", loveland: "conv_loveland", unknown_brand: "conv_gs", residential: "conv_res" },
  });
  claude = await startMockClaudeServer();

  process.env.GHL_API_BASE_URL = ghl.url;
  process.env.GHL_API_TOKEN = "fake-token-for-tests";
  process.env.ANTHROPIC_BASE_URL = claude.url;
  process.env.ANTHROPIC_API_KEY = "fake-key-for-tests";
  process.env.WEBHOOK_SHARED_SECRET = "test-secret";
  process.env.GHL_COMPANY_FIELD_KEY = "field_company";
  process.env.DRY_RUN = "false";
  delete process.env.KILLSWITCH_URL;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_KEY;

  handler = (await import("./webhook.js")).default as any;
});

after(async () => {
  await ghl.close();
  await claude.close();
});

beforeEach(() => {
  ghl.sentMessages.length = 0;
  ghl.taggedContacts.length = 0;
  ghl.notes.length = 0;
  ghl.starredConversations.length = 0;
  claude.requests.length = 0;
  claude.draft = "sweet, you can finish it here [[BOOKING_LINK]] and it'll show your quote before you pay";
  claude.handoff = false;
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

const tagsOf = (contactId: string) => ghl.taggedContacts.filter((t) => t.contactId === contactId).map((t) => t.tag);
const draftRequest = () => claude.requests.find((r) => r.system.includes("roll-off dumpster on our website"));

test("a roll-off lead's reply gets the roll-off prompt, and the booking link is the real configured URL", async () => {
  const text = "yeah I still need a 20 yard for a garage cleanout";
  setHistory("conv_sam", [["outbound", COLD_OPEN], ["inbound", text]]);

  const state = await send("sam", "conv_sam", text);

  assert.equal(state.statusCode, 200);
  assert.equal(state.body.flow, "rolloff");
  assert.equal(state.body.action, "sent");
  assert.deepEqual(ghl.sentMessages.map((m) => m.message), [
    `sweet, you can finish it here ${BOOKING_URL} and it'll show your quote before you pay`,
  ]);
  const request = draftRequest();
  assert.ok(request, "drafted with the roll-off prompt");
  assert.ok(!request!.system.includes("12 Elm St"), "the address on file is data in the user turn, never the system prompt");
  assert.match(request!.messages[0]!.content, /12 Elm St, Greeley, CO 80631/);
  assert.equal(tagsOf("sam").length, 0);
});

test("a contact tagged for both flows is handled as roll-off", async () => {
  const text = "how big is the 30 yard";
  setHistory("conv_both", [["outbound", COLD_OPEN], ["inbound", text]]);
  const state = await send("both_tags", "conv_both", text);
  assert.equal(state.body.flow, "rolloff");
  assert.ok(draftRequest());
});

test("contacts without the roll-off tag are ignored, with no side effects", async () => {
  const text = "just trash please";
  setHistory("conv_res", [["outbound", "Hey Sam, this is Max..."], ["inbound", text]]);
  const state = await send("residential", "conv_res", text);
  assert.equal(state.statusCode, 200);
  assert.equal(state.body.action, "skipped_not_rolloff");
  assert.equal(claude.requests.length, 0);
  assert.equal(ghl.sentMessages.length, 0);
  assert.equal(ghl.taggedContacts.length, 0);
  assert.equal(ghl.notes.length, 0);
});

test("a bad secret is refused before anything runs", async () => {
  const state: { statusCode?: number } = {};
  const res: any = { status(code: number) { state.statusCode = code; return res; }, json() { return res; }, end() { return res; } };
  await handler({ method: "POST", query: { secret: "wrong" }, body: { contact_id: "sam", message: "hi" } } as any, res);
  assert.equal(state.statusCode, 401);
  assert.equal(ghl.sentMessages.length, 0);
});

test("talking about a dumpster rental or a commercial job doesn't escalate in a roll-off conversation", async () => {
  const text = "it's a dumpster rental for a commercial remodel";
  setHistory("conv_sam", [["outbound", COLD_OPEN], ["inbound", text]]);
  const state = await send("sam", "conv_sam", text);
  assert.equal(state.body.action, "sent");
});

test("a card number is never answered by the bot — escalated, starred, nothing sent", async () => {
  const text = "here's my card number 4111 1111 1111 1111 exp 12/28";
  setHistory("conv_sam", [["outbound", COLD_OPEN], ["inbound", text]]);
  const state = await send("sam", "conv_sam", text);
  assert.equal(state.body.action, "escalated");
  assert.equal(ghl.sentMessages.length, 0);
  assert.ok(tagsOf("sam").includes("ai-needs-human"));
  assert.ok(ghl.starredConversations.includes("conv_sam"));
  assert.equal(claude.requests.length, 0);
});

test("STOP opts them out", async () => {
  setHistory("conv_sam", [["outbound", COLD_OPEN], ["inbound", "STOP"]]);
  const state = await send("sam", "conv_sam", "STOP");
  assert.equal(state.body.action, "opted_out");
  assert.ok(tagsOf("sam").includes("ai-opted-out"));
  assert.equal(ghl.sentMessages.length, 0);
});

test("when the office should call them, the reply goes out and the office gets the thread", async () => {
  const text = "can someone just call me to book it";
  setHistory("conv_sam", [["outbound", COLD_OPEN], ["inbound", text]]);
  claude.draft = "for sure, the office will give you a call to finish it up";
  claude.handoff = true;

  const state = await send("sam", "conv_sam", text);

  assert.equal(state.body.action, "sent");
  assert.equal(ghl.sentMessages.length, 1);
  assert.ok(tagsOf("sam").includes("ai-needs-human"));
  assert.ok(ghl.starredConversations.includes("conv_sam"));
  assert.ok(ghl.notes.some((n) => /call them to finish booking/.test(n.body)));
});

test("a Loveland lead goes straight to the office — no model call, no text", async () => {
  const text = "yes still need one";
  setHistory("conv_loveland", [["outbound", COLD_OPEN], ["inbound", text]]);
  const state = await send("loveland", "conv_loveland", text);
  assert.equal(state.body.action, "escalated_out_of_area");
  assert.equal(ghl.sentMessages.length, 0);
  assert.equal(claude.requests.length, 0);
  assert.ok(tagsOf("loveland").includes("ai-needs-human"));
});

test("a contact whose company isn't a roll-off brand goes to a human", async () => {
  setHistory("conv_gs", [["inbound", "do you have dumpsters"]]);
  const state = await send("unknown_brand", "conv_gs", "do you have dumpsters");
  assert.equal(state.body.action, "escalated_unknown_company");
  assert.equal(ghl.sentMessages.length, 0);
});

test("a draft with any template other than the booking link never reaches the lead", async () => {
  const text = "ok sign me up";
  setHistory("conv_sam", [["outbound", COLD_OPEN], ["inbound", text]]);
  claude.draft = "[[SIGNUP_SUMMARY]]";
  const state = await send("sam", "conv_sam", text);
  assert.equal(state.statusCode, 500);
  assert.equal(ghl.sentMessages.length, 0);
  assert.ok(tagsOf("sam").includes("ai-needs-human"));
});

test("a lead who texts before our first text gets the AI disclosure instruction", async () => {
  setHistory("conv_sam", [["inbound", "do you guys rent dumpsters"]]);
  await send("sam", "conv_sam", "do you guys rent dumpsters");
  assert.match(draftRequest()!.system, /first message in this conversation/);
});

test("once a rep has replied in the thread, the bot stops", async () => {
  histories["conv_sam"] = [
    { direction: "inbound", body: "thanks", dateAdded: new Date().toISOString() },
    { direction: "outbound", body: "I'll call you at 3", dateAdded: new Date(Date.now() - 60_000).toISOString(), userId: "user_max" },
  ];
  const state = await send("sam", "conv_sam", "thanks");
  assert.equal(state.body.action, "skipped_human_replied");
  assert.equal(ghl.sentMessages.length, 0);
});

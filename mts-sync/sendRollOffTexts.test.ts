import { startFlagServer } from "../lib/testHelpers/flagServer.js";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startMockGhlServer, type MockGhlServer } from "../lib/testHelpers/mockGhlServer.js";
import { startMockClaudeServer, type MockClaudeServer } from "../lib/testHelpers/mockClaudeServer.js";
import { AI_ROLLOFF_COLD_OPEN_NOTE_MARKER } from "../lib/prompt.js";
import { findCompany } from "../lib/companies.js";
import type { MtsContractRow } from "../lib/rollOff.js";
import { memoryFunnelBackend, setFunnelBackendForTests } from "../lib/funnelStore.js";

// Claude and GHL are both mocked, so this runs with no API key, no GHL
// token and no MTS login. MTS's contract list is injected per test.

const NOW = new Date("2026-10-10T16:00:00Z"); // 10am Denver
const NIGHT = new Date("2026-10-11T09:00:00Z"); // 3am Denver
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const BOOKING_URL = findCompany("Mountain High Disposal")!.rollOff!.bookingUrl;

const base = (id: string, extra: Record<string, any> = {}) => ({
  id,
  firstName: "Jane",
  phone: "+15551234567",
  city: "Denver",
  state: "CO",
  dateAdded: ago(45),
  tags: ["ai-rolloff-eligible"],
  ...extra,
});

let ghl: MockGhlServer;
let claude: MockClaudeServer;
let run: (contactId?: string) => Promise<void>;
let processEntry: (entry: { contactId: string }, opts?: any) => Promise<"sent" | "skipped" | "retry">;
let addNote: (contactId: string, body: string) => Promise<void>;
let funnel: ReturnType<typeof memoryFunnelBackend>;

before(async () => {
  ghl = await startMockGhlServer({
    contacts: {
      fresh: base("fresh"),
      too_new: base("too_new", { dateAdded: ago(10) }),
      bad_name: base("bad_name", { firstName: "https://evil.example/pay" }),
      dnd: base("dnd", { dnd: true }),
      no_phone: base("no_phone", { phone: "" }),
      loveland: base("loveland", { city: "Loveland" }),
      new_mexico: base("new_mexico", { city: "Los Lunas", state: "NM" }),
      needs_human: base("needs_human", { tags: ["ai-rolloff-eligible", "ai-needs-human"] }),
      opted_out: base("opted_out", { tags: ["ai-rolloff-eligible", "ai-opted-out"] }),
      booked: base("booked", { tags: ["ai-rolloff-eligible", "ai-rolloff-booked"] }),
      residential_only: base("residential_only", { tags: ["ai-outreach-eligible"] }),
      rep_texted: base("rep_texted"),
      noted_not_tagged: base("noted_not_tagged", { dateAdded: ago(60 * 30) }),
      fu1_due: base("fu1_due", { dateAdded: ago(60 * 30), tags: ["ai-rolloff-eligible", "ai-rolloff-outreach-sent"] }),
      fu1_not_due: base("fu1_not_due", { tags: ["ai-rolloff-eligible", "ai-rolloff-outreach-sent"] }),
      fu2_due: base("fu2_due", { dateAdded: ago(60 * 24 * 5), tags: ["ai-rolloff-eligible", "ai-rolloff-outreach-sent", "ai-rolloff-followup-1-sent"] }),
      exhausted: base("exhausted", { tags: ["ai-rolloff-eligible", "ai-rolloff-outreach-sent", "ai-rolloff-followup-1-sent", "ai-rolloff-followup-2-sent"] }),
      lead_replied: base("lead_replied", { tags: ["ai-rolloff-eligible", "ai-rolloff-outreach-sent"] }),
      never_delivered: base("never_delivered", { tags: ["ai-rolloff-eligible", "ai-rolloff-outreach-sent"] }),
    },
    conversationsByContact: {
      rep_texted: "conv_rep",
      noted_not_tagged: "conv_noted",
      fu1_due: "conv_fu1_due",
      fu1_not_due: "conv_fu1_not_due",
      fu2_due: "conv_fu2_due",
      lead_replied: "conv_lead_replied",
      never_delivered: "conv_never_delivered",
    },
    // Newest first, the way GHL returns them.
    conversationHistories: {
      conv_rep: [{ direction: "outbound", body: "hey it's Max, call me back", dateAdded: ago(60 * 24 * 90), userId: "user_max" }],
      conv_noted: [{ direction: "outbound", body: "cold open", dateAdded: ago(60 * 25) }],
      conv_fu1_due: [{ direction: "outbound", body: "cold open", dateAdded: ago(60 * 25) }],
      conv_fu1_not_due: [{ direction: "outbound", body: "cold open", dateAdded: ago(60 * 2) }],
      conv_fu2_due: [
        { direction: "outbound", body: "follow-up 1", dateAdded: ago(60 * 73) },
        { direction: "outbound", body: "cold open", dateAdded: ago(60 * 100) },
      ],
      conv_lead_replied: [
        { direction: "inbound", body: "what sizes do you have?", dateAdded: ago(60 * 26) },
        { direction: "outbound", body: "cold open", dateAdded: ago(60 * 27) },
      ],
      conv_never_delivered: [{ direction: "outbound", body: "cold open", dateAdded: ago(60 * 25), status: "failed" }],
    },
  });
  claude = await startMockClaudeServer();

  process.env.GHL_API_BASE_URL = ghl.url;
  process.env.GHL_LOCATION_ID = "test-location";
  process.env.GHL_API_TOKEN = "test-token";
  process.env.ANTHROPIC_BASE_URL = claude.url;
  process.env.ANTHROPIC_API_KEY = "fake-key-for-tests";
  process.env.KILLSWITCH_URL = (await startFlagServer()).url;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_KEY;

  ({ processEntry, run } = (await import("./sendRollOffTexts.js")) as any);
  ({ addNote } = await import("../lib/ghl.js"));
});

after(async () => {
  setFunnelBackendForTests(null);
  await ghl.close();
  await claude.close();
});

beforeEach(() => {
  process.env.DRY_RUN = "false";
  funnel = memoryFunnelBackend();
  setFunnelBackendForTests(funnel);
  ghl.sentMessages.length = 0;
  ghl.taggedContacts.length = 0;
  ghl.removedTags.length = 0;
  ghl.notes.length = 0;
  claude.requests.length = 0;
  claude.draft = "hey still need that dumpster? you can finish it here [[BOOKING_LINK]]";
});

/** Live options: consent confirmed, MTS says no contracts. */
const live = (extra: Record<string, any> = {}) => ({ now: NOW, consentConfirmed: true, findContracts: async () => [] as MtsContractRow[], ...extra });

const tagsOf = (contactId: string) => ghl.taggedContacts.filter((t) => t.contactId === contactId).map((t) => t.tag);
const sentTo = (contactId: string) => ghl.sentMessages.filter((m) => m.contactId === contactId).map((m) => m.message);

test("a lead who left the form 30+ minutes ago gets the fixed cold open, tagged and recorded", async () => {
  assert.equal(await processEntry({ contactId: "fresh" }, live()), "sent");
  assert.deepEqual(sentTo("fresh"), [
    "Hey Jane, this is Max with the AI team at Mountain High Disposal😃. it looks like you started booking a roll-off dumpster with us but didn't get to finish. do you still need one?",
  ]);
  assert.ok(tagsOf("fresh").includes("ai-rolloff-outreach-sent"));
  assert.ok(ghl.notes.some((n) => n.contactId === "fresh" && n.body.startsWith(AI_ROLLOFF_COLD_OPEN_NOTE_MARKER)));
  assert.ok(tagsOf("fresh").includes("ai-rolloff-processing"), "claims the contact before sending");
  assert.ok(ghl.removedTags.some((t) => t.contactId === "fresh" && t.tag === "ai-rolloff-processing"), "and always releases it");
  assert.equal(claude.requests.length, 0, "the cold open is code-owned text, no model call");
});

test("the first text that goes out counts the lead as reached on the dashboard, once", async () => {
  assert.equal(await processEntry({ contactId: "fresh" }, live()), "sent");
  assert.equal(await processEntry({ contactId: "fu1_due" }, live()), "sent");
  assert.deepEqual([...funnel.files.keys()].sort(), ["funnel/reached/fresh.json", "funnel/reached/fu1_due.json"]);
  // A later text to someone already counted changes nothing.
  const first = funnel.files.get("funnel/reached/fu1_due.json")!;
  assert.equal(await processEntry({ contactId: "fu2_due" }, live()), "sent");
  assert.equal(funnel.files.get("funnel/reached/fu1_due.json"), first);
});

test("nothing is counted as reached when nothing went out", async () => {
  assert.equal(await processEntry({ contactId: "too_new" }, live()), "skipped");
  assert.equal(await processEntry({ contactId: "fresh" }, { now: NOW }), "retry");
  assert.equal(await processEntry({ contactId: "fresh" }, live({ findContracts: async () => [{ custNumber: "42", name: "Jane Doe", medium: "Website", status: "Active", saleDate: "10/10/2026" }] })), "skipped");
  assert.equal(funnel.files.size, 0);
});

test("a name that isn't a name never reaches the text", async () => {
  assert.equal(await processEntry({ contactId: "bad_name" }, live()), "sent");
  assert.match(sentTo("bad_name")[0]!, /^Hey there, this is Max/);
});

test("no cold open while the lead may still be on the form", async () => {
  assert.equal(await processEntry({ contactId: "too_new" }, live()), "skipped");
  assert.equal(ghl.sentMessages.length, 0);
});

test("nothing goes out overnight — held for the next run in business hours", async () => {
  assert.equal(await processEntry({ contactId: "fresh" }, live({ now: NIGHT })), "retry");
  assert.equal(ghl.sentMessages.length, 0);
});

test("until the CEO OKs texting roll-off leads, nothing sends and nothing is written", async () => {
  assert.equal(await processEntry({ contactId: "fresh" }, { now: NOW }), "retry");
  assert.equal(ghl.sentMessages.length, 0);
  assert.equal(ghl.taggedContacts.length, 0);
  assert.equal(ghl.notes.length, 0);
});

test("DRY_RUN never sends and never writes to GHL", async () => {
  process.env.DRY_RUN = "true";
  assert.equal(await processEntry({ contactId: "fresh" }, live()), "retry");
  assert.equal(await processEntry({ contactId: "rep_texted" }, live()), "skipped");
  assert.equal(ghl.sentMessages.length, 0);
  assert.equal(ghl.taggedContacts.length, 0);
  assert.equal(ghl.notes.length, 0);
  assert.equal(funnel.files.size, 0, "and counts nothing on the dashboard");
});

test("DND, no phone, Loveland, out-of-state, and already flagged/opted-out/booked/finished leads are never texted", async () => {
  for (const contactId of ["dnd", "no_phone", "loveland", "new_mexico", "needs_human", "opted_out", "booked", "exhausted"]) {
    assert.equal(await processEntry({ contactId }, live()), "skipped", contactId);
  }
  assert.equal(ghl.sentMessages.length, 0);
});

test("a contact not tagged for roll-off is never touched, even when named directly", async () => {
  assert.equal(await processEntry({ contactId: "residential_only" }, live()), "skipped");
  assert.equal(ghl.sentMessages.length, 0);
});

test("if a rep has ever texted them, the bot stays out and hands the started booking to the office", async () => {
  assert.equal(await processEntry({ contactId: "rep_texted" }, live()), "skipped");
  assert.equal(ghl.sentMessages.length, 0);
  assert.ok(tagsOf("rep_texted").includes("ai-needs-human"));
  assert.ok(ghl.notes.some((n) => n.contactId === "rep_texted" && /roll-off/.test(n.body)));
});

test("MTS shows a booking made since they started: no text, tagged booked", async () => {
  const findContracts = async () => [{ custNumber: "42", name: "Jane Doe", medium: "Website", status: "Active", saleDate: "10/10/2026" }];
  assert.equal(await processEntry({ contactId: "fresh" }, live({ findContracts })), "skipped");
  assert.equal(ghl.sentMessages.length, 0);
  assert.ok(tagsOf("fresh").includes("ai-rolloff-booked"));
  assert.ok(ghl.notes.some((n) => n.contactId === "fresh" && /Cust #42/.test(n.body)));
  assert.ok(ghl.removedTags.some((t) => t.contactId === "fresh" && t.tag === "ai-rolloff-processing"));
});

test("an old contract (e.g. their existing trash service) doesn't stop the roll-off text", async () => {
  const findContracts = async () => [{ custNumber: "7", name: "Jane Doe", medium: "Phone", status: "Active", saleDate: "4/2/2024" }];
  assert.equal(await processEntry({ contactId: "fresh" }, live({ findContracts })), "sent");
});

test("next-day follow-up: model-drafted, with the real booking link swapped in, tagged", async () => {
  assert.equal(await processEntry({ contactId: "fu1_due" }, live()), "sent");
  assert.deepEqual(sentTo("fu1_due"), [`hey still need that dumpster? you can finish it here ${BOOKING_URL}`]);
  assert.ok(tagsOf("fu1_due").includes("ai-rolloff-followup-1-sent"));
  const request = claude.requests[0]!;
  assert.match(request.system, /hasn't answered our last text in about a day/);
  assert.ok(!request.system.includes("Jane"), "the lead's name goes in the user turn, never the system prompt");
});

test("the cold-open note stands in for a lost sent tag, so the cold open is never sent twice", async () => {
  await addNote("noted_not_tagged", `${AI_ROLLOFF_COLD_OPEN_NOTE_MARKER} {}`);
  assert.equal(await processEntry({ contactId: "noted_not_tagged" }, live()), "sent");
  assert.ok(tagsOf("noted_not_tagged").includes("ai-rolloff-outreach-sent"), "tag restored from the note");
  assert.ok(tagsOf("noted_not_tagged").includes("ai-rolloff-followup-1-sent"), "and it's follow-up 1 that went out");
});

test("follow-ups wait their turn: not before 24h, and never while the lead's text is unanswered", async () => {
  assert.equal(await processEntry({ contactId: "fu1_not_due" }, live()), "skipped");
  assert.equal(await processEntry({ contactId: "lead_replied" }, live()), "skipped");
  assert.equal(ghl.sentMessages.length, 0);
});

test("final follow-up three days after the first, tagged so nothing follows it", async () => {
  claude.draft = "no worries if you're all set, I'm around if you still need one :)";
  assert.equal(await processEntry({ contactId: "fu2_due" }, live()), "sent");
  assert.ok(tagsOf("fu2_due").includes("ai-rolloff-followup-2-sent"));
  assert.match(claude.requests[0]!.system, /LAST automated text/);
});

test("if nothing we sent ever delivered, the real first text goes out instead of a 'checking back' nudge", async () => {
  assert.equal(await processEntry({ contactId: "never_delivered" }, live()), "sent");
  assert.match(sentTo("never_delivered")[0]!, /it looks like you started booking a roll-off dumpster/);
  assert.equal(claude.requests.length, 0);
});

test("a follow-up draft asking for any other template is refused before anything is sent", async () => {
  claude.draft = "[[SIGNUP_SUMMARY]]";
  await assert.rejects(processEntry({ contactId: "fu1_due" }, live()), /template we don't send here/);
  assert.equal(ghl.sentMessages.length, 0);
});

test("a run where a contact errors exits non-zero and records the failure, so GitHub flags the job", async () => {
  const { memoryStatusBackend, setStatusBackendForTests } = await import("../lib/runStatus.js");
  const beats = memoryStatusBackend();
  setStatusBackendForTests(beats);
  process.env.DRY_RUN = "true";
  const previous = process.exitCode;
  try {
    await run("no_such_contact");
    assert.equal(process.exitCode, 1);
    assert.equal(beats.beats.get("rolloff-send")!.ok, false);
    assert.match(beats.beats.get("rolloff-send")!.detail, /errored 1/);
  } finally {
    process.exitCode = previous;
    setStatusBackendForTests(null);
  }
});

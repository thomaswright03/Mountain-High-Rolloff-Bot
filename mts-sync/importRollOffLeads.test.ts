import { startFlagServer } from "../lib/testHelpers/flagServer.js";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startMockGhlServer, type MockGhlServer } from "../lib/testHelpers/mockGhlServer.js";
import { AI_ROLLOFF_LEAD_NOTE_MARKER, type RollOffLead } from "../lib/rollOffIntake.js";

let ghl: MockGhlServer;
let fixtureContacts: Record<string, any>;
let importLead: typeof import("./importRollOffLeads.js").importLead;
let importLeads: typeof import("./importRollOffLeads.js").importLeads;

const lead = (extra: Partial<RollOffLead> = {}): RollOffLead => ({
  mtsId: "501",
  date: "2026-10-10",
  firstName: "Jane",
  lastName: "Doe",
  phone: "+17205550101",
  email: "jane@example.com",
  address1: "3415 S Jasper Court",
  city: "Aurora",
  state: "CO",
  postalCode: "80013",
  ...extra,
});

before(async () => {
  ghl = await startMockGhlServer({
    contacts: fixtureContacts = {
      // Already in GHL, e.g. an existing trash customer.
      existing: { phone: "+19705550111", tags: ["2025 serviced"] },
      already_rolloff: { phone: "+19705550122", tags: ["ai-rolloff-eligible", "ai-rolloff-outreach-sent"] },
      residential: { phone: "+19705550133", tags: ["ai-outreach-eligible"] },
      residential_noted: { phone: "+19705550144", tags: ["ai-outreach-eligible", "ai-rolloff-skipped-residential"] },
      // A paying residential customer whose record must stay as it is.
      residential_customer: { phone: "+19705550155", firstName: "Pat", lastName: "Gray", email: "pat@example.com", address1: "9 Pine Rd", city: "Greeley", state: "CO", postalCode: "80631", tags: ["ai-outreach-eligible"] },
      // Went through the whole drip weeks ago.
      returning: { phone: "+19705550166", tags: ["ai-rolloff-eligible", "ai-rolloff-outreach-sent", "ai-rolloff-followup-1-sent", "ai-rolloff-followup-2-sent"] },
      returning_opted_out: { phone: "+19705550177", tags: ["ai-rolloff-eligible", "ai-rolloff-followup-2-sent", "ai-opted-out"] },
      partial: { phone: "+19705550188", firstName: "Kim", lastName: "", address1: "", city: "", tags: [] },
    },
    conversationHistories: {},
  });
  process.env.GHL_API_BASE_URL = ghl.url;
  process.env.GHL_API_TOKEN = "fake-token-for-tests";
  process.env.GHL_LOCATION_ID = "loc_test";
  process.env.GHL_COMPANY_FIELD_KEY = "field_company";
  process.env.KILLSWITCH_URL = (await startFlagServer()).url;
  ({ importLead, importLeads } = await import("./importRollOffLeads.js"));
});

after(async () => {
  await ghl.close();
});

beforeEach(() => {
  ghl.removedTags.length = 0;
  ghl.upserts.length = 0;
  ghl.taggedContacts.length = 0;
  ghl.notes.length = 0;
});

test("DRY_RUN (test mode) writes nothing to GHL", async () => {
  assert.equal(await importLead(lead(), { dryRun: true }), "dry_run");
  assert.equal(ghl.upserts.length, 0);
  assert.equal(ghl.taggedContacts.length, 0);
  assert.equal(ghl.notes.length, 0);
});

test("a new lead is created with the brand set, noted, and tagged for the roll-off flow", async () => {
  assert.equal(await importLead(lead(), { dryRun: false, now: new Date("2026-10-10T16:00:00Z") }), "imported");
  const upsert = ghl.upserts[0]!;
  assert.equal(upsert.phone, "+17205550101");
  assert.equal(upsert.city, "Aurora");
  assert.deepEqual(upsert.customFields, [{ id: "field_company", value: "Mountain High Disposal" }]);
  assert.equal("tags" in upsert, false, "never sends tags on upsert, which would replace existing ones");
  const id = ghl.taggedContacts[0]!.contactId;
  assert.deepEqual(ghl.taggedContacts, [{ contactId: id, tag: "ai-rolloff-eligible" }]);
  assert.ok(ghl.notes[0]!.body.startsWith(AI_ROLLOFF_LEAD_NOTE_MARKER));
  assert.match(ghl.notes[0]!.body, /MTS roll-off lead 501/);
});

test("an existing contact keeps its tags and is added to the roll-off flow", async () => {
  assert.equal(await importLead(lead({ phone: "+19705550111" }), { dryRun: false }), "imported");
  assert.deepEqual(ghl.taggedContacts, [{ contactId: "existing", tag: "ai-rolloff-eligible" }]);
});

test("someone already in the roll-off flow isn't picked up again", async () => {
  assert.equal(await importLead(lead({ phone: "+19705550122" }), { dryRun: false }), "already_tagged");
  assert.equal(ghl.taggedContacts.length, 0);
  assert.equal(ghl.notes.length, 0);
});

test("a residential lead isn't added to the roll-off flow; the office gets one note", async () => {
  assert.equal(await importLead(lead({ phone: "+19705550133" }), { dryRun: false }), "residential_lead");
  assert.deepEqual(ghl.taggedContacts, [{ contactId: "residential", tag: "ai-rolloff-skipped-residential" }]);
  assert.equal(ghl.notes.length, 1);
  assert.match(ghl.notes[0]!.body, /already a residential lead/);

});

test("a residential lead the office was already told about gets nothing more", async () => {
  assert.equal(await importLead(lead({ phone: "+19705550144" }), { dryRun: false }), "residential_lead");
  assert.equal(ghl.taggedContacts.length, 0);
  assert.equal(ghl.notes.length, 0);
});

const OLD = "2026-09-01T16:00:00.000Z";
const pickedUp = (contactId: string, mtsId: string, dateAdded: string) =>
  ghl.notes.push({ contactId, dateAdded, body: `${AI_ROLLOFF_LEAD_NOTE_MARKER} started a roll-off booking online (MTS roll-off lead ${mtsId}, dated 2026-09-01). Picked up ${dateAdded}.` });

test("a residential customer's name, address and email are never overwritten: one note and the skipped tag only", async () => {
  assert.equal(await importLead(lead({ phone: "+19705550155" }), { dryRun: false }), "residential_lead");
  assert.equal(ghl.upserts.length, 0, "no contact write at all");
  assert.deepEqual(ghl.taggedContacts, [{ contactId: "residential_customer", tag: "ai-rolloff-skipped-residential" }]);
  assert.match(ghl.notes[0]!.body, /3415 S Jasper Court/, "the office sees the roll-off address in the note");
});

test("a contact already in the roll-off flow gets zero writes on a second run", async () => {
  pickedUp("already_rolloff", "501", new Date().toISOString());
  ghl.notes.length = 0;
  pickedUp("already_rolloff", "501", new Date().toISOString());
  const before = ghl.notes.length;
  assert.equal(await importLead(lead({ phone: "+19705550122" }), { dryRun: false }), "already_tagged");
  assert.equal(ghl.upserts.length, 0);
  assert.equal(ghl.taggedContacts.length, 0);
  assert.equal(ghl.removedTags.length, 0);
  assert.equal(ghl.notes.length, before);
});

test("an existing contact only has its empty fields filled in", async () => {
  assert.equal(await importLead(lead({ phone: "+19705550188" }), { dryRun: false }), "imported");
  const upsert = ghl.upserts[0]!;
  assert.equal(upsert.firstName, undefined, "a name already on file is kept");
  assert.equal(upsert.lastName, "Doe");
  assert.equal(upsert.address1, "3415 S Jasper Court");
  assert.deepEqual(upsert.customFields, [{ id: "field_company", value: "Mountain High Disposal" }]);
});

test("a returning lead 30+ days after the last pick-up starts a fresh sequence", async () => {
  pickedUp("returning", "400", OLD);
  const now = new Date("2026-11-04T16:00:00Z");
  assert.equal(await importLead(lead({ phone: "+19705550166", mtsId: "777" }), { dryRun: false, now }), "restarted");
  assert.equal(ghl.upserts.length, 0, "their record is left as it is");
  assert.deepEqual(ghl.removedTags.map((t) => t.tag).sort(), ["ai-rolloff-followup-1-sent", "ai-rolloff-followup-2-sent", "ai-rolloff-outreach-sent"]);
  assert.ok(ghl.notes.some((n) => n.contactId === "returning" && /lead 777,.*start over/.test(n.body)));
});

test("the same MTS lead, or one inside 30 days, never restarts the texts", async () => {
  pickedUp("returning", "777", OLD);
  assert.equal(await importLead(lead({ phone: "+19705550166", mtsId: "777" }), { dryRun: false, now: new Date("2026-11-04T16:00:00Z") }), "already_tagged");
  ghl.notes.length = 0;
  pickedUp("returning", "400", "2026-10-20T16:00:00.000Z");
  assert.equal(await importLead(lead({ phone: "+19705550166", mtsId: "778" }), { dryRun: false, now: new Date("2026-11-04T16:00:00Z") }), "already_tagged");
  assert.equal(ghl.removedTags.length, 0);
});

test("an opted-out returning lead is never texted again", async () => {
  pickedUp("returning_opted_out", "400", OLD);
  assert.equal(await importLead(lead({ phone: "+19705550177", mtsId: "779" }), { dryRun: false, now: new Date("2026-11-04T16:00:00Z") }), "already_tagged");
  assert.equal(ghl.removedTags.length, 0);
  assert.equal(ghl.taggedContacts.length, 0);
});

test("the per-run cap counts new pick-ups only: 30 leads, 20 already in the flow, all 10 new ones are picked up", async () => {
  const leads: RollOffLead[] = [];
  for (let i = 0; i < 30; i++) {
    const phone = `+1303555${String(1000 + i)}`;
    if (i < 20) {
      fixtureContacts[`cap_${i}`] = { phone, tags: ["ai-rolloff-eligible"] };
      pickedUp(`cap_${i}`, String(900 + i), new Date().toISOString());
    }
    leads.push(lead({ mtsId: String(900 + i), phone }));
  }
  // The 20 already-tagged leads come first, as the oldest rows would.
  const result = await importLeads(leads, { dryRun: false, now: new Date(), cap: 10 });
  assert.deepEqual(result, { imported: 10, errored: 0 });
  assert.equal(ghl.taggedContacts.filter((t) => t.tag === "ai-rolloff-eligible").length, 10);
});

import { startFlagServer } from "../lib/testHelpers/flagServer.js";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startMockGhlServer, type MockGhlServer } from "../lib/testHelpers/mockGhlServer.js";
import { AI_ROLLOFF_LEAD_NOTE_MARKER, type RollOffLead } from "../lib/rollOffIntake.js";

let ghl: MockGhlServer;
let importLead: typeof import("./importRollOffLeads.js").importLead;

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
    contacts: {
      // Already in GHL, e.g. an existing trash customer.
      existing: { phone: "+19705550111", tags: ["2025 serviced"] },
      already_rolloff: { phone: "+19705550122", tags: ["ai-rolloff-eligible", "ai-rolloff-outreach-sent"] },
      residential: { phone: "+19705550133", tags: ["ai-outreach-eligible"] },
      residential_noted: { phone: "+19705550144", tags: ["ai-outreach-eligible", "ai-rolloff-skipped-residential"] },
    },
    conversationHistories: {},
  });
  process.env.GHL_API_BASE_URL = ghl.url;
  process.env.GHL_API_TOKEN = "fake-token-for-tests";
  process.env.GHL_LOCATION_ID = "loc_test";
  process.env.GHL_COMPANY_FIELD_KEY = "field_company";
  process.env.KILLSWITCH_URL = (await startFlagServer()).url;
  ({ importLead } = await import("./importRollOffLeads.js"));
});

after(async () => {
  await ghl.close();
});

beforeEach(() => {
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

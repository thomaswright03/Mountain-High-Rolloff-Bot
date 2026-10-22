import { test } from "node:test";
import assert from "node:assert/strict";
import { decideRow, selectRollOffLeads, leadLandedAt, normalizePhone, parseAddress, AI_ROLLOFF_LEAD_NOTE_MARKER, type MtsRollOffRow } from "./rollOffIntake.js";
import { findCompany } from "./companies.js";

const company = findCompany("Mountain High Disposal")!;
const NOW = new Date("2026-10-10T16:00:00Z"); // 10am Denver, Oct 10

// Shaped like the rows in Thomas's screenshot of the MTS page (2026-10-10).
const row = (extra: Partial<MtsRollOffRow> = {}): MtsRollOffRow => ({
  id: "501",
  date: "10/9/2026",
  company: "Mountain High Disposal",
  name: "Jane Q Doe",
  phone: "7205550101",
  email: "jane@example.com",
  address: "3415 S Jasper Court, Aurora, CO 80013",
  serviceable: "Yes",
  status: "New",
  ...extra,
});

test("a fresh, serviceable Mountain High lead is picked up with its parts split out", () => {
  const decision = decideRow(row(), company, NOW);
  assert.deepEqual(decision, {
    lead: {
      mtsId: "501",
      date: "2026-10-09",
      firstName: "Jane",
      lastName: "Q Doe",
      phone: "+17205550101",
      email: "jane@example.com",
      address1: "3415 S Jasper Court",
      city: "Aurora",
      state: "CO",
      postalCode: "80013",
    },
  });
});

test("Follow-Up and Possibly-serviceable leads count too", () => {
  assert.ok("lead" in decideRow(row({ status: "Follow-Up", serviceable: "Possibly" }), company, NOW));
});

test("only today's and yesterday's leads: the old backlog is never picked up", () => {
  assert.ok("lead" in decideRow(row({ date: "10/10/2026" }), company, NOW));
  assert.ok("lead" in decideRow(row({ date: "10/9/2026" }), company, NOW));
  assert.deepEqual(decideRow(row({ date: "10/8/2026" }), company, NOW), { skip: "older than yesterday" });
  assert.deepEqual(decideRow(row({ date: "3/1/2025" }), company, NOW), { skip: "older than yesterday" });
});

test("'yesterday' is the brand's calendar: 1am UTC on the 10th is still the 9th in Denver", () => {
  const earlyUtc = new Date("2026-10-10T01:00:00Z");
  assert.ok("lead" in decideRow(row({ date: "10/8/2026" }), company, earlyUtc));
});

test("Loveland, out of state, other brands, closed statuses and unserviceable leads are skipped", () => {
  const skipped = (extra: Partial<MtsRollOffRow>) => "skip" in decideRow(row(extra), company, NOW);
  assert.ok(skipped({ address: "4324 Page Place, Loveland, CO 80537" }));
  assert.ok(skipped({ address: "12 Main St, Cheyenne, WY 82001" }));
  assert.ok(skipped({ company: "Eastern Waste & Recycling" }));
  assert.ok(skipped({ status: "Sold" }));
  assert.ok(skipped({ status: "Not Interested" }));
  assert.ok(skipped({ serviceable: "No" }));
});

test("no usable phone or an unreadable address or date is skipped, never guessed", () => {
  assert.ok("skip" in decideRow(row({ phone: "555" }), company, NOW));
  assert.ok("skip" in decideRow(row({ address: "somewhere in Aurora" }), company, NOW));
  assert.ok("skip" in decideRow(row({ date: "yesterday" }), company, NOW));
});

test("a row without an MTS id is still picked up", () => {
  const decision = decideRow(row({ id: undefined }), company, NOW);
  assert.ok("lead" in decision && decision.lead.mtsId === "unknown");
});

test("someone who tried twice is picked up once, from their newest row", () => {
  const { leads, skipped } = selectRollOffLeads(
    [row({ id: "1", date: "10/9/2026" }), row({ id: "2", date: "10/10/2026" }), row({ id: "3", phone: "9705550199" })],
    company,
    NOW
  );
  assert.deepEqual(leads.map((l) => l.mtsId), ["2", "3"]);
  assert.deepEqual(skipped, [{ id: "1", reason: "same phone as a newer lead on this page" }]);
});

test("normalizePhone and parseAddress", () => {
  assert.equal(normalizePhone("(970) 412-0282"), "+19704120282");
  assert.equal(normalizePhone("1-970-412-0282"), "+19704120282");
  assert.equal(normalizePhone("412-0282"), null);
  assert.deepEqual(parseAddress("8721 19th Street Road, Greeley, CO 80634"), { address1: "8721 19th Street Road", city: "Greeley", state: "CO", postalCode: "80634" });
  assert.equal(parseAddress("no commas here"), null);
  assert.deepEqual(parseAddress("5036 S Ventura St, Aurora|co|120, CO 80015-2036"), { address1: "5036 S Ventura St", city: "Aurora", state: "CO", postalCode: "80015" });
});

test("a Loveland address with MTS's pipe junk is still skipped", () => {
  assert.deepEqual(decideRow(row({ address: "12 Main St, Loveland|co|069, CO 80537" }), company, NOW), {
    skip: "outside where Mountain High Disposal takes new customers (Loveland, CO)",
  });
});

test("leadLandedAt: the newest pick-up note wins over an old contact's dateAdded", () => {
  const notes = [
    { body: `${AI_ROLLOFF_LEAD_NOTE_MARKER} first try`, dateAdded: "2026-03-01T12:00:00Z" },
    { body: "something else", dateAdded: "2026-10-10T15:59:00Z" },
    { body: `${AI_ROLLOFF_LEAD_NOTE_MARKER} second try`, dateAdded: "2026-10-10T15:30:00Z" },
  ];
  assert.equal(leadLandedAt("2025-01-01T00:00:00Z", notes), "2026-10-10T15:30:00Z");
  assert.equal(leadLandedAt("2025-01-01T00:00:00Z", []), "2025-01-01T00:00:00Z");
});

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import { readRollOffLeadRows } from "./importRollOffLeads.js";
import { selectRollOffLeads } from "../lib/rollOffIntake.js";
import { findCompany } from "../lib/companies.js";

// fixtures/rolloff-leads.html is the real Manage Roll-Off Leads page, saved
// by Thomas on 2026-10-22, with every lead's name, phone, email, street and
// MTS id swapped for fakes. If MTS changes the page, save it again and
// update the expectations here.
const FIXTURE = readFileSync(new URL("./fixtures/rolloff-leads.html", import.meta.url), "utf8");

let browser: Browser;

before(async () => {
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser.close();
});

/** Reads the fixture the way the import job reads the live page. Nothing
 * leaves the browser: the list URL gets the fixture, everything else is
 * blocked. */
async function readFixture() {
  const page = await browser.newPage();
  await page.route("**/*", (route) =>
    route.request().resourceType() === "document" && route.request().url().includes("/rolloffleads/list")
      ? route.fulfill({ contentType: "text/html", body: FIXTURE })
      : route.abort()
  );
  try {
    return await readRollOffLeadRows(page);
  } finally {
    await page.close();
  }
}

test("the real MTS page: every row is read by its column headers, with its lead id", async () => {
  const rows = await readFixture();
  assert.equal(rows.length, 25);
  assert.deepEqual(rows[0], {
    id: "FAKEID01",
    date: "10/21/2026",
    company: "Mountain High Disposal",
    name: "Lead1 Tester",
    phone: "9705550001",
    email: "lead1@example.com",
    address: "100 Test Street, Aurora, CO 80012",
    serviceable: "Yes",
    status: "New",
  });
  assert.deepEqual(
    rows.map((r) => r.id),
    rows.map((_, i) => `FAKEID${String(i + 1).padStart(2, "0")}`)
  );
});

test("the real MTS page: only the last two days' leads are picked up, with clean cities", async () => {
  const rows = await readFixture();
  // The morning after the page was saved, 2am Denver.
  const { leads, skipped } = selectRollOffLeads(rows, findCompany("Mountain High Disposal")!, new Date("2026-10-22T08:00:00Z"));
  assert.deepEqual(
    leads.map((l) => [l.mtsId, l.date, l.phone, l.city, l.state, l.postalCode]),
    [
      ["FAKEID01", "2026-10-21", "+19705550001", "Aurora", "CO", "80012"],
      ["FAKEID02", "2026-10-21", "+19705550002", "Aurora", "CO", "80015"],
      ["FAKEID03", "2026-10-21", "+19705550003", "Greeley", "CO", "80634"],
      ["FAKEID04", "2026-10-21", "+19705550004", "Aurora", "CO", "80017"],
      ["FAKEID05", "2026-10-21", "+19705550005", "Aurora", "CO", "80012"],
    ]
  );
  assert.equal(skipped.length, 20);
  assert.ok(skipped.every((s) => s.reason === "older than yesterday"));
});

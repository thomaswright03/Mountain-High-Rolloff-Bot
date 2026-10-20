// Picks up new roll-off leads from MTS's Manage Roll-Off Leads page
// (/rolloffleads/list) and tags them ai-rolloff-eligible in GHL, so
// sendRollOffTexts.ts can text them. Runs right before it in
// .github/workflows/send-rolloff-texts.yml. Which rows qualify is decided in
// lib/rollOffIntake.ts.
//
// Under DRY_RUN this only reads MTS and logs what it would pick up. It
// never writes to GHL. Reading the page is the only thing it does in MTS.
//
// The page layout is from Thomas's screenshot (2026-10-10), not from the
// live HTML, so the table is read by its column headers rather than by
// position. A run that finds no table, or none of the expected columns,
// fails loudly instead of silently picking up nothing.
import { chromium, type Page } from "playwright";
import { findCompany } from "../lib/companies.js";
import { selectRollOffLeads, AI_ROLLOFF_LEAD_NOTE_MARKER, type MtsRollOffRow, type RollOffLead } from "../lib/rollOffIntake.js";
import { ROLLOFF_ELIGIBLE_TAG } from "../lib/rollOff.js";
import { getContact, upsertContact, addTag, addNote } from "../lib/ghl.js";
import { isServiceActive } from "../lib/killswitch.js";
import { logEvent } from "../lib/logging.js";
import { recordHeartbeat } from "../lib/runStatus.js";
import { loginToMts } from "./mtsLogin.js";

const TARGET_COMPANY = "Mountain High Disposal";
const LIST_URL = "https://kaizen.maxtrackingsolutions.com/rolloffleads/list";
/** Blast-radius limit per run, same idea as the sender's cap. */
const IMPORT_CAP = 25;

const HEADER_KEYS: Record<string, keyof MtsRollOffRow> = {
  date: "date",
  company: "company",
  name: "name",
  "phone number": "phone",
  email: "email",
  address: "address",
  serviceable: "serviceable",
  status: "status",
};

type RawTable = { headers: string[]; rows: Array<{ cells: string[]; hrefs: string[] }> } | null;

/** The leads table's header and row text. Retried if the page is still
 * reloading when it's read. */
async function readTable(page: Page, attempts = 3): Promise<RawTable> {
  try {
    // No named helpers inside evaluate: tsx (esbuild keepNames) wraps them
    // in a __name() call that doesn't exist in the browser.
    return await page.evaluate(() => {
      const table = Array.from(document.querySelectorAll("table")).find((t) => /phone\s*number/i.test(t.innerText));
      if (!table) return null;
      const headerCells = Array.from(table.querySelectorAll("thead th, tr:first-child th"));
      const headers = headerCells.map((th) => (th.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase());
      const bodyRows = Array.from(table.querySelectorAll("tbody tr")).filter((tr) => tr.querySelectorAll("td").length >= headers.length - 1);
      return {
        headers,
        rows: bodyRows.map((tr) => ({
          cells: Array.from(tr.querySelectorAll("td")).map((td) => (td.textContent ?? "").replace(/\s+/g, " ").trim()),
          hrefs: Array.from(tr.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? ""),
        })),
      };
    });
  } catch (err: any) {
    if (attempts <= 1 || !/Execution context was destroyed|navigation/i.test(err.message)) throw err;
    await page.waitForLoadState("networkidle");
    return readTable(page, attempts - 1);
  }
}

/** Reads every row of the leads table on the current page, by header. */
export async function readRollOffLeadRows(page: Page): Promise<MtsRollOffRow[]> {
  await page.goto(LIST_URL, { waitUntil: "networkidle" });

  // Show as many rows per page as the page offers, so a busy day isn't cut
  // off at 25. Best-effort: if there's no such dropdown, the first page is
  // still read. On the real page, changing it reloads the page (first test
  // run, 2026-10-10), so the reload is waited for before the table is read.
  const reloaded = page.waitForEvent("framenavigated", { predicate: (f) => f === page.mainFrame(), timeout: 5_000 }).catch(() => null);
  const grew = await page.evaluate(() => {
    for (const select of Array.from(document.querySelectorAll("select"))) {
      const sizes = Array.from(select.options).map((o) => Number(o.value)).filter((n) => [25, 50, 100].includes(n));
      if (sizes.length < 2) continue;
      const max = String(Math.max(...sizes));
      if (select.value === max) return false;
      select.value = max;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    return false;
  });
  if (grew) {
    await reloaded;
    await page.waitForLoadState("networkidle");
  }

  const raw = await readTable(page);
  if (!raw) throw new Error("MTS roll-off leads page: no table with a Phone Number column");

  const index: Partial<Record<keyof MtsRollOffRow, number>> = {};
  raw.headers.forEach((h, i) => {
    const key = HEADER_KEYS[h.replace(/[^a-z ]/g, "").trim()];
    if (key) index[key] = i;
  });
  const missing = Object.values(HEADER_KEYS).filter((k) => index[k] === undefined);
  if (missing.length > 0) throw new Error(`MTS roll-off leads page: missing columns ${missing.join(", ")} (saw: ${raw.headers.join(" | ")})`);

  return raw.rows.map(({ cells, hrefs }) => {
    // MTS links each row to its own lead, e.g. /rolloffleads/view/123.
    const idHref = hrefs.find((h) => /\/rolloffleads\/(view|edit|details)\//i.test(h));
    const cell = (k: keyof MtsRollOffRow) => cells[index[k]!] ?? "";
    return {
      id: idHref ? idHref.split("/").filter(Boolean).pop() : undefined,
      date: cell("date"),
      company: cell("company"),
      name: cell("name"),
      phone: cell("phone"),
      email: cell("email"),
      address: cell("address"),
      serviceable: cell("serviceable"),
      status: cell("status"),
    };
  });
}

export type ImportOutcome = "imported" | "already_tagged" | "dry_run";

/** Creates or updates the GHL contact and tags it for the roll-off flow.
 * Someone already tagged is left alone, so a lead seen on every run is
 * only picked up once. */
export async function importLead(lead: RollOffLead, opts: { dryRun: boolean; now?: Date }): Promise<ImportOutcome> {
  const company = findCompany(TARGET_COMPANY)!;
  if (opts.dryRun) {
    logEvent({ event: "rolloff_import_dry_run", mtsId: lead.mtsId, date: lead.date, city: lead.city });
    return "dry_run";
  }

  const contactId = await upsertContact({
    locationId: process.env.GHL_LOCATION_ID,
    firstName: lead.firstName || undefined,
    lastName: lead.lastName || undefined,
    phone: lead.phone,
    email: lead.email || undefined,
    address1: lead.address1,
    city: lead.city,
    state: lead.state,
    postalCode: lead.postalCode,
    customFields: [{ id: process.env.GHL_COMPANY_FIELD_KEY, value: company.matchValue }],
  });

  const contact = await getContact(contactId);
  const tags: string[] = (contact.tags ?? []).map((t: string) => t.toLowerCase());
  if (tags.includes(ROLLOFF_ELIGIBLE_TAG)) {
    logEvent({ event: "rolloff_import_already_tagged", contactId, mtsId: lead.mtsId });
    return "already_tagged";
  }

  await addNote(
    contactId,
    `${AI_ROLLOFF_LEAD_NOTE_MARKER} started a roll-off booking online (MTS roll-off lead ${lead.mtsId}, dated ${lead.date}). Picked up ${(opts.now ?? new Date()).toISOString()}.`
  );
  await addTag(contactId, ROLLOFF_ELIGIBLE_TAG);
  logEvent({ event: "rolloff_import_tagged", contactId, mtsId: lead.mtsId });
  return "imported";
}

export async function run(): Promise<void> {
  if (!(await isServiceActive())) {
    logEvent({ event: "rolloff_import_service_paused" });
    console.log("Paused by the kill switch (or the flag could not be read): nothing picked up.");
    await recordHeartbeat("rolloff-import", true, "paused by the kill switch, nothing picked up");
    return;
  }
  const dryRun = process.env.DRY_RUN === "true";
  const company = findCompany(TARGET_COMPANY)!;
  const now = new Date();

  const browser = await chromium.launch({ headless: true });
  let rows: MtsRollOffRow[];
  try {
    const page = await browser.newPage();
    try {
      await loginToMts(page);
    } catch (err: any) {
      await recordHeartbeat("mts-login", false, String(err?.message ?? err));
      throw err;
    }
    await recordHeartbeat("mts-login", true, "logged in");
    rows = await readRollOffLeadRows(page);
  } finally {
    await browser.close();
  }

  const { leads, skipped } = selectRollOffLeads(rows, company, now);
  console.log(`Read ${rows.length} roll-off lead row(s): ${leads.length} to pick up, ${skipped.length} skipped.`);
  for (const s of skipped) logEvent({ event: "rolloff_import_skip", mtsId: s.id, reason: s.reason });

  let imported = 0;
  let errored = 0;
  for (const lead of leads.slice(0, IMPORT_CAP)) {
    try {
      if ((await importLead(lead, { dryRun, now })) === "imported") imported++;
    } catch (err: any) {
      logEvent({ event: "rolloff_import_error", mtsId: lead.mtsId, error: err.message });
      errored++;
    }
  }
  console.log(`Done. Picked up: ${imported}, errored: ${errored}${dryRun ? " (DRY_RUN: nothing written to GHL)" : ""}`);
  await recordHeartbeat("rolloff-import", errored === 0, `${dryRun ? "test mode: " : ""}read ${rows.length} rows, picked up ${imported}, errored ${errored}`);
  if (errored > 0) process.exitCode = 1;
}

// Only self-invoke when run directly, not when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  const dotenv = await import("dotenv");
  dotenv.default.config({ path: new URL("../.env.local", import.meta.url).pathname });
  run().catch(async (err) => {
    console.error(err);
    await recordHeartbeat("rolloff-import", false, `crashed: ${err?.message ?? err}`);
    process.exit(1);
  });
}

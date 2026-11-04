// Picks up new roll-off leads from MTS's Manage Roll-Off Leads page
// (/rolloffleads/list) and tags them ai-rolloff-eligible in GHL, so
// sendRollOffTexts.ts can text them. Runs right before it in
// .github/workflows/send-rolloff-texts.yml. Which rows qualify is decided in
// lib/rollOffIntake.ts.
//
// Under DRY_RUN this only reads MTS and logs what it would pick up. It
// never writes to GHL. Reading the page is the only thing it does in MTS.
//
// The table is read by its column headers rather than by position.
// readRollOffLeadRows.test.ts checks this against the real page, saved
// 2026-10-22 (fixtures/rolloff-leads.html, with the leads' details faked). A run that finds no table, or none of the expected columns,
// fails loudly instead of silently picking up nothing.
import { chromium, type Page } from "playwright";
import { findCompany } from "../lib/companies.js";
import { selectRollOffLeads, AI_ROLLOFF_LEAD_NOTE_MARKER, type MtsRollOffRow, type RollOffLead } from "../lib/rollOffIntake.js";
import {
  ROLLOFF_ELIGIBLE_TAG,
  ROLLOFF_SKIPPED_RESIDENTIAL_TAG,
  RESIDENTIAL_TAG,
  ROLLOFF_COLD_OPEN_SENT_TAG,
  ROLLOFF_FOLLOWUP_1_TAG,
  ROLLOFF_FOLLOWUP_2_TAG,
  ROLLOFF_BOOKED_TAG,
  NEEDS_HUMAN_TAG,
  OPTED_OUT_TAG,
  TARGET_COMPANY,
} from "../lib/rollOff.js";
import { ROLLOFF_CONFIRMED_TAG } from "../lib/rollOffBooking.js";
import { findContactByPhone, upsertContact, addTag, removeTag, addNote, getNotes, extractCompanyValue } from "../lib/ghl.js";
import { isServiceActive } from "../lib/killswitch.js";
import { logEvent } from "../lib/logging.js";
import { recordHeartbeat } from "../lib/runStatus.js";
import { loginToMts } from "./mtsLogin.js";
import { errorMessage } from "../lib/errors.js";

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
  } catch (err: unknown) {
    if (attempts <= 1 || !/Execution context was destroyed|navigation/i.test(errorMessage(err))) throw err;
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

export type ImportOutcome = "imported" | "already_tagged" | "restarted" | "residential_lead" | "dry_run";

/** A lead who finished the texts this long ago and starts a new booking
 * online gets a fresh sequence (grader, 2026-11-04). */
export const RESTART_AFTER_DAYS = 30;

/** Tags that end the roll-off texts for good, or until a person clears
 * them: a returning lead carrying one is never restarted. */
const NEVER_RESTART_TAGS = [OPTED_OUT_TAG, NEEDS_HUMAN_TAG, ROLLOFF_CONFIRMED_TAG];
/** What the last sequence left behind; cleared when a new one starts. */
const SEQUENCE_TAGS = [ROLLOFF_COLD_OPEN_SENT_TAG, ROLLOFF_FOLLOWUP_1_TAG, ROLLOFF_FOLLOWUP_2_TAG, ROLLOFF_BOOKED_TAG];

const ADDRESS_FIELDS = ["firstName", "lastName", "email", "address1", "city", "state", "postalCode"] as const;

const blank = (v: unknown) => typeof v !== "string" || v.trim() === "";

function pickUpNote(lead: RollOffLead, now: Date, again = false): string {
  return `${AI_ROLLOFF_LEAD_NOTE_MARKER} started a roll-off booking online (MTS roll-off lead ${lead.mtsId}, dated ${lead.date}). Picked up ${now.toISOString()}${again ? ", as a new booking attempt: the roll-off texts start over" : ""}.`;
}

/** Looks the contact up by phone first and only then decides what it may
 * write (grader, 2026-11-04: GHL is shared with the residential bot and the
 * office, so a pick-up must never overwrite what's there):
 * - already in the roll-off flow: nothing is written, unless it's a new
 *   booking attempt RESTART_AFTER_DAYS after the last pick-up, which starts
 *   the texts over;
 * - a residential lead: one note and the skipped tag, nothing else;
 * - an existing contact: only its empty fields are filled in;
 * - nobody: a new contact with everything MTS has. */
export async function importLead(lead: RollOffLead, opts: { dryRun: boolean; now?: Date }): Promise<ImportOutcome> {
  const company = findCompany(TARGET_COMPANY)!;
  const now = opts.now ?? new Date();
  if (opts.dryRun) {
    logEvent({ event: "rolloff_import_dry_run", mtsId: lead.mtsId, date: lead.date, city: lead.city });
    return "dry_run";
  }

  const locationId = process.env.GHL_LOCATION_ID;
  const companyField = { id: process.env.GHL_COMPANY_FIELD_KEY, value: company.matchValue };
  const existing = await findContactByPhone(locationId ?? "", lead.phone);

  if (!existing) {
    const contactId = await upsertContact({
      locationId,
      firstName: lead.firstName || undefined,
      lastName: lead.lastName || undefined,
      phone: lead.phone,
      email: lead.email || undefined,
      address1: lead.address1,
      city: lead.city,
      state: lead.state,
      postalCode: lead.postalCode,
      customFields: [companyField],
    });
    await addNote(contactId, pickUpNote(lead, now));
    await addTag(contactId, ROLLOFF_ELIGIBLE_TAG);
    logEvent({ event: "rolloff_import_tagged", contactId, mtsId: lead.mtsId, created: true });
    return "imported";
  }

  const contactId = String(existing.id);
  const tags: string[] = (existing.tags ?? []).map((t: string) => t.toLowerCase());

  if (tags.includes(ROLLOFF_ELIGIBLE_TAG)) {
    if (tags.some((t) => NEVER_RESTART_TAGS.includes(t)) || existing.dnd === true) {
      logEvent({ event: "rolloff_import_already_tagged", contactId, mtsId: lead.mtsId });
      return "already_tagged";
    }
    const notes = await getNotes(contactId);
    const pickUps = notes.filter((n) => n.body.startsWith(AI_ROLLOFF_LEAD_NOTE_MARKER));
    const lastPickUp = Math.max(...pickUps.map((n) => Date.parse(n.dateAdded)).filter(Number.isFinite), 0);
    const seenThisLead = pickUps.some((n) => n.body.includes(`MTS roll-off lead ${lead.mtsId},`));
    if (pickUps.length === 0 || seenThisLead || now.getTime() - lastPickUp < RESTART_AFTER_DAYS * 86_400_000) {
      logEvent({ event: "rolloff_import_already_tagged", contactId, mtsId: lead.mtsId });
      return "already_tagged";
    }
    // Note first: the sender reads the newest pick-up note as when this
    // attempt started, and ignores a cold-open note older than it.
    await addNote(contactId, pickUpNote(lead, now, true));
    for (const tag of SEQUENCE_TAGS) if (tags.includes(tag)) await removeTag(contactId, tag);
    logEvent({ event: "rolloff_import_restarted", contactId, mtsId: lead.mtsId });
    return "restarted";
  }

  // The residential bot already owns this person (see lib/rollOff.ts), so
  // they're never added here and their record is left as it is. The office
  // gets one note so it knows they also started a roll-off booking.
  if (tags.includes(RESIDENTIAL_TAG)) {
    if (!tags.includes(ROLLOFF_SKIPPED_RESIDENTIAL_TAG)) {
      await addNote(
        contactId,
        `${AI_ROLLOFF_LEAD_NOTE_MARKER} started a roll-off booking online (MTS roll-off lead ${lead.mtsId}, dated ${lead.date}${lead.address1 ? `, for ${lead.address1}, ${lead.city}` : ""}), but is already a residential lead, so the roll-off bot won't text them. Follow up by hand if needed.`
      );
      await addTag(contactId, ROLLOFF_SKIPPED_RESIDENTIAL_TAG);
    }
    logEvent({ event: "rolloff_import_residential_lead", contactId, mtsId: lead.mtsId });
    return "residential_lead";
  }

  // An existing contact (a past customer, say): fill in only what's empty.
  const fill: Record<string, unknown> = {};
  for (const key of ADDRESS_FIELDS) if (blank(existing[key]) && !blank(lead[key])) fill[key] = lead[key];
  if (blank(extractCompanyValue(existing, process.env.GHL_COMPANY_FIELD_KEY ?? "company"))) fill.customFields = [companyField];
  if (Object.keys(fill).length > 0) await upsertContact({ locationId, phone: lead.phone, ...fill });
  await addNote(contactId, pickUpNote(lead, now));
  await addTag(contactId, ROLLOFF_ELIGIBLE_TAG);
  logEvent({ event: "rolloff_import_tagged", contactId, mtsId: lead.mtsId, filled: Object.keys(fill) });
  return "imported";
}

/** Picks up each lead in turn. The cap counts new pick-ups only, so leads
 * already in the flow (re-read on every run for two days) never crowd out
 * new ones. */
export async function importLeads(leads: RollOffLead[], opts: { dryRun: boolean; now: Date; cap?: number }): Promise<{ imported: number; errored: number }> {
  const cap = opts.cap ?? IMPORT_CAP;
  let imported = 0;
  let errored = 0;
  for (const lead of leads) {
    if (imported >= cap) {
      logEvent({ event: "rolloff_import_cap_reached", cap, mtsId: lead.mtsId });
      break;
    }
    try {
      const outcome = await importLead(lead, opts);
      if (outcome === "imported" || outcome === "restarted") imported++;
    } catch (err: unknown) {
      logEvent({ event: "rolloff_import_error", mtsId: lead.mtsId, error: errorMessage(err) });
      errored++;
    }
  }
  return { imported, errored };
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
    } catch (err: unknown) {
      await recordHeartbeat("mts-login", false, String(errorMessage(err) ?? err));
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

  const { imported, errored } = await importLeads(leads, { dryRun, now });
  console.log(`Done. Picked up: ${imported}, errored: ${errored}${dryRun ? " (DRY_RUN: nothing written to GHL)" : ""}`);
  // An empty table is how a changed MTS page would look: surface it instead of quietly picking up nothing.
  const noRows = rows.length === 0;
  await recordHeartbeat(
    "rolloff-import",
    errored === 0,
    `${dryRun ? "test mode: " : ""}read ${rows.length} rows, picked up ${imported}, errored ${errored}${noRows ? ". The leads table had no rows: check the MTS page layout hasn't changed." : ""}`,
    new Date(),
    noRows ? { warning: true } : {}
  );
  if (errored > 0) process.exitCode = 1;
}

// Only self-invoke when run directly, not when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  const dotenv = await import("dotenv");
  dotenv.default.config({ path: new URL("../.env.local", import.meta.url).pathname });
  run().catch(async (err) => {
    console.error(err);
    await recordHeartbeat("rolloff-import", false, `crashed: ${errorMessage(err) ?? err}`);
    process.exit(1);
  });
}

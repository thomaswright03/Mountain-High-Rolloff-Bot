import { isExcludedCity } from "./serviceArea.js";
import { isOutsideServiceStates, parseMtsDate } from "./rollOff.js";
import type { CompanyConfig } from "./types.js";

// Picking up roll-off leads from MTS (Thomas, 2026-10-10: "the roll-off
// leads are stored separately on mts", at /rolloffleads/list). Someone who
// starts the roll-off booking form lands there as a New lead. This file is
// the pure part: which rows become ai-rolloff-eligible contacts in GHL.
// mts-sync/importRollOffLeads.ts reads the page and does the GHL writes.

/** Written on the contact when a roll-off lead is picked up. Its date is
 * when this booking attempt started, which the contact's own dateAdded
 * can't say for someone already in GHL (e.g. an existing trash customer). */
export const AI_ROLLOFF_LEAD_NOTE_MARKER = "AI_ROLLOFF_LEAD_V1:";

/** Only leads from today or yesterday (the brand's calendar) are picked
 * up. The list holds hundreds of old New leads; nobody from that backlog
 * should get a "you didn't finish booking" text out of the blue. */
export const INTAKE_MAX_AGE_DAYS = 1;

const OPEN_STATUSES = ["new", "follow-up"];

/** One row of MTS's Manage Roll-Off Leads table, keyed by its column
 * headers as shown on the page (Thomas's screenshot, 2026-10-10). */
export interface MtsRollOffRow {
  /** MTS's own id for the lead, from the row's view/edit link, when the
   * page has one. Only used in notes and logs. */
  id?: string;
  date: string;
  company: string;
  name: string;
  phone: string;
  email: string;
  /** One cell on the page: "3415 S Jasper Court, Aurora, CO 80013". */
  address: string;
  serviceable: string;
  status: string;
}

export interface RollOffLead {
  mtsId: string;
  /** YYYY-MM-DD */
  date: string;
  firstName: string;
  lastName: string;
  /** E.164, +1 and 10 digits. */
  phone: string;
  email: string;
  address1: string;
  city: string;
  state: string;
  postalCode: string;
}

export function normalizePhone(raw: string | undefined): string | null {
  const digits = String(raw ?? "").replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return ten.length === 10 ? `+1${ten}` : null;
}

export function parseAddress(raw: string): { address1: string; city: string; state: string; postalCode: string } | null {
  const m = raw.replace(/\s+/g, " ").trim().match(/^(.*),\s*([^,]+),\s*([A-Za-z]{2})\s+(\d{5})(?:-\d{4})?$/);
  if (!m) return null;
  return { address1: m[1]!.trim(), city: m[2]!.trim(), state: m[3]!.toUpperCase(), postalCode: m[4]! };
}

function dayInZone(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export type RowDecision = { lead: RollOffLead } | { skip: string };

/** Whether one MTS row should become a roll-off contact. Anything the bot
 * could never text (wrong brand, closed status, too old, unserviceable,
 * Loveland, out of state, no usable phone or address) is skipped here, so
 * it's never tagged in GHL at all. */
export function decideRow(row: MtsRollOffRow, company: CompanyConfig, now: Date): RowDecision {
  if (row.company.trim().toLowerCase() !== company.matchValue.toLowerCase()) return { skip: `company "${row.company}"` };
  if (!OPEN_STATUSES.includes(row.status.trim().toLowerCase().replace(/\s+/g, ""))) return { skip: `status "${row.status}"` };
  if (row.serviceable.trim().toLowerCase().startsWith("n")) return { skip: "marked not serviceable" };

  const date = parseMtsDate(row.date);
  if (!date) return { skip: `unreadable date "${row.date}"` };
  const oldest = dayInZone(new Date(now.getTime() - INTAKE_MAX_AGE_DAYS * 86_400_000), company.timezone);
  if (date < oldest) return { skip: "older than yesterday" };

  const phone = normalizePhone(row.phone);
  if (!phone) return { skip: "no usable phone number" };
  const address = parseAddress(row.address);
  if (!address) return { skip: "address not in street, city, ST zip form" };
  if (isExcludedCity(address.city, company.excludedCities) || isOutsideServiceStates(address.state, company.serviceStates)) {
    return { skip: `outside where ${company.displayName} takes new customers (${address.city}, ${address.state})` };
  }

  const [firstName = "", ...rest] = row.name.trim().split(/\s+/);
  return {
    lead: { mtsId: row.id ?? "unknown", date, firstName, lastName: rest.join(" "), phone, email: row.email.trim(), ...address },
  };
}

/** decideRow over the whole page, newest first, one lead per phone number
 * (someone who tried twice gets one set of texts). */
export function selectRollOffLeads(rows: MtsRollOffRow[], company: CompanyConfig, now: Date): { leads: RollOffLead[]; skipped: Array<{ id?: string; reason: string }> } {
  const leads: RollOffLead[] = [];
  const skipped: Array<{ id?: string; reason: string }> = [];
  const sorted = [...rows].sort((a, b) => (parseMtsDate(b.date) ?? "").localeCompare(parseMtsDate(a.date) ?? ""));
  for (const row of sorted) {
    const decision = decideRow(row, company, now);
    if ("skip" in decision) {
      skipped.push({ id: row.id, reason: decision.skip });
    } else if (leads.some((l) => l.phone === decision.lead.phone)) {
      skipped.push({ id: row.id, reason: "same phone as a newer lead on this page" });
    } else {
      leads.push(decision.lead);
    }
  }
  return { leads, skipped };
}

/** When this roll-off attempt started: the newest pick-up note's time, or
 * the contact's dateAdded for a contact tagged by hand. */
export function leadLandedAt(contactDateAdded: string | undefined, notes: Array<{ body: string; dateAdded: string }>): string | undefined {
  const picked = notes
    .filter((n) => n.body.startsWith(AI_ROLLOFF_LEAD_NOTE_MARKER))
    .map((n) => n.dateAdded)
    .filter((d) => !Number.isNaN(Date.parse(d)))
    .sort();
  return picked[picked.length - 1] ?? contactDateAdded;
}

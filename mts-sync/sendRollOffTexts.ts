// Roll-off dumpster abandoned-cart texts (Thomas, 2026-10-10) — see
// lib/rollOff.ts for the whole flow. For every contact tagged
// ai-rolloff-eligible, sends whichever text is due: the fixed cold open
// (once the lead is COLD_OPEN_DELAY_MINUTES old), a next-day nudge, then one
// final nudge three days later, then nothing unless they reply (replies go
// through api/webhook.ts -> lib/rollOffReply.ts).
//
// Cold open and follow-ups live in one job, unlike Kaizen's residential
// sendOutreach.ts / sendFollowUps.ts split, because both need the same MTS
// check before every real send: finishing the booking online is exactly
// what the first text asks them to do, so someone who did must never get
// "still need that dumpster?" afterwards. One MTS login per run covers both.
// Run via `npm run rolloff:send`, and on a schedule via
// .github/workflows/send-rolloff-texts.yml.
import { chromium } from "playwright";
import { findCompany } from "../lib/companies.js";
import { isExcludedCity } from "../lib/serviceArea.js";
import { formatHistory, AI_ROLLOFF_COLD_OPEN_NOTE_MARKER } from "../lib/prompt.js";
import {
  ROLLOFF_BOOKED_TAG,
  ROLLOFF_TCPA_CONSENT_CONFIRMED,
  ROLLOFF_COLD_OPEN_SENT_TAG,
  ROLLOFF_ELIGIBLE_TAG,
  ROLLOFF_FOLLOWUP_1_TAG,
  ROLLOFF_FOLLOWUP_2_TAG,
  ROLLOFF_PROCESSING_TAG,
  RESIDENTIAL_TAG,
  bookingCheckSince,
  isOutsideServiceStates,
  contractsSince,
  fillBookingLink,
  planRollOffText,
  type MtsContractRow,
  type RollOffStage,
} from "../lib/rollOff.js";
import { buildRollOffColdOpen, buildRollOffFollowUp1Prompt, buildRollOffFollowUp2Prompt } from "../lib/rollOffPrompt.js";
import { draftFollowUp } from "../lib/claude.js";
import { safeFirstName } from "../lib/outboundSafety.js";
import { getContact, findConversationId, getConversationHistory, getNotes, sendSms, addTag, removeTag, addNote, findContactsByTag } from "../lib/ghl.js";
import { isWithinQuietHours } from "../lib/safety.js";
import { isServiceActive } from "../lib/killswitch.js";
import { logEvent } from "../lib/logging.js";
import { recordHeartbeat } from "../lib/runStatus.js";
import { retryPendingNotices } from "../lib/pendingNotices.js";
import { loginToMts } from "./mtsLogin.js";
import { checkMtsContractList } from "./mtsStatusCheck.js";
import { leadLandedAt } from "../lib/rollOffIntake.js";
import { recordFunnelEvent } from "../lib/funnelStore.js";

const TARGET_COMPANY = "Mountain High Disposal";
const NEEDS_HUMAN_TAG = "ai-needs-human";
const OPTED_OUT_TAG = "ai-opted-out";
const SEND_DELAY_MS = 1500; // small pause between real sends, avoids bursting
// Same blast-radius idea as Kaizen's sendOutreach.ts PACED_SEND_CAP.
const PACED_SEND_CAP = 100;

// RESIDENTIAL_TAG: the residential bot texts them already (lib/rollOff.ts).
const STOP_TAGS = [OPTED_OUT_TAG, NEEDS_HUMAN_TAG, ROLLOFF_PROCESSING_TAG, ROLLOFF_BOOKED_TAG, ROLLOFF_FOLLOWUP_2_TAG, RESIDENTIAL_TAG];

interface PendingEntry {
  contactId: string;
}

/** Live GHL query, same as Kaizen's sendOutreach.ts. Excludes anyone already
 * finished with or blocked from this flow, plus excluded-city and
 * out-of-state leads (never tagged, so they'd otherwise eat the cap on
 * every run); processEntry re-checks all of it on fresh data anyway. */
async function loadQueue(): Promise<PendingEntry[]> {
  const locationId = process.env.GHL_LOCATION_ID!;
  const company = findCompany(TARGET_COMPANY)!;
  const contacts = await findContactsByTag(ROLLOFF_ELIGIBLE_TAG, locationId);
  return contacts
    .filter((c) => {
      const tags: string[] = (c.tags ?? []).map((t: string) => t.toLowerCase());
      return !STOP_TAGS.some((t) => tags.includes(t));
    })
    .filter((c) => !isExcludedCity(c.city, company.excludedCities) && !isOutsideServiceStates(c.state, company.serviceStates))
    .map((c) => ({ contactId: c.id }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const STAGE_TAG: Record<RollOffStage, string> = {
  cold_open: ROLLOFF_COLD_OPEN_SENT_TAG,
  follow_up_1: ROLLOFF_FOLLOWUP_1_TAG,
  follow_up_2: ROLLOFF_FOLLOWUP_2_TAG,
};

export type EntryOutcome = "sent" | "skipped" | "retry";

export interface ProcessOptions {
  /** Explicit, not read internally, so tests can pin the clock — same
   * convention as Kaizen's sendFollowUps.ts. */
  now?: Date;
  /** Every MTS contract for a phone number — run() wires this to
   * checkMtsContractList on its logged-in page. Undefined when there's no
   * MTS login (DRY_RUN), which never reaches a real send anyway. */
  findContracts?: (phone: string) => Promise<MtsContractRow[]>;
  /** Overridable for tests only — see ROLLOFF_TCPA_CONSENT_CONFIRMED. */
  consentConfirmed?: boolean;
}

/** Under DRY_RUN this never writes anything to GHL (no tags, no notes) —
 * it only logs what it would have done. */
export async function processEntry(entry: PendingEntry, opts: ProcessOptions = {}): Promise<EntryOutcome> {
  const now = opts.now ?? new Date();
  const consentConfirmed = opts.consentConfirmed ?? ROLLOFF_TCPA_CONSENT_CONFIRMED;
  const dryRun = process.env.DRY_RUN === "true";
  const company = findCompany(TARGET_COMPANY)!;
  const rollOff = company.rollOff!;
  const locationId = process.env.GHL_LOCATION_ID!;
  const { contactId } = entry;

  const contact = await getContact(contactId);
  const tags: string[] = (contact.tags ?? []).map((t: string) => t.toLowerCase());

  if (contact.dnd === true) {
    logEvent({ event: "rolloff_text_skip_dnd", contactId });
    return "skipped";
  }
  // Nothing to text — and an empty MTS search would match every contract.
  if (!String(contact.phone ?? "").replace(/\D/g, "")) {
    logEvent({ event: "rolloff_text_skip_no_phone", contactId });
    return "skipped";
  }
  if (!tags.includes(ROLLOFF_ELIGIBLE_TAG) || STOP_TAGS.some((t) => tags.includes(t))) {
    logEvent({ event: "rolloff_text_skip_flagged", contactId, tags });
    return "skipped";
  }
  // Same rule as every other proactive text (Thomas, 2026-09-29): nothing
  // goes into a city Mountain High no longer takes, or a state it doesn't
  // serve. Nothing is tagged, so a change to either list re-includes them.
  if (isExcludedCity(contact.city, company.excludedCities) || isOutsideServiceStates(contact.state, company.serviceStates)) {
    logEvent({ event: "rolloff_text_skip_out_of_area", contactId, city: contact.city, state: contact.state });
    return "skipped";
  }

  const conversationId = await findConversationId(contactId, locationId);
  const history = conversationId ? await getConversationHistory(conversationId) : [];

  // A rep has texted this person before (any conversation, not just this
  // booking) — never talk over them, but don't let a started booking go
  // unnoticed either: hand it to the office.
  if (history.some((t) => t.sentByHuman)) {
    logEvent({ event: "rolloff_text_skip_human_in_thread", contactId, dryRun });
    if (!dryRun) {
      await addTag(contactId, NEEDS_HUMAN_TAG);
      await addNote(contactId, "Started a roll-off dumpster booking online and didn't finish. A rep has texted this person before, so the AI didn't — please follow up with them.");
    }
    return "skipped";
  }

  // Notes survive a re-import that could drop tags — backstop for the sent tag.
  const notes = await getNotes(contactId);
  const coldOpenNoted = notes.some((n) => n.body.startsWith(AI_ROLLOFF_COLD_OPEN_NOTE_MARKER));
  const coldOpenSent = tags.includes(ROLLOFF_COLD_OPEN_SENT_TAG) || coldOpenNoted;
  if (coldOpenNoted && !tags.includes(ROLLOFF_COLD_OPEN_SENT_TAG) && !dryRun) {
    await addTag(contactId, ROLLOFF_COLD_OPEN_SENT_TAG);
  }

  // When this booking attempt started: the pick-up note's time
  // (importRollOffLeads.ts), since an existing contact's dateAdded is old.
  const landedAt = leadLandedAt(contact.dateAdded, notes);
  const plan = planRollOffText({ tags, coldOpenSent, contactDateAdded: landedAt, history, now });
  if ("wait" in plan) {
    logEvent({ event: "rolloff_text_not_due", contactId, reason: plan.wait });
    return "skipped";
  }
  const stage = plan.send;

  // Unlike the residential cold open, every roll-off text waits for a
  // reasonable hour: even the first one goes out at least half an hour after
  // they left the form, so there's no "they're on the site right now" reason
  // to text at 11pm. Due, so the next run in hours picks it back up.
  if (!isWithinQuietHours(now, company.timezone)) {
    logEvent({ event: "rolloff_text_held_quiet_hours", contactId, stage });
    return "retry";
  }

  // Same failed-delivery rule as Kaizen's sendFollowUps.ts (Jim Deroin, 2026-08-25):
  // if nothing we've ever sent them actually delivered, a "checking back"
  // nudge makes no sense — send the real first text instead.
  const outboundTurns = history.filter((t) => t.direction === "outbound");
  const neverActuallyDelivered = stage !== "cold_open" && outboundTurns.length > 0 && outboundTurns.every((t) => t.status === "failed");

  const firstName = safeFirstName(contact.firstName);
  const draft =
    stage === "cold_open" || neverActuallyDelivered
      ? buildRollOffColdOpen(company, firstName)
      : fillBookingLink(
          await draftFollowUp(
            stage === "follow_up_1" ? buildRollOffFollowUp1Prompt(company, rollOff) : buildRollOffFollowUp2Prompt(company, rollOff),
            formatHistory(history),
            firstName
          ),
          rollOff
        );

  if (dryRun) {
    logEvent({ event: "rolloff_text_dry_run", contactId, stage, draft, neverActuallyDelivered });
    return "retry"; // nothing sent — retry for real on a future run
  }

  if (!consentConfirmed) {
    logEvent({ event: "rolloff_text_blocked_tcpa_gate", contactId, stage });
    return "retry"; // retry once the gate is flipped
  }

  // Claimed before the slow MTS check + send, same as Kaizen's sendOutreach.ts
  // PROCESSING_TAG: narrows (GHL tags have no compare-and-swap) the window
  // for two overlapping runs to both text the same lead.
  await addTag(contactId, ROLLOFF_PROCESSING_TAG);
  try {
    // They may have finished online (what we asked them to do) or booked
    // with the office since starting.
    if (opts.findContracts) {
      const since = bookingCheckSince(landedAt, now, company.timezone);
      const recent = contractsSince(await opts.findContracts(contact.phone), since);
      if (recent.length > 0) {
        await addTag(contactId, ROLLOFF_BOOKED_TAG);
        await addNote(
          contactId,
          `AI stopped roll-off texts — MTS has a contract for this phone from ${since} or later: ` +
            recent.map((c) => `Cust #${c.custNumber} ${c.name}, sale date "${c.saleDate ?? "?"}", ${c.status}`).join("; ") +
            `. No action needed; this isn't an error.`
        );
        logEvent({ event: "rolloff_text_skip_already_booked", contactId, recent });
        return "skipped";
      }
    }

    await sendSms(contactId, draft);
    // For the dashboard: the first text that goes out counts as reached.
    await recordFunnelEvent("reached", contactId);
    await addTag(contactId, STAGE_TAG[stage]);
    await addNote(
      contactId,
      stage === "cold_open"
        ? `${AI_ROLLOFF_COLD_OPEN_NOTE_MARKER} ${JSON.stringify({ sentAt: now.toISOString() })}`
        : neverActuallyDelivered
          ? `AI re-sent the roll-off first text (nothing sent before had delivered, per GHL) instead of follow-up #${stage === "follow_up_1" ? 1 : 2}.`
          : `AI sent roll-off follow-up #${stage === "follow_up_1" ? 1 : 2}.`
    );
    logEvent({ event: "rolloff_text_sent", contactId, stage, draft });
    return "sent";
  } finally {
    // Cleared whatever happens, or an error leaves it stuck and silently
    // blocks every future run for this contact (a lesson from Kaizen's sendOutreach.ts).
    try {
      await removeTag(contactId, ROLLOFF_PROCESSING_TAG);
    } catch (err: any) {
      logEvent({ event: "rolloff_processing_tag_cleanup_failed", contactId, error: err.message });
    }
  }
}

/** contactIdOverride / `--contact-id=` processes exactly one contact —
 * manual/debug runs only. */
export async function run(contactIdOverride?: string): Promise<void> {
  if (!(await isServiceActive())) {
    logEvent({ event: "rolloff_text_service_paused" });
    console.log("Paused by the kill switch (or the flag could not be read): nothing sent.");
    await recordHeartbeat("rolloff-send", true, "paused by the kill switch, nothing sent", new Date(), { paused: true });
    return;
  }

  // A signed contract whose GHL note failed earlier is retried here, so the
  // office still hears about it.
  try {
    const pending = await retryPendingNotices();
    if (pending.delivered || pending.stillPending) console.log(`Contract notices: delivered ${pending.delivered}, still pending ${pending.stillPending}`);
  } catch (err: any) {
    logEvent({ event: "contract_notice_retry_crashed", error: err.message });
  }

  const cliContactId = contactIdOverride ?? process.argv.find((a) => a.startsWith("--contact-id="))?.split("=")[1];
  const queue = cliContactId ? [{ contactId: cliContactId }] : (await loadQueue()).slice(0, PACED_SEND_CAP);
  console.log(`Checking ${queue.length} roll-off lead(s)...`);

  const dryRun = process.env.DRY_RUN === "true";
  let browser: import("playwright").Browser | undefined;
  let page: import("playwright").Page | undefined;
  // No MTS login when nothing can send this run anyway.
  if (!dryRun && ROLLOFF_TCPA_CONSENT_CONFIRMED && queue.length > 0) {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await loginToMts(page);
  }

  let sent = 0;
  let skipped = 0;
  let retried = 0;
  let errored = 0;
  try {
    for (const entry of queue) {
      try {
        const outcome = await processEntry(entry, { findContracts: page ? (phone) => checkMtsContractList(page!, phone) : undefined });
        if (outcome === "sent") sent++;
        else if (outcome === "retry") retried++;
        else skipped++;
      } catch (err: any) {
        logEvent({ event: "rolloff_text_error", contactId: entry.contactId, error: err.message });
        if (!dryRun) {
          try {
            await addTag(entry.contactId, NEEDS_HUMAN_TAG);
            await addNote(entry.contactId, `AI roll-off text hit an error and could not send: ${err.message}`);
          } catch {
            // swallow — the original error above is already logged
          }
        }
        errored++;
      }
      if (!dryRun) await sleep(SEND_DELAY_MS);
    }
  } finally {
    await browser?.close();
  }

  console.log(`\nDone. Sent: ${sent}, skipped: ${skipped}, held for retry: ${retried}, errored: ${errored}`);
  await recordHeartbeat("rolloff-send", errored === 0, `${dryRun ? "test mode: " : ""}checked ${queue.length}, sent ${sent}, skipped ${skipped}, retry ${retried}, errored ${errored}`);
  // A partly failed run must fail the job, so GitHub tells someone.
  if (errored > 0) process.exitCode = 1;
}

// Only self-invoke when run directly, not when imported by a test — and
// dotenv only here.
if (import.meta.url === `file://${process.argv[1]}`) {
  const dotenv = await import("dotenv");
  dotenv.default.config({ path: new URL("../.env.local", import.meta.url).pathname });
  run().catch(async (err) => {
    console.error(err);
    await recordHeartbeat("rolloff-send", false, `crashed: ${err?.message ?? err}`);
    process.exit(1);
  });
}

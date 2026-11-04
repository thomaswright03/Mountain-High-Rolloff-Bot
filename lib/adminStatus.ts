import { list } from "@vercel/blob";
import { blobFolder } from "./blobNamespace.js";
import { isServiceActive } from "./killswitch.js";
import { readHeartbeat, statusStoreReady, type Heartbeat } from "./runStatus.js";
import { ROLLOFF_TCPA_CONSENT_CONFIRMED, TARGET_COMPANY } from "./rollOff.js";
import { bookingEmailFor, findCompany } from "./companies.js";
import { countParkedReplies } from "./parkedReplies.js";
import { loadQualitySummary, QUALITY_WINDOW_DAYS, type QualitySummary } from "./replyQuality.js";
import { logEvent } from "./logging.js";
import { errorMessage } from "./errors.js";

export type Status = "OK" | "Warning" | "Down" | "Unknown";
export type Tier = "Important" | "Key" | "Basic";

export interface FunctionStatus {
  tier: Tier;
  name: string;
  status: Status;
  /** ISO time, or null when there is no check to report. */
  last_checked: string | null;
  last_success: string | null;
  next_expected_run: string | null;
  detail: string;
}

export interface AdminStatus {
  product: string;
  checked_at: string;
  overall: Status;
  functions: FunctionStatus[];
}

/** The GitHub Actions job is scheduled every 30 minutes, like the
 * residential bot (Thomas, 2026-11-03). */
export const JOB_INTERVAL_MIN = 30;
/** Later than this after the last run is a warning; twice that is down. GitHub's
 * scheduler is often late, so one missed slot isn't an alarm. */
const JOB_WARN_MIN = 60;
const JOB_DOWN_MIN = 120;

/** Everything the page needs from outside, so tests can supply it. */
export interface StatusInputs {
  now: Date;
  env: NodeJS.ProcessEnv;
  beats: Record<string, Heartbeat | null>;
  blob: { ok: boolean; detail: string };
  ghl: { status: Status; detail: string };
  killswitch: { active: boolean } | null;
  /** Texts parked while the bot was paused, or null if they can't be counted. */
  parked: number | null;
  /** Model drafts checked before sending, or null if they can't be read. */
  quality: QualitySummary | null;
}

/** Rows that only change when a lead acts: no record yet is Unknown, but not a reason to warn. */
const EVENT_DRIVEN = new Set(["Contacts stuck mid-send", "Bookings signed by text", "Booking email to the office", "Reply quality"]);

const BEAT_NAMES = ["rolloff-import", "rolloff-send", "replies", "replies-unanswered", "claude", "mts-login", "backup", "booking-signed", "booking-email", "rolloff-stuck"];

/** More than this share of AI texts held back by the checks is a Warning. */
const QUALITY_WARN_SHARE = 0.1;

/** The backup job runs daily; later than this is stale. */
const BACKUP_WARN_HOURS = 30;
const BACKUP_DOWN_HOURS = 54;

type Lower = "ok" | "warning" | "down" | "unknown";

/** The shape the CAO's reader parses: lowercase status and tier values. */
export interface AdminStatusJson {
  product: string;
  checked_at: string;
  overall: Lower;
  functions: Array<Omit<FunctionStatus, "status" | "tier"> & { status: Lower; tier: "important" | "key" | "basic" }>;
}

export function toJson(s: AdminStatus): AdminStatusJson {
  return {
    product: s.product,
    checked_at: s.checked_at,
    overall: s.overall.toLowerCase() as Lower,
    functions: s.functions.map((f) => ({ ...f, status: f.status.toLowerCase() as Lower, tier: f.tier.toLowerCase() as "important" | "key" | "basic" })),
  };
}

function minutesSince(iso: string, now: Date): number {
  return (now.getTime() - new Date(iso).getTime()) / 60_000;
}

/** A scheduled job's row, from its recorded result. Anything stale is a warning
 * or down, never OK. */
function jobRow(tier: Tier, name: string, beat: Heartbeat | null, now: Date, what: string): FunctionStatus {
  const base = { tier, name, last_checked: beat?.lastRun ?? null, last_success: beat?.lastSuccess ?? null, next_expected_run: null as string | null };
  if (!beat) return { ...base, status: "Unknown", detail: `No recorded ${what} run yet.` };
  const age = minutesSince(beat.lastRun, now);
  const next = new Date(new Date(beat.lastRun).getTime() + JOB_INTERVAL_MIN * 60_000).toISOString();
  if (!beat.ok) return { ...base, next_expected_run: next, status: "Down", detail: `The last run failed: ${beat.detail}` };
  if (beat.warning && age <= JOB_DOWN_MIN) return { ...base, next_expected_run: next, status: "Warning", detail: beat.detail };
  if (beat.paused && age <= JOB_DOWN_MIN) return { ...base, next_expected_run: next, status: "Warning", detail: `Paused by the kill switch (or its flag couldn't be read): nothing is being sent. ${beat.detail}` };
  if (age > JOB_DOWN_MIN) return { ...base, next_expected_run: next, status: "Down", detail: `No run for ${Math.round(age)} minutes (expected every ${JOB_INTERVAL_MIN}). Last: ${beat.detail}` };
  if (age > JOB_WARN_MIN) return { ...base, next_expected_run: next, status: "Warning", detail: `Last run was ${Math.round(age)} minutes ago (expected every ${JOB_INTERVAL_MIN}). ${beat.detail}` };
  return { ...base, next_expected_run: next, status: "OK", detail: beat.detail };
}

/** A service row, from the last time the bot used it. */
function serviceRow(tier: Tier, name: string, beat: Heartbeat | null, now: Date, what: string): FunctionStatus {
  const base = { tier, name, last_checked: beat?.lastRun ?? null, last_success: beat?.lastSuccess ?? null, next_expected_run: null };
  if (!beat) return { ...base, status: "Unknown", detail: `The bot hasn't used ${what} since status recording started.` };
  if (!beat.ok) return { ...base, status: "Down", detail: `The last attempt failed: ${beat.detail}` };
  const hours = minutesSince(beat.lastRun, now) / 60;
  if (hours > 24) return { ...base, status: "Warning", detail: `Last used ${Math.round(hours)} hours ago, so this is not a fresh check. ${beat.detail}` };
  return { ...base, status: "OK", detail: beat.detail };
}

/** The next 09:17 UTC (the backup workflow's cron time) after `from`. */
export function nextBackupRun(from: Date): string {
  const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 9, 17));
  if (next.getTime() <= from.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

/** Contacts left with the "processing" tag by a send run that died mid-send. The
 * send job clears stale ones each run; any it could not clear are counted here. */
function stuckRow(beat: Heartbeat | null): FunctionStatus {
  const base = { tier: "Key" as Tier, name: "Contacts stuck mid-send", last_checked: beat?.lastRun ?? null, last_success: beat?.lastSuccess ?? null, next_expected_run: null };
  if (!beat) return { ...base, status: "Unknown", detail: "The send job hasn't checked for stuck contacts yet." };
  if (!beat.ok) return { ...base, status: "Warning", detail: `${beat.count ?? "Some"} contact(s) are stuck with the processing tag and could not be released: ${beat.detail}` };
  return { ...base, status: "OK", detail: beat.detail };
}

/** Signed contracts are copied out of the Blob store daily (scripts/backupBlobs.ts). */
function backupRow(beat: Heartbeat | null, now: Date): FunctionStatus {
  const base = { tier: "Basic" as Tier, name: "Latest backup", last_checked: beat?.lastRun ?? null, last_success: beat?.lastSuccess ?? null, next_expected_run: beat ? nextBackupRun(new Date(beat.lastRun)) : null };
  if (!beat) return { ...base, status: "Unknown", detail: "No backup has been recorded yet." };
  if (!beat.ok) return { ...base, status: "Down", detail: `The last backup failed: ${beat.detail}` };
  const hours = minutesSince(beat.lastRun, now) / 60;
  if (hours > BACKUP_DOWN_HOURS) return { ...base, status: "Down", detail: `Last backup was ${Math.round(hours)} hours ago. ${beat.detail}` };
  if (hours > BACKUP_WARN_HOURS) return { ...base, status: "Warning", detail: `Last backup was ${Math.round(hours)} hours ago (expected daily). ${beat.detail}` };
  return { ...base, status: "OK", detail: `${Math.round(hours)} hours old. ${beat.detail}` };
}

/** Texts that came in while the bot was paused, waiting to be answered. */
function parkedRow(parked: number | null, checked: string): FunctionStatus {
  const base = { tier: "Key" as Tier, name: "Texts waiting from a pause", last_checked: checked, next_expected_run: null };
  if (parked === null) return { ...base, status: "Warning", last_success: null, detail: "Couldn't count the texts that came in while the bot was paused. Ask your developer to check the saved records." };
  if (parked > 0) return { ...base, status: "Warning", last_success: checked, detail: `${parked} lead text(s) came in while the bot was paused. They're answered, or handed to the office if they're more than half a day old, on the first scheduled run after the bot is turned back on.` };
  return { ...base, status: "OK", last_success: checked, detail: "No texts are waiting." };
}

/** Every AI-written text is checked before it's sent (lib/draftChecks.ts);
 * this is how many passed over the last week. */
function qualityRow(q: QualitySummary | null, checked: string): FunctionStatus {
  const base = { tier: "Key" as Tier, name: "Reply quality", last_checked: checked, next_expected_run: null };
  if (q === null) return { ...base, status: "Unknown", last_success: null, detail: "The reply checks couldn't be read. Ask your developer to check the saved records." };
  if (q.checked === 0) return { ...base, status: "Unknown", last_success: null, detail: `No AI-written text in the last ${QUALITY_WINDOW_DAYS} days.` };
  const passed = q.checked - q.held;
  const detail = `${passed} of ${q.checked} AI-written texts in the last ${QUALITY_WINDOW_DAYS} days passed every check (approved prices only, no promised delivery day, never "booked", no card request, no link).${q.held ? ` ${q.held} failed one, so it wasn't sent and the office got that lead.` : ""}`;
  return { ...base, status: q.held / q.checked > QUALITY_WARN_SHARE ? "Warning" : "OK", last_success: checked, detail };
}

export function buildStatus(i: StatusInputs): AdminStatus {
  const { now, env, beats } = i;
  const checked = now.toISOString();
  const testMode = env.DRY_RUN === "true";
  const rows: FunctionStatus[] = [];

  // Important
  const importBeat = beats["rolloff-import"] ?? null;
  const sendBeat = beats["rolloff-send"] ?? null;
  rows.push(jobRow("Important", "Lead pick-up from MTS", importBeat, now, "pick-up"));
  const texts = jobRow("Important", "Scheduled texts", sendBeat, now, "texting");
  // Live, the kill switch decides whether anything is sent. If its flag is
  // paused, unreachable or unset, a green "last run" must not hide that.
  if (!testMode && texts.status === "OK" && !i.killswitch?.active) {
    texts.status = "Warning";
    texts.detail = `Paused by the kill switch: the flag says paused, can't be reached or isn't set, so scheduled texts and replies are stopped. ${texts.detail}`;
  }
  rows.push(texts);
  const replies = serviceRow("Important", "Replies answered", beats.replies ?? null, now, "the reply path");
  // Replies only happen when a lead texts in, so a quiet day isn't a fault.
  if (replies.status === "Warning" && beats.replies?.ok) replies.status = "OK";
  // But a lead text nobody answered is: the scheduled job looks for any
  // that waited too long, which is how a switched-off or broken GHL
  // "Customer Replied" workflow shows up (lib/inbound.ts never hears of it).
  const unanswered = beats["replies-unanswered"] ?? null;
  if (unanswered && !unanswered.ok && minutesSince(unanswered.lastRun, now) <= JOB_DOWN_MIN) {
    replies.status = "Down";
    replies.detail = unanswered.detail;
    replies.last_checked = unanswered.lastRun;
  } else if (unanswered?.ok && replies.status !== "Down") {
    replies.detail = `${replies.status === "Unknown" ? "No reply has come in yet since status recording started" : replies.detail}. Checked ${Math.round(minutesSince(unanswered.lastRun, now))} minutes ago: ${unanswered.detail}.`;
    if (replies.status === "Unknown") replies.status = "OK";
  }
  rows.push(replies);

  // Booking by text: a lead signs by replying with their full name. Signing
  // only happens when a lead does it, so a quiet week isn't a fault; a failed
  // signing is.
  const signed = serviceRow("Important", "Bookings signed by text", beats["booking-signed"] ?? null, now, "booking by text");
  if (signed.status === "Warning" && beats["booking-signed"]?.ok) signed.status = "OK";
  if (signed.status === "Unknown") signed.detail = "No signing recorded yet (none has happened since status recording started).";
  rows.push(signed);

  // Key
  rows.push({ tier: "Key", name: "Contact system (GoHighLevel)", status: i.ghl.status, last_checked: i.ghl.status === "Unknown" ? null : checked, last_success: i.ghl.status === "OK" ? checked : null, next_expected_run: null, detail: i.ghl.detail });
  // The signed booking goes to the customer team by email through GHL.
  const bookingEmail = serviceRow("Key", "Booking email to the office", beats["booking-email"] ?? null, now, "the booking email");
  if (bookingEmail.status === "Warning" && beats["booking-email"]?.ok) bookingEmail.status = "OK";
  const company = findCompany(TARGET_COMPANY);
  const email = company ? bookingEmailFor(company, env) : { to: null, isTeam: false };
  if (!email.to) {
    bookingEmail.status = "Warning";
    bookingEmail.detail = "No address is set, so signed bookings aren't emailed (the office still gets the note and star in GoHighLevel). Ask your developer to set the customer team's address.";
  } else if (!email.isTeam && bookingEmail.status !== "Down") {
    bookingEmail.status = "Warning";
    bookingEmail.detail = `Signed bookings are emailed to ${email.to}, a stand-in, not Mountain High's customer team. Ask your developer to set the team's address. ${bookingEmail.detail}`;
  } else if (bookingEmail.status !== "Down") {
    bookingEmail.detail = `Signed bookings are emailed to ${email.to}. ${bookingEmail.detail}`;
  }
  rows.push(bookingEmail);
  rows.push(parkedRow(i.parked, checked));
  rows.push(qualityRow(i.quality, checked));
  rows.push(serviceRow("Key", "AI replies (Claude)", beats.claude ?? null, now, "Claude"));
  rows.push(jobRow("Key", "MTS sign-in", beats["mts-login"] ?? null, now, "MTS login"));
  rows.push({ tier: "Key", name: "Saved records", status: i.blob.ok ? "OK" : "Down", last_checked: checked, last_success: i.blob.ok ? checked : null, next_expected_run: null, detail: i.blob.detail });
  const latestRun = [importBeat, sendBeat].filter((b): b is Heartbeat => Boolean(b)).sort((a, b) => b.lastRun.localeCompare(a.lastRun))[0] ?? null;
  rows.push(stuckRow(beats["rolloff-stuck"] ?? null));
  rows.push(backupRow(beats.backup ?? null, now));
  const job = jobRow("Key", "Scheduled job", latestRun, now, "scheduled job");
  const jobBad = [importBeat, sendBeat].some((b) => b && !b.ok);
  rows.push(jobBad ? { ...job, status: "Down", detail: `A step failed in its last run. Ask your developer to look at the failed run. ${job.detail}` } : job);

  // Basic
  const hasFlag = Boolean(env.KILLSWITCH_URL);
  let ks: { status: Status; detail: string };
  if (!hasFlag) ks = { status: "Warning", detail: testMode ? "The emergency pause page isn't set up. That's fine while the bot is in test mode, but ask your developer to set it up before real texting starts." : "The emergency pause page isn't set up, so the bot is paused on purpose. Ask your developer to set it up." };
  else if (i.killswitch?.active) ks = { status: "OK", detail: "The emergency pause page was reached and says the bot may run." };
  else ks = { status: "Warning", detail: "PAUSED: the pause page says stop, or it couldn't be reached. Texts and replies are stopped. If that is a surprise, check the pause page." };
  rows.push({ tier: "Basic", name: "Kill switch", ...ks, last_checked: checked, last_success: ks.status === "OK" ? checked : null, next_expected_run: null });
  // Not a fault while in test mode (on purpose), but a live bot blocked by
  // the consent gate sends nothing, so that is a warning.
  const blocked = testMode || !ROLLOFF_TCPA_CONSENT_CONFIRMED;
  rows.push({
    tier: "Basic",
    name: "Test mode and texting permission",
    status: !testMode && !ROLLOFF_TCPA_CONSENT_CONFIRMED ? "Warning" : "OK",
    last_checked: checked,
    last_success: blocked ? null : checked,
    next_expected_run: null,
    detail: `Test mode is ${testMode ? "ON: no one is texted and nothing is saved to the contact system" : "OFF"}. Written OK to text these leads: ${ROLLOFF_TCPA_CONSENT_CONFIRMED ? "received" : "NOT received yet, so no scheduled text goes out until the CEO confirms"}. ${blocked ? "The bot is not sending." : "The bot can send."}`,
  });
  const sha = env.VERCEL_GIT_COMMIT_SHA;
  // DEPLOYED_AT (ISO time) is set at deploy; shown in Denver time when valid.
  const deployedAt = (v?: string) => {
    const d = v ? new Date(v) : null;
    if (!d || Number.isNaN(d.getTime())) return "";
    return ` since ${d.toLocaleString("en-US", { timeZone: "America/Denver", dateStyle: "medium", timeStyle: "short" })} Denver time`;
  };
  rows.push({
    tier: "Basic",
    name: "Deployed version",
    status: sha ? "OK" : "Unknown",
    last_checked: checked,
    last_success: sha ? checked : null,
    next_expected_run: null,
    detail: sha ? `Version ${sha.slice(0, 7)} is live${deployedAt(env.DEPLOYED_AT)}. See Latest Update below for what changed.` : "This copy isn't the live website, so there is no deployed version to report.",
  });

  const important = rows.filter((r) => r.tier === "Important");
  const overall: Status = important.some((r) => r.status === "Down")
    ? "Down"
    : rows.some((r) => r.status === "Down" || r.status === "Warning")
      ? "Warning"
      : rows.every((r) => r.status === "Unknown")
        ? "Unknown"
        : rows.some((r) => r.status === "Unknown" && r.tier !== "Basic" && !EVENT_DRIVEN.has(r.name))
          ? "Warning"
          : "OK";
  return { product: "Mountain High Roll-Off Bot", checked_at: checked, overall, functions: rows };
}

/** Real checks against the outside world, then buildStatus. */
export async function collectStatus(env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): Promise<AdminStatus> {
  const [beatList, blob, ghl, parked, quality, killswitch] = await Promise.all([
    Promise.all(BEAT_NAMES.map((n) => readHeartbeat(n))),
    checkBlob(env),
    checkGhl(env),
    countParkedReplies(),
    loadQualitySummary(now).catch((err: unknown) => {
      logEvent({ event: "reply_quality_read_failed", error: errorMessage(err) });
      return null;
    }),
    env.KILLSWITCH_URL ? isServiceActive(env).then((active) => ({ active })) : Promise.resolve(null),
  ]);
  const beats = Object.fromEntries(BEAT_NAMES.map((n, idx) => [n, beatList[idx] ?? null]));
  return buildStatus({ now, env, beats, blob, ghl, killswitch, parked, quality });
}

async function checkBlob(env: NodeJS.ProcessEnv): Promise<{ ok: boolean; detail: string }> {
  if (!env.BLOB_READ_WRITE_TOKEN || !statusStoreReady()) return { ok: false, detail: "Nowhere is set up to save the bot's records, so status and dashboard counts can't be kept. Ask your developer to connect it." };
  try {
    await list({ prefix: `${blobFolder("status")}/`, limit: 1 });
    return { ok: true, detail: "The bot's saved records (status, dashboard counts) can be read." };
  } catch (err: unknown) {
    logEvent({ event: "admin_blob_check_failed", error: errorMessage(err) });
    return { ok: false, detail: "The bot's saved records can't be read right now, so this page and the dashboard may be out of date. Ask your developer to check the storage connection." };
  }
}

async function checkGhl(env: NodeJS.ProcessEnv): Promise<{ status: Status; detail: string }> {
  if (!env.GHL_API_TOKEN || !env.GHL_LOCATION_ID) return { status: "Unknown", detail: "The contact system (GoHighLevel) isn't connected yet. Ask your developer to connect it before real texting." };
  try {
    const base = env.GHL_API_BASE_URL ?? "https://services.leadconnectorhq.com";
    const res = await fetch(`${base}/locations/${encodeURIComponent(env.GHL_LOCATION_ID)}`, {
      headers: { Authorization: `Bearer ${env.GHL_API_TOKEN}`, Version: "2021-07-28" },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) return { status: "OK", detail: "GoHighLevel answered and accepted the bot's sign-in." };
    logEvent({ event: "admin_ghl_check_failed", status: res.status });
    if (res.status === 401) return { status: "Down", detail: "GoHighLevel turned down the bot's sign-in, so it can't text or read contacts. Ask your developer to renew the bot's GoHighLevel key." };
    if (res.status === 403) return { status: "Warning", detail: "GoHighLevel answered, but the bot isn't allowed to read the account details this check uses. Texting may still work; ask your developer to check the bot's GoHighLevel permissions." };
    return { status: "Down", detail: "GoHighLevel answered with an error. If this lasts more than an hour, ask your developer to look." };
  } catch (err: unknown) {
    logEvent({ event: "admin_ghl_check_failed", error: errorMessage(err) });
    return { status: "Down", detail: "GoHighLevel didn't answer. If this lasts more than an hour, ask your developer to look." };
  }
}

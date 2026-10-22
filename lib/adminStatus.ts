import { list } from "@vercel/blob";
import { blobFolder } from "./blobNamespace.js";
import { isServiceActive } from "./killswitch.js";
import { pendingNoticeSummary } from "./pendingNotices.js";
import { readHeartbeat, statusStoreReady, type Heartbeat } from "./runStatus.js";
import { ROLLOFF_TCPA_CONSENT_CONFIRMED } from "./rollOff.js";
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

/** The GitHub Actions job is scheduled every 10 minutes. */
export const JOB_INTERVAL_MIN = 10;
/** Later than this after the last run is a warning; twice that is down. GitHub's
 * scheduler is often a few minutes late, so one missed slot isn't an alarm. */
const JOB_WARN_MIN = 30;
const JOB_DOWN_MIN = 60;

/** Everything the page needs from outside, so tests can supply it. */
export interface StatusInputs {
  now: Date;
  env: NodeJS.ProcessEnv;
  beats: Record<string, Heartbeat | null>;
  blob: { ok: boolean; detail: string };
  ghl: { status: Status; detail: string };
  killswitch: { active: boolean } | null;
  pending: { count: number; oldest: string | null } | null;
}

/** Rows that only change when a lead acts: no record yet is Unknown, but not a reason to warn. */
const EVENT_DRIVEN = new Set(["Contacts stuck mid-send", "Bookings signed by text", "Booking email to the office"]);

const BEAT_NAMES = ["rolloff-import", "rolloff-send", "replies", "claude", "mts-login", "backup", "booking-signed", "booking-email", "rolloff-stuck"];

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
  rows.push(bookingEmail);
  rows.push(serviceRow("Key", "AI replies (Claude)", beats.claude ?? null, now, "Claude"));
  rows.push(jobRow("Key", "MTS sign-in", beats["mts-login"] ?? null, now, "MTS login"));
  rows.push({ tier: "Key", name: "Record storage", status: i.blob.ok ? "OK" : "Down", last_checked: checked, last_success: i.blob.ok ? checked : null, next_expected_run: null, detail: i.blob.detail });
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
  // Not used by the booking-by-text flow; kept for contracts made by hand
  // (README: Manual contract signing). A fault here never takes overall down.
  const missing = ["CONTRACT_SIGNING_SECRET", "PUBLIC_BASE_URL", "BLOB_READ_WRITE_TOKEN"].filter((k) => !env[k]);
  const pending = i.pending;
  const manual = { tier: "Basic" as Tier, name: "Manual contract signing page", last_checked: checked, next_expected_run: null };
  if (missing.length > 0) rows.push({ ...manual, status: "Unknown", last_success: null, detail: `Not set up. Only needed for contracts made by hand; booking by text doesn't use it, so no action is needed. (Missing: ${missing.join(", ")})` });
  else if (!i.blob.ok) rows.push({ ...manual, status: "Warning", last_success: null, detail: `Set up, but record storage isn't answering right now. Ask your developer to check it. (${i.blob.detail})` });
  else if (pending && pending.count > 0) rows.push({ ...manual, status: "Warning", last_success: checked, detail: `${pending.count} signed contract(s) haven't reached the office yet (oldest ${pending.oldest ?? "unknown"}). The bot keeps retrying; call the customer if it lasts more than a day.` });
  else if (pending === null) rows.push({ ...manual, status: "Warning", last_success: null, detail: "Set up, but the list of signed contracts waiting for the office couldn't be read. Ask your developer to check it." });
  else rows.push({ ...manual, status: "OK", last_success: checked, detail: "Ready, and no hand-made contract is waiting for the office." });
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
    detail: sha ? `Version ${sha.slice(0, 7)}${env.VERCEL_ENV ? ` (${env.VERCEL_ENV})` : ""} is live${deployedAt(env.DEPLOYED_AT)}. See Latest Update below for what changed.` : "Not running on Vercel, so there is no deployed version to report.",
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
  const [beatList, blob, ghl, pending, killswitch] = await Promise.all([
    Promise.all(BEAT_NAMES.map((n) => readHeartbeat(n))),
    checkBlob(env),
    checkGhl(env),
    pendingNoticeSummary(),
    env.KILLSWITCH_URL ? isServiceActive(env).then((active) => ({ active })) : Promise.resolve(null),
  ]);
  const beats = Object.fromEntries(BEAT_NAMES.map((n, idx) => [n, beatList[idx] ?? null]));
  return buildStatus({ now, env, beats, blob, ghl, killswitch, pending });
}

async function checkBlob(env: NodeJS.ProcessEnv): Promise<{ ok: boolean; detail: string }> {
  if (!env.BLOB_READ_WRITE_TOKEN || !statusStoreReady()) return { ok: false, detail: "No record storage is connected, so signed bookings and counts can't be kept. Ask your developer to connect it." };
  try {
    await list({ prefix: `${blobFolder("status")}/`, limit: 1 });
    return { ok: true, detail: "Record storage is answering." };
  } catch (err: unknown) {
    return { ok: false, detail: String(errorMessage(err) ?? err).slice(0, 200) };
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
    if (res.ok) return { status: "OK", detail: "GHL answered a location lookup with the bot's token." };
    if (res.status === 401) return { status: "Down", detail: "GHL rejected the API token (401)." };
    if (res.status === 403) return { status: "Warning", detail: "GHL is reachable, but this token isn't allowed to read the location (403); texting may still work." };
    return { status: "Down", detail: `GHL answered ${res.status}.` };
  } catch (err: unknown) {
    return { status: "Down", detail: `GHL didn't answer: ${String(errorMessage(err) ?? err).slice(0, 150)}` };
  }
}

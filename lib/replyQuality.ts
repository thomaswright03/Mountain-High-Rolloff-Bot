import { getFunnelBackend } from "./funnelStore.js";
import { logEvent } from "./logging.js";
import { errorMessage } from "./errors.js";

// Every model-drafted text is put through lib/draftChecks.ts before it is
// sent, and each result is kept here, so /admin can show how the live model
// is doing ("Reply quality") without anyone reading threads. One small file
// per checked draft, in the same private Blob store as the funnel:
//
//   quality/pass/{iso time}-{contactId}.json
//   quality/held/{iso time}-{contactId}.json   failed a check, not sent
//
// Only real drafts are counted: nothing is recorded under DRY_RUN.

export const QUALITY_FOLDER = "quality";
export const QUALITY_WINDOW_DAYS = 7;

export type DraftKind = "reply" | "follow-up";

/** Never throws: the text has already been sent or held by now. */
export async function recordDraftCheck(kind: DraftKind, contactId: string, problems: string[], now: Date = new Date()): Promise<void> {
  if (process.env.DRY_RUN === "true") return;
  const backend = getFunnelBackend();
  if (!backend.ready() || !/^[A-Za-z0-9_-]{1,64}$/.test(contactId)) return;
  const verdict = problems.length === 0 ? "pass" : "held";
  try {
    await backend.putOnce(`${QUALITY_FOLDER}/${verdict}/${now.toISOString().replace(/[:.]/g, "-")}-${contactId}.json`, JSON.stringify({ kind, contactId, problems, at: now.toISOString() }));
  } catch (err: unknown) {
    logEvent({ event: "reply_quality_record_failed", contactId, error: errorMessage(err) });
  }
}

export interface QualitySummary {
  checked: number;
  held: number;
}

/** Drafts checked and held back over the last QUALITY_WINDOW_DAYS, or
 * null when no store is connected. */
export async function loadQualitySummary(now: Date = new Date()): Promise<QualitySummary | null> {
  if (!getFunnelBackend().ready()) return null;
  const since = now.getTime() - QUALITY_WINDOW_DAYS * 86_400_000;
  const files = (await getFunnelBackend().list(`${QUALITY_FOLDER}/`)).filter((f) => f.uploadedAt.getTime() >= since);
  return { checked: files.length, held: files.filter((f) => f.pathname.startsWith(`${QUALITY_FOLDER}/held/`)).length };
}

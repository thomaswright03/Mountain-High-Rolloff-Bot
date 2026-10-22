import type { VercelRequest, VercelResponse } from "@vercel/node";
import { dashboardPassword, isSignedIn } from "../lib/dashboardAuth.js";
import { aggregateDailyStats, buildDayRange } from "../lib/dashboardStats.js";
import { funnelStoreReady, loadFunnelActivity, type FunnelActivity } from "../lib/funnelStore.js";
import { findCompany } from "../lib/companies.js";
import { logEvent } from "../lib/logging.js";
import { errorMessage } from "../lib/errors.js";

const BRAND = "Mountain High Disposal";
/** The page's widest window. Narrower windows are cut from this on the
 * page, so switching windows doesn't reload anything. */
export const DASHBOARD_DAYS = 90;

/** The roll-off dashboard's numbers (api/dashboard.ts), for a signed-in
 * session only. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex");

  const password = dashboardPassword();
  if (!password) {
    res.status(503).json({ error: "The dashboard isn't set up yet." });
    return;
  }
  if (!isSignedIn(req.headers, password)) {
    res.status(401).json({ error: "Not signed in." });
    return;
  }
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  const company = findCompany(BRAND)!;
  const storeConnected = funnelStoreReady();
  try {
    const empty: FunnelActivity = { reached: [], responded: [], contractsSent: [], contractsSigned: [] };
    const activity = storeConnected ? await loadFunnelActivity() : empty;
    const stats = aggregateDailyStats(buildDayRange(DASHBOARD_DAYS, new Date(), company.timezone), activity, company.timezone);
    res.status(200).json({ timezone: company.timezone, stats, notices: notices(storeConnected) });
  } catch (err: unknown) {
    logEvent({ event: "dashboard_data_error", error: errorMessage(err) });
    res.status(500).json({ error: "the store didn't answer, try again in a minute." });
  }
}

/** Plain-language reasons a number might be zero or not final yet. */
export function notices(storeConnected: boolean, env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  if (!storeConnected) {
    out.push("No Blob store is connected to this site yet, so there's nothing to count. Connect one in Vercel under Storage.");
  }
  if (env.DRY_RUN === "true") {
    out.push("Test mode: the bot isn't texting any leads yet, so nothing it does is counted until it goes live.");
  }
  if (findCompany(BRAND)?.rollOff?.contract.standardTerms == null) {
    out.push("Contracts are marked TEST, not binding, until Mountain High's own roll-off terms are added.");
  }
  return out;
}

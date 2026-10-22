/**
 * Independent "is the service allowed to run" check, hosted separately from
 * whatever infrastructure eventually gets handed to the client (Vercel,
 * Anthropic) — lets the developer pause the AI without needing access to
 * the client's accounts. This is a disclosed, contractual mechanism (see
 * the service agreement's suspension-for-non-payment clause), not a hidden
 * backdoor.
 *
 * The flag is hosted as a static file on its own separate Vercel project
 * (under a completely different account from the one operating this
 * service), with deployment protection disabled and explicit
 * `Cache-Control: no-store` headers — confirmed 2026-07-25 that
 * raw.githubusercontent.com ignores query strings for cache-key purposes,
 * so a GitHub-hosted flag could stay stale for 5-10+ minutes regardless of
 * cache-busting. This approach updates instantly on redeploy instead.
 *
 * Fails CLOSED once the bot can text for real (DRY_RUN is not "true"): if
 * the flag URL is unset, unreachable, or answers with an error, the service
 * counts as paused, so a broken or missing flag can never leave a live bot
 * texting with no way to stop it. In test mode (DRY_RUN=true, nothing is
 * sent) a missing flag is treated as active so test runs still work, but
 * a flag that is configured and unreachable is still treated as paused.
 */
export async function isServiceActive(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const url = env.KILLSWITCH_URL;
  if (!url) return env.DRY_RUN === "true";

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return false;
    const data = (await res.json()) as { active?: unknown } | null;
    return data?.active === true;
  } catch {
    return false;
  }
}

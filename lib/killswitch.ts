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
 * Fails OPEN (treats the service as active) if the flag itself can't be
 * reached — a transient network issue with the flag host shouldn't take
 * down the whole service.
 */
export async function isServiceActive(): Promise<boolean> {
  const url = process.env.KILLSWITCH_URL;
  if (!url) return true; // not configured -> always active

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return true;
    const data = (await res.json()) as any;
    return data?.active !== false;
  } catch {
    return true;
  }
}

/**
 * MVP logging: structured JSON lines to stdout, which Vercel captures and
 * makes searchable in the project's Logs tab. Good enough to debug and to
 * manually spot-check escalations early on.
 *
 * Note (task: add logging/QA trail): once volume grows, pipe this to
 * something queryable long-term (e.g. a Postgres/Supabase table or a
 * logging service) instead of relying on Vercel's log retention window.
 */
export function logEvent(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
}

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// Sign-in for the roll-off dashboard (api/dashboard.ts). Unlike Kaizen's
// dashboard, nothing secret ever goes in the URL (a link with ?secret=...
// ends up in browser history, screenshots and anything it's pasted into):
// you type DASHBOARD_PASSWORD once and get a signed, HttpOnly cookie.
//
// The cookie is keyed off the password itself, so changing
// DASHBOARD_PASSWORD in Vercel signs everyone out.

export const SESSION_COOKIE = "__Host-rolloff_dashboard";
export const SESSION_DAYS = 30;
/** Long enough that guessing it through the sign-in form isn't realistic. */
export const MIN_PASSWORD_LENGTH = 12;

/** Null while it's unset or too short: the dashboard stays locked. */
export function dashboardPassword(env: NodeJS.ProcessEnv = process.env): string | null {
  const password = env.DASHBOARD_PASSWORD ?? "";
  return password.length >= MIN_PASSWORD_LENGTH ? password : null;
}

export function passwordMatches(given: unknown, password: string): boolean {
  if (typeof given !== "string" || given.length > 1000) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(password).digest();
  return timingSafeEqual(a, b);
}

function signature(expires: number, password: string): string {
  const key = createHash("sha256").update("rolloff-dashboard-session\0").update(password).digest();
  return createHmac("sha256", key).update(`v1.${expires}`).digest("base64url");
}

const ATTRIBUTES = "Path=/; HttpOnly; Secure; SameSite=Lax";

export function sessionCookie(password: string, now: Date = new Date()): string {
  const expires = now.getTime() + SESSION_DAYS * 86_400_000;
  return `${SESSION_COOKIE}=v1.${expires}.${signature(expires, password)}; ${ATTRIBUTES}; Max-Age=${SESSION_DAYS * 86_400}`;
}

export function signedOutCookie(): string {
  return `${SESSION_COOKIE}=; ${ATTRIBUTES}; Max-Age=0`;
}

function readCookie(header: string | string[] | undefined, name: string): string | undefined {
  const raw = Array.isArray(header) ? header.join("; ") : header ?? "";
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function isSignedIn(headers: Record<string, string | string[] | undefined>, password: string, now: Date = new Date()): boolean {
  const match = /^v1\.(\d{1,15})\.([A-Za-z0-9_-]{43})$/.exec(readCookie(headers.cookie, SESSION_COOKIE) ?? "");
  if (!match) return false;
  const expires = Number(match[1]);
  if (expires <= now.getTime()) return false;
  const expected = Buffer.from(signature(expires, password));
  const given = Buffer.from(match[2]!);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

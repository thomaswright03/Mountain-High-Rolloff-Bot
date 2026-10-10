import { test } from "node:test";
import assert from "node:assert/strict";
import { SESSION_COOKIE, dashboardPassword, isSignedIn, passwordMatches, sessionCookie, signedOutCookie } from "./dashboardAuth.js";

const PASSWORD = "correct horse battery";
const NOW = new Date("2026-10-10T16:00:00Z");

/** The name=value part of a Set-Cookie header, as a browser sends it back. */
const sent = (setCookie: string) => ({ cookie: setCookie.split(";")[0]! });

test("the dashboard stays locked until a password of 12+ characters is set", () => {
  assert.equal(dashboardPassword({}), null);
  assert.equal(dashboardPassword({ DASHBOARD_PASSWORD: "short" }), null);
  assert.equal(dashboardPassword({ DASHBOARD_PASSWORD: PASSWORD }), PASSWORD);
});

test("only the exact password matches", () => {
  assert.ok(passwordMatches(PASSWORD, PASSWORD));
  assert.ok(!passwordMatches("correct horse batter", PASSWORD));
  assert.ok(!passwordMatches("", PASSWORD));
  assert.ok(!passwordMatches(undefined, PASSWORD));
  assert.ok(!passwordMatches(["correct horse battery"], PASSWORD));
});

test("the session cookie is HttpOnly, Secure, host-only and signs you in for 30 days", () => {
  const cookie = sessionCookie(PASSWORD, NOW);
  assert.ok(cookie.startsWith(`${SESSION_COOKIE}=v1.`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  assert.ok(!/Domain=/i.test(cookie));
  assert.ok(isSignedIn(sent(cookie), PASSWORD, NOW));
  assert.ok(isSignedIn({ cookie: `other=1; ${sent(cookie).cookie}; more=2` }, PASSWORD, NOW));
  assert.ok(isSignedIn(sent(cookie), PASSWORD, new Date(NOW.getTime() + 29 * 86_400_000)));
  assert.ok(!isSignedIn(sent(cookie), PASSWORD, new Date(NOW.getTime() + 31 * 86_400_000)), "expired");
});

test("no cookie, a tampered one, or one from before the password changed doesn't sign you in", () => {
  const cookie = sent(sessionCookie(PASSWORD, NOW)).cookie;
  assert.ok(!isSignedIn({}, PASSWORD, NOW));
  assert.ok(!isSignedIn({ cookie: `${SESSION_COOKIE}=` }, PASSWORD, NOW));
  // Pushing the expiry out breaks the signature.
  const [name, value] = cookie.split("=") as [string, string];
  const [v, expires, sig] = value.split(".") as [string, string, string];
  assert.ok(!isSignedIn({ cookie: `${name}=${v}.${Number(expires) + 86_400_000}.${sig}` }, PASSWORD, NOW));
  assert.ok(!isSignedIn({ cookie: `${name}=${v}.${expires}.${sig.slice(0, -1)}A` }, PASSWORD, NOW));
  assert.ok(!isSignedIn({ cookie }, "a brand new password", NOW));
  assert.ok(!isSignedIn(sent(signedOutCookie()), PASSWORD, NOW));
  assert.match(signedOutCookie(), /Max-Age=0/);
});

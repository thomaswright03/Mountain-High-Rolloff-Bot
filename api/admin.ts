import type { VercelRequest, VercelResponse } from "@vercel/node";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { dashboardPassword, isSignedIn, passwordMatches, sessionCookie } from "../lib/dashboardAuth.js";
import { collectStatus, toJson, type AdminStatus, type Status } from "../lib/adminStatus.js";
import { LATEST_UPDATES } from "../lib/latestUpdate.js";
import { escapeHtml } from "../lib/contract.js";
import { logEvent } from "../lib/logging.js";
import { findCompany } from "../lib/companies.js";
import { SITE_NAV_STYLES, SITE_STYLES, siteMasthead } from "../lib/siteStyle.js";

const TIMEZONE = "America/Denver";
const FAILED_SIGN_IN_DELAY_MS = 1000;

/**
 * The status page, at /admin, and the same data as JSON at /admin/status.json
 * (vercel.json rewrites both here; the JSON one arrives with ?format=json).
 * Sign in with the dashboard password (lib/dashboardAuth.ts). The JSON also
 * accepts `Authorization: Bearer $ADMIN_STATUS_TOKEN`, for monitoring.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex");

  const wantsJson = req.query?.format === "json";
  const password = dashboardPassword();
  const token = process.env.ADMIN_STATUS_TOKEN;
  const bearerOk = wantsJson && tokenMatches(req.headers.authorization, token);
  const signedIn = password ? isSignedIn(req.headers, password) : false;

  if (req.method === "POST" && !wantsJson) {
    await signIn(req, res, password);
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, POST");
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  if (!bearerOk && !signedIn) {
    const configured = Boolean(password || token);
    if (wantsJson) {
      res.status(configured ? 401 : 503).json({ error: configured ? "Not signed in." : "Admin sign-in isn't set up (DASHBOARD_PASSWORD)." });
      return;
    }
    sendHtml(res, password ? 200 : 503, (n) => signInPage(n, password ? "" : "Admin isn't set up yet: it needs a DASHBOARD_PASSWORD of at least 12 characters in Vercel."));
    return;
  }

  const status = await collectStatus();
  if (wantsJson) {
    res.status(200).json(toJson(status));
    return;
  }
  sendHtml(res, 200, (n) => statusPage(n, status));
}

function tokenMatches(header: string | undefined, token: string | undefined): boolean {
  if (!token || token.length < 16 || !header?.startsWith("Bearer ")) return false;
  const a = createHash("sha256").update(header.slice(7)).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

async function signIn(req: VercelRequest, res: VercelResponse, password: string | null): Promise<void> {
  const body = req.body;
  const given = typeof body === "string" ? new URLSearchParams(body).get("password") : body && typeof body === "object" ? (body as Record<string, unknown>).password : undefined;
  if (password && passwordMatches(given, password)) {
    logEvent({ event: "admin_sign_in" });
    res.setHeader("Set-Cookie", sessionCookie(password));
    res.status(303).setHeader("Location", "/admin").send("");
    return;
  }
  logEvent({ event: "admin_sign_in_failed" });
  await new Promise((resolve) => setTimeout(resolve, FAILED_SIGN_IN_DELAY_MS));
  sendHtml(res, 401, (n) => signInPage(n, "That password didn't work."));
}

function sendHtml(res: VercelResponse, code: number, render: (nonce: string) => string): void {
  const nonce = randomBytes(16).toString("base64");
  res.setHeader("Content-Security-Policy", `default-src 'none'; img-src 'self'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(code).send(render(nonce));
}

export function denverTime(iso: string | null): string {
  if (!iso) return "never";
  return new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)) + " MT";
}

const SYMBOL: Record<Status, string> = { OK: "✓", Warning: "!", Down: "✕", Unknown: "?" };

const CSS = SITE_STYLES + SITE_NAV_STYLES + `
  body { max-width: 960px; }
  .masthead { margin-bottom: 8px; }
  h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .16em; color: var(--gold); margin: 32px 0 8px; font-weight: 600; }
  .top { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; justify-content: center; margin: 0; }
  .badge { display: inline-block; font-weight: 700; padding: 2px 10px; border-radius: 999px; border: 2px solid currentColor; white-space: nowrap; transition: color .2s ease; }
  .OK { color: var(--ok); } .Warning { color: var(--warn); } .Down { color: var(--down); } .Unknown { color: var(--unk); }
  :root { --ok:#1f6b3b; --warn:#8a5a00; --down:#b3261e; --unk:#55595c; }
  @media (prefers-color-scheme: dark) { :root { --ok:#7fd49b; --warn:#e8bd5f; --down:#f2b8b5; --unk:#b0b3b6; } }
  .dim { color: var(--ink-dim); font-size: .9rem; }
  table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); vertical-align: top; font-size: .92rem; }
  th { font-size: .75rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-dim); }
  tr:last-child td { border-bottom: none; }
  .card { padding: 8px 18px 14px; margin-top: 8px; }
  .card h3 { font-size: .95rem; margin: 14px 0 4px; } .card ul { margin: 0; padding-left: 20px; } .card li { margin: 3px 0; font-size: .92rem; }
  .card.narrow { max-width: 380px; margin: 32px auto 0; padding: 22px 28px 28px; }
  label { display: block; font-size: 11px; font-weight: 600; letter-spacing: 0.03em; text-transform: uppercase; color: var(--ink-dim); margin-bottom: 8px; }
  input[type=password] { width: 100%; min-height: 44px; padding: 8px 12px; font: inherit; font-size: 16px; color: var(--ink); background: transparent; border: 1px solid var(--line); border-radius: 8px; }
  button.primary { min-height: 44px; margin-top: 16px; width: 100%; font-weight: 600; font-size: 15px; border: 1px solid var(--accent); background: var(--accent); color: var(--accent-ink); }
  button.primary:disabled { opacity: .6; cursor: progress; }
  input:focus-visible, button:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .err { color: var(--down); margin: 0 0 14px; }
  tbody tr { animation: rise .24s ease-out both; }
  tbody tr:nth-child(2) { animation-delay: 25ms; } tbody tr:nth-child(3) { animation-delay: 50ms; } tbody tr:nth-child(4) { animation-delay: 75ms; } tbody tr:nth-child(5) { animation-delay: 100ms; } tbody tr:nth-child(n+6) { animation-delay: 125ms; }
  tbody tr:hover { background: var(--accent-soft); }
  input, button { transition: border-color .15s ease, box-shadow .15s ease, transform .15s ease, opacity .15s ease; }
  button:active { transform: scale(.98); }
  input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .mob { display: none; font-size: .78rem; }
  @media (max-width: 640px) { th:nth-child(3), td:nth-child(3), th:nth-child(4), td:nth-child(4) { display: none; } .mob { display: block; } }
`;

const BRAND = "Mountain High Disposal";
const brand = () => findCompany(BRAND)?.displayName ?? BRAND;
const SIGN_IN_SCRIPT = (nonce: string) =>
  `<script nonce="${nonce}">var f=document.querySelector("form");if(f)f.addEventListener("submit",function(){var b=f.querySelector("button");b.disabled=true;b.textContent="Signing in…";});</script>`;

function shell(nonce: string, title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><meta name="robots" content="noindex" />
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<title>${escapeHtml(title)}</title><style nonce="${nonce}">${CSS}</style></head><body>${body}${SIGN_IN_SCRIPT(nonce)}</body></html>`;
}

function signInPage(nonce: string, error = ""): string {
  return shell(
    nonce,
    "Roll-off bot: status",
    `${siteMasthead(brand(), `<p class="sub">Sign in to see what is working.</p>`)}
<main class="card narrow">
${error ? `<p class="err" role="alert">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/admin"><label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus /><button class="primary" type="submit">Sign in</button></form></main>`
  );
}

function statusPage(nonce: string, s: AdminStatus): string {
  const section = (tier: string) => {
    const rows = s.functions.filter((f) => f.tier === tier);
    return `<h2>${tier}</h2><table><thead><tr><th>Function</th><th>Status</th><th>Last checked</th><th>Last success</th><th>Detail</th></tr></thead><tbody>${rows
      .map(
        (f) =>
          `<tr><td>${escapeHtml(f.name)}</td><td><span class="badge ${f.status}"><span aria-hidden="true">${SYMBOL[f.status]}</span> ${f.status}</span><span class="dim mob">Checked ${escapeHtml(denverTime(f.last_checked))}</span></td><td>${escapeHtml(denverTime(f.last_checked))}</td><td>${escapeHtml(denverTime(f.last_success))}</td><td>${escapeHtml(f.detail)}${f.next_expected_run ? `<br /><span class="dim">Next run expected ${escapeHtml(denverTime(f.next_expected_run))}</span>` : ""}</td></tr>`
      )
      .join("")}</tbody></table>`;
  };
  const updates = LATEST_UPDATES.map(
    (u) =>
      `<div class="card"><h3>${escapeHtml(u.date)}</h3><h3>Frontend changes</h3><ul>${u.frontend.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul><h3>Other changes</h3><ul>${u.changes.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul></div>`
  ).join("");
  return shell(
    nonce,
    "Roll-off bot: status",
    `${siteMasthead(brand(), `<p class="sub">${escapeHtml(s.product)}</p>`, `<a href="/dashboard">Dashboard</a><a href="/admin" aria-current="page">Status</a>`)}
<main><p class="top"><span class="badge ${s.overall}"><span aria-hidden="true">${SYMBOL[s.overall]}</span> ${s.overall}</span><span class="dim">Checked ${escapeHtml(denverTime(s.checked_at))}</span></p>
${section("Important")}${section("Key")}${section("Basic")}
<h2>Latest Update</h2>${updates}</main>`
  );
}

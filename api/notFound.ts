import type { VercelRequest, VercelResponse } from "@vercel/node";
import { randomBytes } from "node:crypto";
import { findCompany } from "../lib/companies.js";
import { escapeHtml } from "../lib/contract.js";
import { SITE_NAV_STYLES, SITE_STYLES, siteMasthead } from "../lib/siteStyle.js";

const BRAND = "Mountain High Disposal";

/** Any path nothing else serves (vercel.json's last rewrite). "/" goes to /dashboard. */
export default function handler(req: VercelRequest, res: VercelResponse) {
  const path = String(req.url ?? "").split("?")[0];
  if (path === "/" || path === "") {
    res.setHeader("Location", "/dashboard");
    res.status(302).send("");
    return;
  }
  const company = findCompany(BRAND);
  const phone = "970-834-1144";
  const nonce = randomBytes(16).toString("base64");
  res.setHeader("Content-Security-Policy", `default-src 'none'; img-src 'self'; style-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'`);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("X-Robots-Tag", "noindex");
  res.status(404).send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><meta name="robots" content="noindex" />
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<title>Page not found</title><style nonce="${nonce}">${SITE_STYLES}${SITE_NAV_STYLES}</style></head><body>
${siteMasthead(company?.displayName ?? BRAND, `<p class="sub">That page doesn't exist.</p>`, `<a href="/dashboard">Dashboard</a><a href="/admin">Status</a>`)}
<div class="card" style="text-align:center"><p>Questions about a dumpster? Call the office at <a href="tel:${escapeHtml(phone.replace(/[^0-9+]/g, ""))}">${escapeHtml(phone)}</a>.</p></div>
</body></html>`);
}

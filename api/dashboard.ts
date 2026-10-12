import type { VercelRequest, VercelResponse } from "@vercel/node";
import { randomBytes } from "node:crypto";
import { dashboardPassword, isSignedIn, passwordMatches, sessionCookie, signedOutCookie } from "../lib/dashboardAuth.js";
import { escapeHtml } from "../lib/contract.js";
import { findCompany } from "../lib/companies.js";
import { logEvent } from "../lib/logging.js";

const BRAND = "Mountain High Disposal";
/** Slows down anyone guessing passwords through the form. */
const FAILED_SIGN_IN_DELAY_MS = 1000;

/**
 * The roll-off dashboard, at /dashboard (vercel.json). Thomas, 2026-10-10:
 * how many roll-off leads the bot has reached and how many roll-off
 * contracts have been signed, laid out like Kaizen's lead-responder
 * dashboard, but counting roll-off leads only.
 *   GET                  the dashboard when signed in, the sign-in form otherwise
 *   POST password=...    signs in (lib/dashboardAuth.ts), then back to GET
 *   POST action=logout   signs out
 * The numbers come from /api/dashboardData once the page loads.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex");
  const nonce = randomBytes(16).toString("base64");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`
  );
  res.setHeader("Content-Type", "text/html; charset=utf-8");

  const password = dashboardPassword();
  if (!password) {
    res.status(503).send(signInPage(nonce, "The dashboard isn't set up yet: it needs a DASHBOARD_PASSWORD of at least 12 characters in Vercel.", false));
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    res.status(200).send(isSignedIn(req.headers, password) ? dashboardPage(nonce) : signInPage(nonce));
    return;
  }

  if (req.method === "POST") {
    const form = readForm(req.body);
    if (form.action === "logout") {
      res.setHeader("Set-Cookie", signedOutCookie());
      res.status(303).setHeader("Location", "/dashboard").send("");
      return;
    }
    if (passwordMatches(form.password, password)) {
      logEvent({ event: "dashboard_sign_in" });
      res.setHeader("Set-Cookie", sessionCookie(password));
      res.status(303).setHeader("Location", "/dashboard").send("");
      return;
    }
    logEvent({ event: "dashboard_sign_in_failed" });
    await new Promise((resolve) => setTimeout(resolve, FAILED_SIGN_IN_DELAY_MS));
    res.status(401).send(signInPage(nonce, "That password didn't work."));
    return;
  }

  res.setHeader("Allow", "GET, POST");
  res.status(405).send(signInPage(nonce, "Method not allowed."));
}

/** Vercel parses a form post into an object; a raw string is parsed here. */
function readForm(body: unknown): Record<string, string> {
  if (typeof body === "string") return Object.fromEntries(new URLSearchParams(body));
  if (body && typeof body === "object") {
    return Object.fromEntries(Object.entries(body).filter((e): e is [string, string] => typeof e[1] === "string"));
  }
  return {};
}

function brandName(): string {
  return escapeHtml(findCompany(BRAND)?.displayName ?? BRAND);
}

const STYLES = `
  :root {
    color-scheme: light dark;
    --bg: #f7f5f1;
    --card: #ffffff;
    --ink: #1c1f1d;
    --ink-dim: #6b6f6c;
    --line: rgba(28,31,29,0.09);
    --accent: #3f6652;
    --accent-ink: #ffffff;
    --accent-soft: rgba(63,102,82,0.12);
    --gold: #a8823f;
    --notice-bg: rgba(168,130,63,0.10);
    --err: #b3261e;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #121311;
      --card: #191b18;
      --ink: #f3f1ec;
      --ink-dim: #9a9d99;
      --line: rgba(243,241,236,0.1);
      --accent: #6fa789;
      --accent-ink: #121311;
      --accent-soft: rgba(111,167,137,0.16);
      --gold: #c9a563;
      --notice-bg: rgba(201,165,99,0.12);
      --err: #f2b8b5;
    }
  }

  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: var(--bg);
    color: var(--ink);
    max-width: 880px;
    margin: 0 auto;
    padding: 56px 24px 80px;
    -webkit-font-smoothing: antialiased;
  }

  .masthead { text-align: center; margin-bottom: 36px; }
  .eyebrow {
    font-size: 11px; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase;
    color: var(--gold); margin: 0 0 10px;
  }
  h1 {
    font-family: Georgia, "Iowan Old Style", "Times New Roman", serif;
    font-weight: 400; font-size: 30px; letter-spacing: 0.01em;
    margin: 0 0 14px; color: var(--ink);
  }
  .rule { width: 56px; height: 1px; margin: 0 auto 16px; background: var(--gold); opacity: 0.6; }
  p.sub { color: var(--ink-dim); font-size: 13.5px; line-height: 1.55; max-width: 560px; margin: 0 auto; }

  .card {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 14px;
    padding: 28px 30px 8px;
    margin-top: 32px;
    box-shadow: 0 1px 2px rgba(0,0,0,0.03), 0 12px 32px -20px rgba(0,0,0,0.18);
  }

  button {
    font: inherit; cursor: pointer; border-radius: 7px;
  }
  .link-button {
    background: none; border: none; padding: 4px 0; color: var(--ink-dim);
    font-size: 13px; text-decoration: underline; text-underline-offset: 3px;
  }
  .link-button:hover { color: var(--ink); }
`;

function shell(nonce: string, title: string, body: string, extraCss = "", script = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)}</title>
<style nonce="${nonce}">${STYLES}${extraCss}</style>
</head>
<body>
${body}
${script ? `<script nonce="${nonce}">${script}</script>` : ""}
</body>
</html>`;
}

function masthead(sub: string): string {
  return `<div class="masthead">
    <p class="eyebrow">Roll-off dumpster bot</p>
    <h1>${brandName()}</h1>
    <div class="rule"></div>
    ${sub}
  </div>`;
}

function signInPage(nonce: string, error = "", showForm = true): string {
  const css = `
  .card.narrow { max-width: 380px; margin: 32px auto 0; padding-bottom: 28px; }
  label { display: block; font-size: 11px; font-weight: 600; letter-spacing: 0.03em; text-transform: uppercase; color: var(--ink-dim); margin-bottom: 8px; }
  input[type=password] {
    width: 100%; min-height: 44px; padding: 8px 12px; font: inherit; font-size: 16px; color: var(--ink);
    background: transparent; border: 1px solid var(--line); border-radius: 8px;
  }
  input[type=password]:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  .primary {
    width: 100%; min-height: 44px; margin-top: 16px; border: 1px solid var(--accent);
    background: var(--accent); color: var(--accent-ink); font-weight: 600; font-size: 15px;
  }
  .error { color: var(--err); font-size: 13.5px; margin: 0 0 14px; }`;
  const form = showForm
    ? `<form method="post" action="/dashboard">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required autofocus />
      <button class="primary" type="submit">Sign in</button>
    </form>`
    : "";
  return shell(
    nonce,
    `${findCompany(BRAND)?.displayName ?? BRAND}: roll-off dashboard`,
    `${masthead(`<p class="sub">Sign in to see roll-off leads reached and contracts signed.</p>`)}
  <div class="card narrow">
    ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
    ${form}
  </div>`,
    css
  );
}

function dashboardPage(nonce: string): string {
  const css = `
  #controls {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    font-size: 13px; color: var(--ink-dim); margin-bottom: 4px;
  }
  #controls label { letter-spacing: 0.03em; text-transform: uppercase; font-size: 11px; font-weight: 600; }
  select {
    font-size: 13.5px; font-family: inherit; color: var(--ink);
    background: transparent; border: 1px solid var(--line); border-radius: 7px;
    padding: 6px 10px; margin-left: 8px;
  }
  #status { margin-top: 4px; color: var(--ink-dim); font-size: 13px; font-style: italic; }

  .notices { margin: 16px 0 0; padding: 0; list-style: none; }
  .notices li {
    background: var(--notice-bg); border-left: 2px solid var(--gold); border-radius: 6px;
    padding: 10px 12px; font-size: 13px; line-height: 1.5; color: var(--ink); margin-top: 8px;
  }

  .totals { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-top: 22px; }
  .totals > div { border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; background: var(--accent-soft); }
  .totals .num { font-family: Georgia, serif; font-size: 26px; font-weight: 400; color: var(--ink); font-variant-numeric: tabular-nums; }
  .totals .label { font-size: 10.5px; color: var(--ink-dim); text-transform: uppercase; letter-spacing: 0.08em; margin-top: 2px; }

  .empty { text-align: center; color: var(--ink-dim); font-size: 14px; padding: 36px 12px 30px; margin: 0; }

  table { width: 100%; border-collapse: collapse; margin-top: 28px; font-size: 13.5px; }
  th, td { text-align: right; padding: 11px 8px; border-bottom: 1px solid var(--line); font-variant-numeric: tabular-nums; }
  th:first-child, td:first-child { text-align: left; white-space: nowrap; }
  th { font-weight: 600; color: var(--ink-dim); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.08em; vertical-align: bottom; }
  tbody tr { transition: background-color 0.15s ease; }
  tbody tr:hover { background: var(--accent-soft); }
  tbody tr:last-child td { border-bottom: none; }
  td.zero { color: var(--ink-dim); }
  .bar-cell { position: relative; width: 26%; }
  .bar { position: absolute; left: 0; top: 6px; bottom: 6px; background: var(--accent-soft); border-radius: 3px; }
  .bar-label { position: relative; z-index: 1; padding-right: 6px; }
  .date-short { display: none; }

  @media (max-width: 640px) {
    body { padding: 32px 16px 56px; }
    .card { padding: 20px 16px 4px; }
    .totals { grid-template-columns: repeat(2, 1fr); gap: 10px; }
    .totals > div { padding: 12px 14px; }
    table { font-size: 13px; }
    th, td { padding: 10px 4px; }
    th { font-size: 9.5px; letter-spacing: 0.05em; }
    .bar-cell { width: auto; }
    .date-long { display: none; }
    .date-short { display: inline; }
  }`;

  const body = `${masthead(
    `<p class="sub">Roll-off leads only. Each column counts what happened that day, Denver time: the bot's first text to a lead, the lead's first reply, a contract link texted to them, and a contract signed.</p>`
  )}
  <div class="card">
    <div id="controls">
      <span><label for="days">Window</label><select id="days">
        <option value="7">Last 7 days</option>
        <option value="14" selected>Last 14 days</option>
        <option value="30">Last 30 days</option>
        <option value="60">Last 60 days</option>
        <option value="90">Last 90 days</option>
      </select></span>
      <form method="post" action="/dashboard"><input type="hidden" name="action" value="logout" /><button class="link-button" type="submit">Sign out</button></form>
    </div>
    <div id="status" role="status">Loading…</div>
    <ul class="notices" id="notices" hidden></ul>
    <div class="totals" id="totals" hidden></div>
    <p class="empty" id="empty" hidden></p>
    <table id="table" hidden>
      <thead>
        <tr><th>Date</th><th>Reached</th><th>Responded</th><th>Contracts sent</th><th>Signed</th></tr>
      </thead>
      <tbody id="rows"></tbody>
    </table>
  </div>`;

  const script = `
(function () {
  var COLUMNS = [
    ["reached", "Reached"],
    ["responded", "Responded"],
    ["contractsSent", "Contracts sent"],
    ["contractsSigned", "Contracts signed"]
  ];
  var WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var select = document.getElementById("days");
  var status = document.getElementById("status");
  var data = null;

  try { var saved = localStorage.getItem("rolloff-dashboard-days"); if (saved) select.value = saved; } catch (e) {}
  if (!select.value) select.value = "14";

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  // The date's own calendar day, so the weekday never shifts with the
  // viewer's timezone.
  function dateCell(iso) {
    var p = iso.split("-").map(Number);
    var weekday = WEEKDAYS[new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay()];
    var td = el("td");
    td.appendChild(el("span", "date-long", weekday + ", " + iso));
    td.appendChild(el("span", "date-short", weekday + " " + p[1] + "/" + p[2]));
    return td;
  }

  function render() {
    if (!data) return;
    var days = Number(select.value);
    var shown = data.stats.slice(-days);
    var totals = { reached: 0, responded: 0, contractsSent: 0, contractsSigned: 0 };
    shown.forEach(function (d) { COLUMNS.forEach(function (c) { totals[c[0]] += d[c[0]]; }); });

    var totalsEl = document.getElementById("totals");
    totalsEl.replaceChildren();
    COLUMNS.forEach(function (c) {
      var tile = el("div");
      tile.appendChild(el("div", "num", totals[c[0]]));
      tile.appendChild(el("div", "label", c[1]));
      totalsEl.appendChild(tile);
    });
    totalsEl.hidden = false;

    var anything = COLUMNS.some(function (c) { return totals[c[0]] > 0; });
    var empty = document.getElementById("empty");
    var table = document.getElementById("table");
    empty.hidden = anything;
    table.hidden = !anything;
    if (!anything) {
      empty.textContent = "No roll-off activity in the last " + days + " days yet.";
      return;
    }

    var rows = document.getElementById("rows");
    rows.replaceChildren();
    var maxReached = Math.max.apply(null, [1].concat(shown.map(function (d) { return d.reached; })));
    shown.slice().reverse().forEach(function (d) {
      var tr = el("tr");
      tr.appendChild(dateCell(d.date));
      COLUMNS.forEach(function (c, i) {
        var td = el("td", d[c[0]] === 0 ? "zero" : "");
        if (i === 0) {
          td.className += " bar-cell";
          var bar = el("span", "bar");
          bar.style.width = (d.reached / maxReached) * 100 + "%";
          td.appendChild(bar);
          td.appendChild(el("span", "bar-label", d.reached));
        } else {
          td.textContent = String(d[c[0]]);
        }
        tr.appendChild(td);
      });
      rows.appendChild(tr);
    });
  }

  function showNotices(list) {
    var ul = document.getElementById("notices");
    ul.replaceChildren();
    list.forEach(function (text) { ul.appendChild(el("li", "", text)); });
    ul.hidden = list.length === 0;
  }

  function load() {
    status.textContent = "Loading…";
    fetch("/api/dashboardData", { credentials: "same-origin", cache: "no-store" })
      .then(function (r) {
        if (r.status === 401) { window.location.reload(); throw new Error("signed out"); }
        return r.json().then(function (body) { if (!r.ok) throw new Error(body.error || ("Request failed: " + r.status)); return body; });
      })
      .then(function (body) {
        data = body;
        showNotices(body.notices || []);
        render();
        status.textContent = "Updated " + new Date().toLocaleTimeString() + ".";
      })
      .catch(function (err) {
        if (err.message !== "signed out") status.textContent = "Couldn't load the numbers: " + err.message;
      });
  }

  select.addEventListener("change", function () {
    try { localStorage.setItem("rolloff-dashboard-days", select.value); } catch (e) {}
    render();
  });
  load();
})();`;

  return shell(nonce, `${findCompany(BRAND)?.displayName ?? BRAND}: roll-off dashboard`, body, css, script);
}

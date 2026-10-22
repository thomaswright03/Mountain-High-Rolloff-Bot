import { escapeHtml } from "./contract.js";

/** Shared by /dashboard, /admin and the 404 page so they look like one product. */
export const SITE_STYLES = `
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

export function siteMasthead(brand: string, sub: string, nav = ""): string {
  return `<div class="masthead">
    <p class="eyebrow">Roll-off dumpster bot</p>
    <h1>${escapeHtml(brand)}</h1>
    <div class="rule"></div>
    ${sub}
    ${nav ? `<nav class="sitenav" aria-label="Pages">${nav}</nav>` : ""}
  </div>`;
}

export const SITE_NAV_STYLES = `
  .sitenav { margin-top: 12px; font-size: 13px; display: flex; gap: 16px; justify-content: center; }
  .sitenav a { color: var(--accent); text-underline-offset: 3px; }
  .sitenav a[aria-current=page] { color: var(--ink); text-decoration: none; font-weight: 600; }
`;

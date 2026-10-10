import { allCompanies } from "./companies.js";

// Security audit, 2026-10-02: whatever a lead typed as their first name on
// the public signup form was pasted verbatim into the cold-open text (and
// into the follow-up system prompt), and the cold open goes to whatever
// phone number was typed on that same form — nothing proves the person
// filling it in owns the phone. A first name of "https://evil.example/pay"
// therefore made Mountain High's own number text a phishing link to a
// stranger. Two independent, code-owned guards close that off:
//   1. safeFirstName: a lead-supplied name only ever reaches an SMS or a
//      prompt if it actually looks like a name — anything else falls back to
//      the existing name-free "Hey there" path.
//   2. assertSafeOutboundSms: every outbound SMS (template or model-drafted)
//      is refused if it contains a link to any host that isn't one of our
//      own configured brand/review links — so even a name or reply that
//      slips past (1) can't turn the business's number into a link sender.

const NAME_WORD = String.raw`\p{L}[\p{L}'’-]*`;
const NAME_RE = new RegExp(`^${NAME_WORD}(?: ${NAME_WORD})?$`, "u");
const MAX_NAME_LENGTH = 30;

/** The only way a lead-supplied first name may reach an outbound SMS or a
 * model prompt. Letters (any alphabet), apostrophes and hyphens, at most two
 * words — no digits, dots, slashes or other punctuation a link or an
 * instruction needs. Returns undefined for anything else, which callers
 * already treat as "no confirmed first name" (never invent one). */
export function safeFirstName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const name = raw.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!name || name.length > MAX_NAME_LENGTH) return undefined;
  return NAME_RE.test(name) ? name : undefined;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Every host our own config legitimately links to (the roll-off booking
 * page, and this deployment's contract signing page at PUBLIC_BASE_URL) —
 * the only hosts an outbound SMS may ever mention. Derived from
 * lib/companies.ts so adding a brand or changing a link needs no second
 * edit here. */
function configuredLinkHosts(): string[] {
  const hosts = new Set<string>();
  const contractPageHost = process.env.PUBLIC_BASE_URL ? hostOf(process.env.PUBLIC_BASE_URL) : null;
  if (contractPageHost) hosts.add(contractPageHost.replace(/^www\./, ""));
  for (const company of allCompanies()) {
    for (const url of [company.rollOff.bookingUrl]) {
      const host = url ? hostOf(url) : null;
      if (host) hosts.add(host.replace(/^www\./, ""));
    }
  }
  return [...hosts];
}

function isAllowedHost(host: string, allowedHosts: string[]): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  return allowedHosts.some((allowed) => normalized === allowed || normalized.endsWith(`.${allowed}`));
}

// Email addresses aren't links (and the escalation contact is an email
// address), so they're removed before looking for hosts.
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const SCHEME_URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi;
// A bare host like "evil.example" or "evil.example/pay": dot-separated
// labels ending in a TLD that starts with a letter (so prices like "$19.99"
// and times like "6.30" never match).
const BARE_HOST_RE = /(?<![\w@.-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62})(?![\w-])/gi;
const IPV4_RE = /(?<![\w.])\d{1,3}(?:\.\d{1,3}){3}(?![\w.])/g;

/** Links in `text` that point anywhere other than our own configured hosts.
 * Empty array means the text is safe to send. */
export function findDisallowedLinks(text: string, allowedHosts: string[] = configuredLinkHosts()): string[] {
  const found = new Set<string>();
  const withoutEmails = text.normalize("NFKC").replace(EMAIL_RE, " ");

  for (const m of withoutEmails.matchAll(SCHEME_URL_RE)) {
    const host = hostOf(m[0]);
    if (!host || !isAllowedHost(host, allowedHosts)) found.add(m[0]);
  }
  // Full URLs were judged by their real host above; drop them so a dotted
  // path segment (e.g. "/form.pdf") isn't mistaken for a second host.
  const withoutUrls = withoutEmails.replace(SCHEME_URL_RE, " ");
  for (const m of withoutUrls.matchAll(BARE_HOST_RE)) {
    if (!isAllowedHost(m[1]!, allowedHosts)) found.add(m[1]!);
  }
  for (const m of withoutUrls.matchAll(IPV4_RE)) {
    found.add(m[0]);
  }
  return [...found];
}

export class UnsafeOutboundSmsError extends Error {
  constructor(public readonly links: string[]) {
    super(`outbound SMS blocked: it contains a link we don't own (${links.join(", ")})`);
    this.name = "UnsafeOutboundSmsError";
  }
}

/** Called by lib/ghl.ts's sendSms() before every send — the single choke
 * point every outbound text in this codebase goes through. Throws rather
 * than silently dropping, so each caller's existing error handling flags the
 * contact for a human to look at. */
export function assertSafeOutboundSms(text: string): void {
  const links = findDisallowedLinks(text);
  if (links.length > 0) throw new UnsafeOutboundSmsError(links);
}

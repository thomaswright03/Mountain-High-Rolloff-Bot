import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { CompanyConfig, RollOffSize } from "./types.js";

// Roll-off contracts signed online (Thomas, 2026-10-10): the lead gets a
// link to their contract, can download it to check with their own AI, and
// signs it with a drawn signature. The signed copy and the signature are
// stored together (lib/contractStore.ts), and the office takes it from
// there. Nothing here takes payment: the office calls to take the card and
// confirm the delivery date.
//
// The contract's words are built only by code, from the brand's config and
// the details given when it's created. The signing page shows exactly the
// stored text, and the signature is only accepted for that exact text
// (documentSha256).

export interface ContractCustomer {
  name: string;
  /** E.164 */
  phone: string;
  email?: string;
  serviceAddress: string;
}

export interface Contract {
  id: string;
  createdAt: string;
  companyMatchValue: string;
  /** GHL contact this contract was sent to, when there is one. */
  contactId?: string;
  customer: ContractCustomer;
  size: RollOffSize;
  /** YYYY-MM-DD the customer asked for. The office confirms it. */
  requestedDeliveryDate?: string;
  /** True while the brand's own standard terms are missing. */
  isTest: boolean;
  /** The full contract, Markdown. What's shown, downloaded and signed. */
  markdown: string;
  documentSha256: string;
}

export interface SignatureRecord {
  contractId: string;
  documentSha256: string;
  typedName: string;
  /** data:image/png;base64,... drawn on the signing page. */
  signaturePng: string;
  signedAt: string;
  ip: string;
  userAgent: string;
  consentText: string;
}

export const ESIGN_CONSENT_TEXT =
  "I agree to sign this contract electronically, and that my electronic signature is the same as my handwritten signature. I agree to receive this contract and records about it electronically, and I can download a copy.";

const MAX_SIGNATURE_PNG_BYTES = 300_000;

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Unguessable, URL-safe. */
export function newContractId(): string {
  return randomBytes(12).toString("base64url");
}

/** The link's proof that it was issued by us, tied to one contract. */
export function signingToken(contractId: string, secret: string): string {
  return createHmac("sha256", secret).update(`rolloff-contract:${contractId}`).digest("base64url");
}

export function verifySigningToken(contractId: string, token: string | undefined, secret: string): boolean {
  if (!token) return false;
  const expected = Buffer.from(signingToken(contractId, secret));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function contractLink(baseUrl: string, contractId: string, secret: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/contract/${contractId}?t=${signingToken(contractId, secret)}`;
}

const money = (n: number) => `$${n.toLocaleString("en-US")}`;
const tons = (n: number) => `${n} ton${n === 1 ? "" : "s"}`;

function formatDate(isoDay: string): string {
  const [y, m, d] = isoDay.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" });
}

/** Strips anything that could act as Markdown/HTML structure from a value
 * typed by the customer, so their own details can't add or hide terms. */
function plain(value: string): string {
  return value.replace(/[<>`*#[\]|\\]/g, "").replace(/\s+/g, " ").trim();
}

export function buildContract(input: {
  company: CompanyConfig;
  customer: ContractCustomer;
  yards: number;
  requestedDeliveryDate?: string;
  contactId?: string;
  now?: Date;
  id?: string;
}): Contract {
  const config = input.company.rollOff.contract;
  const size = config.sizes.find((s) => s.yards === input.yards);
  if (!size) throw new Error(`no ${input.yards} yard roll-off for ${input.company.displayName}`);
  if (input.requestedDeliveryDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.requestedDeliveryDate)) {
    throw new Error(`requested delivery date must be YYYY-MM-DD, got "${input.requestedDeliveryDate}"`);
  }
  const id = input.id ?? newContractId();
  const createdAt = (input.now ?? new Date()).toISOString();
  const customer: ContractCustomer = {
    name: plain(input.customer.name),
    phone: plain(input.customer.phone),
    email: input.customer.email ? plain(input.customer.email) : undefined,
    serviceAddress: plain(input.customer.serviceAddress),
  };
  const isTest = config.standardTerms === null;
  const brand = input.company.displayName;

  const lines = [
    `# ${brand} roll-off dumpster rental agreement`,
    "",
    ...(isTest
      ? [
          `> **TEST CONTRACT, NOT BINDING.** ${brand}'s standard roll-off terms haven't been added yet. Do not sign this expecting a dumpster.`,
          "",
        ]
      : []),
    `Contract number: ${id}`,
    `Prepared: ${formatDate(createdAt.slice(0, 10))}`,
    "",
    "## Who this is between",
    "",
    `- **Company:** ${brand}, office phone ${config.officePhone}`,
    `- **Customer:** ${customer.name}, phone ${customer.phone}${customer.email ? `, email ${customer.email}` : ""}`,
    `- **Service address:** ${customer.serviceAddress}`,
    "",
    "## What you're renting",
    "",
    `- **Dumpster:** ${size.yards} yard roll-off (about ${size.dimensions})`,
    `- **Price:** ${money(size.pricePerDump)} per dump, which includes up to ${tons(size.tonLimit)} of material each dump`,
    `- **Rental period:** ${config.rentalDays} days from delivery`,
    `- **Requested delivery date:** ${input.requestedDeliveryDate ? `${formatDate(input.requestedDeliveryDate)}. ${brand} will confirm the actual date with you.` : `to be set with ${brand}'s office`}`,
    "",
    "## What can't go in the dumpster",
    "",
    `${config.notAllowed.join(", ")}.`.replace(/^./, (c) => c.toUpperCase()),
    "",
    "## Payment",
    "",
    `This page doesn't take payment. After you sign, ${brand}'s office will contact you to take payment and confirm your delivery date. Nothing is scheduled until they do.`,
    "",
    "## Charges not listed here",
    "",
    `Going over the weight limit, keeping the dumpster past ${config.rentalDays} days, and any other charges are set by ${brand}'s standard terms below. Ask the office at ${config.officePhone} for exact amounts before you sign.`,
    "",
    `## ${brand}'s standard terms`,
    "",
    isTest ? "_Not added yet. This is a test contract._" : config.standardTerms!.trim(),
    "",
    "## Signing",
    "",
    `By signing, you agree to rent the dumpster described above on these terms. ${ESIGN_CONSENT_TEXT}`,
    "",
  ];
  const markdown = lines.join("\n");

  return {
    id,
    createdAt,
    companyMatchValue: input.company.matchValue,
    contactId: input.contactId,
    customer,
    size,
    requestedDeliveryDate: input.requestedDeliveryDate,
    isTest,
    markdown,
    documentSha256: sha256(markdown),
  };
}

/** The "download for AI" file: the contract, with a short note on top
 * asking the customer's AI assistant to explain it. The contract text
 * itself is unchanged. */
export function buildAiDownload(contract: Contract): { filename: string; body: string } {
  const body = [
    "<!--",
    "Note for an AI assistant: the customer downloaded this roll-off dumpster",
    "rental contract before signing it, to check what it says. Please explain",
    "in plain words what they'd be agreeing to: the costs, the limits, what",
    "isn't included, and anything they should ask the company about first.",
    `The contract is everything below this note. Its SHA-256 is ${contract.documentSha256}.`,
    "-->",
    "",
    contract.markdown,
  ].join("\n");
  return { filename: `roll-off-contract-${contract.id}.md`, body };
}

export type SignatureCheck = { ok: true; typedName: string; signaturePng: string } | { ok: false; error: string };

/** Checks what the signing page sent before anything is stored. */
export function checkSignatureSubmission(contract: Contract, body: unknown): SignatureCheck {
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.documentSha256 !== contract.documentSha256) {
    return { ok: false, error: "This contract changed since the page loaded. Reload the page and read it again before signing." };
  }
  if (b.consent !== true) return { ok: false, error: "Please check the box to agree to sign electronically." };
  const typedName = typeof b.typedName === "string" ? b.typedName.replace(/\s+/g, " ").trim() : "";
  if (typedName.length < 2 || typedName.length > 100) return { ok: false, error: "Please type your full name." };
  const png = typeof b.signaturePng === "string" ? b.signaturePng : "";
  const prefix = "data:image/png;base64,";
  if (!png.startsWith(prefix) || !/^[A-Za-z0-9+/]+={0,2}$/.test(png.slice(prefix.length))) {
    return { ok: false, error: "Please draw your signature." };
  }
  const bytes = Buffer.from(png.slice(prefix.length), "base64");
  if (bytes.length < 100 || bytes.length > MAX_SIGNATURE_PNG_BYTES || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    return { ok: false, error: "Please draw your signature." };
  }
  return { ok: true, typedName, signaturePng: png };
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Minimal Markdown for the contract's own fixed structure: headings,
 * bullets, bold, a quote line, a whole-line italic and paragraphs. Every
 * value is escaped first. */
export function contractToHtml(markdown: string): string {
  const inline = (s: string) => escapeHtml(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  const out: string[] = [];
  let inList = false;
  for (const line of markdown.split("\n")) {
    const bullet = line.match(/^- (.*)$/);
    if (!bullet && inList) {
      out.push("</ul>");
      inList = false;
    }
    if (bullet) {
      if (!inList) out.push("<ul>");
      inList = true;
      out.push(`<li>${inline(bullet[1]!)}</li>`);
    } else if (line.startsWith("## ")) out.push(`<h2>${inline(line.slice(3))}</h2>`);
    else if (line.startsWith("# ")) out.push(`<h1>${inline(line.slice(2))}</h1>`);
    else if (line.startsWith("> ")) out.push(`<p class="warning">${inline(line.slice(2))}</p>`);
    else if (/^_.+_$/.test(line)) out.push(`<p><em>${inline(line.slice(1, -1))}</em></p>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (inList) out.push("</ul>");
  return out.join("\n");
}

/** The signed copy: the exact contract, the signature, and how it was
 * signed. Self-contained HTML, stored with the signature record and
 * downloadable by the customer. */
export function buildSignedDocument(contract: Contract, sig: SignatureRecord): string {
  const phoneTail = contract.customer.phone.replace(/\D/g, "").slice(-4);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Signed roll-off contract ${escapeHtml(contract.id)}</title>
<style>
body { font: 16px/1.55 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #1b1b1b; background: #fff; max-width: 760px; margin: 32px auto; padding: 0 16px; }
h1 { font-size: 1.5rem; } h2 { font-size: 1.1rem; margin-top: 1.6em; }
.warning { background: #fff4d6; border: 1px solid #e0b100; padding: 10px 12px; border-radius: 6px; }
.signature { border: 1px solid #ccc; border-radius: 6px; padding: 12px; margin-top: 8px; }
.signature img { max-width: 100%; height: auto; display: block; }
table { border-collapse: collapse; width: 100%; font-size: 0.9rem; } td { border-top: 1px solid #ddd; padding: 6px 8px; vertical-align: top; } td:first-child { color: #555; width: 34%; }
</style>
</head>
<body>
${contractToHtml(contract.markdown)}
<h2>Signature</h2>
<div class="signature">
<img alt="Signature of ${escapeHtml(sig.typedName)}" src="${escapeHtml(sig.signaturePng)}" />
<p><strong>${escapeHtml(sig.typedName)}</strong></p>
</div>
<h2>Signing record</h2>
<table>
<tr><td>Contract number</td><td>${escapeHtml(contract.id)}</td></tr>
<tr><td>Signed at</td><td>${escapeHtml(sig.signedAt)}</td></tr>
<tr><td>Name typed by signer</td><td>${escapeHtml(sig.typedName)}</td></tr>
<tr><td>Signing link sent to</td><td>phone ending ${escapeHtml(phoneTail)}</td></tr>
<tr><td>Agreed to</td><td>${escapeHtml(sig.consentText)}</td></tr>
<tr><td>IP address</td><td>${escapeHtml(sig.ip)}</td></tr>
<tr><td>Browser</td><td>${escapeHtml(sig.userAgent)}</td></tr>
<tr><td>Contract SHA-256</td><td>${escapeHtml(sig.documentSha256)}</td></tr>
</table>
</body>
</html>
`;
}

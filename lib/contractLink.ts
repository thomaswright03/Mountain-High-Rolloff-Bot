import { buildContract, contractLink } from "./contract.js";
import { saveContract } from "./contractStore.js";
import { extractJson } from "./claude.js";
import { buildContractDetailsPrompt } from "./rollOffPrompt.js";
import { formatHistory } from "./prompt.js";
import { normalizePhone } from "./rollOffIntake.js";
import { safeFirstName } from "./outboundSafety.js";
import { isExcludedCity } from "./serviceArea.js";
import { isOutsideServiceStates } from "./rollOff.js";
import type { CompanyConfig, ConversationTurn } from "./types.js";

// Making the contract a reply links to (Thomas, 2026-10-10). The model only
// says "send their contract here" (ROLLOFF_CONTRACT_LINK_MARKER). The
// details come from a separate extraction call and are checked here, and
// the contract's words come from code (lib/contract.ts).
//
// Thomas, 2026-10-12: the reply asks the lead for every field on the
// contract (size, delivery day, address, full name, email) before sending
// it. A name, email or address the lead typed in the chat replaces the one
// on file, but only after the same checks: a name must look like a name,
// an email like an email, and a new address must still be somewhere the
// brand takes customers. The phone is always the one on file (the number
// they're texting from). The lead reads and signs the result themselves,
// and lib/contract.ts strips formatting characters from every value.

/** How far ahead a requested delivery day may be. Anything else is left
 * for the office to set. */
const MAX_DAYS_AHEAD = 90;

export type ContractLinkResult = { link: string; contractId?: string } | { unavailable: string };

function dayInZone(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** A requested date is kept only if it's a real calendar day from today
 * through MAX_DAYS_AHEAD days out (the brand's calendar). */
export function acceptRequestedDate(value: unknown, now: Date, timezone: string): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [y, m, d] = value.split("-").map(Number);
  const asDate = new Date(Date.UTC(y!, m! - 1, d!));
  if (asDate.toISOString().slice(0, 10) !== value) return undefined;
  const today = dayInZone(now, timezone);
  const latest = dayInZone(new Date(now.getTime() + MAX_DAYS_AHEAD * 86_400_000), timezone);
  return value >= today && value <= latest ? value : undefined;
}

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i;

/** An email address, or undefined if it doesn't look like one. */
export function safeEmail(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const email = raw.trim();
  return email.length <= 254 && EMAIL_RE.test(email) ? email : undefined;
}

/** A full name for the contract: two to four name-like words, each passing
 * the same rules as a first name (lib/outboundSafety.ts). */
export function safeFullName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const words = raw.normalize("NFKC").trim().split(/\s+/);
  if (words.length < 2 || words.length > 4) return undefined;
  const checked = words.map((w) => safeFirstName(w));
  return checked.every(Boolean) ? checked.join(" ") : undefined;
}

interface Address { street: string; city: string; state: string; zip: string }

const STREET_RE = /^[\p{L}\d][\p{L}\d .'#,/-]{2,79}$/u;
const CITY_RE = /^\p{L}[\p{L} .'-]{1,39}$/u;

/** A delivery address the lead typed, or undefined if any part is missing
 * or doesn't look like an address. */
function chatAddress(raw: unknown): Address | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const a = raw as Record<string, unknown>;
  const street = typeof a.street === "string" ? a.street.trim().replace(/\s+/g, " ") : "";
  const city = typeof a.city === "string" ? a.city.trim().replace(/\s+/g, " ") : "";
  const state = typeof a.state === "string" ? a.state.trim().toUpperCase() : "";
  const zip = typeof a.zip === "string" ? a.zip.trim() : "";
  if (!STREET_RE.test(street) || !CITY_RE.test(city) || !/^[A-Z]{2}$/.test(state) || !/^\d{5}(?:-\d{4})?$/.test(zip)) return undefined;
  return { street, city, state, zip };
}

export async function prepareContractLink(input: {
  company: CompanyConfig;
  contactId: string;
  contact: Record<string, any>;
  history: ConversationTurn[];
  now: Date;
  dryRun: boolean;
}): Promise<ContractLinkResult> {
  const { company, contact, now } = input;
  const secret = process.env.CONTRACT_SIGNING_SECRET;
  const baseUrl = process.env.PUBLIC_BASE_URL;
  if (!input.dryRun && (!secret || !baseUrl || !process.env.BLOB_READ_WRITE_TOKEN)) {
    return { unavailable: "contract signing isn't set up on this deployment yet" };
  }
  const phone = normalizePhone(contact.phone);
  if (!phone) return { unavailable: "no usable phone number on file for the contract" };

  const details = await extractJson(
    buildContractDetailsPrompt(company, company.rollOff),
    `Today is ${dayInZone(now, company.timezone)} (${company.timezone}).\n\nOn file: ${JSON.stringify({
      full_name: [contact.firstName, contact.lastName].filter(Boolean).join(" ") || null,
      email: contact.email || null,
      service_address: contact.address1 ? `${contact.address1}, ${contact.city ?? ""}, ${contact.state ?? ""} ${contact.postalCode ?? ""}`.trim() : null,
    })}\n\nConversation:\n${formatHistory(input.history)}\n\nOutput the JSON object now, and nothing else.`
  );
  const yards = details?.yards;
  if (typeof yards !== "number" || !company.rollOff.contract.sizes.some((s) => s.yards === yards)) {
    return { unavailable: "couldn't tell which dumpster size they chose" };
  }
  const requestedDeliveryDate = acceptRequestedDate(details?.requested_delivery_date, now, company.timezone);
  if (!requestedDeliveryDate) return { unavailable: "couldn't tell which delivery day they want" };

  const typedAddress = chatAddress(details?.service_address);
  if (details?.service_address && !typedAddress) return { unavailable: "the address they gave in the chat isn't a full street address" };
  if (typedAddress && (isExcludedCity(typedAddress.city, company.excludedCities) || isOutsideServiceStates(typedAddress.state, company.serviceStates))) {
    return { unavailable: `the address they gave (${typedAddress.city}, ${typedAddress.state}) is outside where ${company.displayName} takes new customers` };
  }
  const onFileAddress =
    contact.address1 && contact.city && contact.state && contact.postalCode
      ? { street: contact.address1, city: contact.city, state: contact.state, zip: contact.postalCode }
      : undefined;
  const address = typedAddress ?? onFileAddress;
  if (!address) return { unavailable: "no full service address for the contract" };

  const name = safeFullName(details?.full_name) ?? safeFullName([contact.firstName, contact.lastName].filter(Boolean).join(" "));
  if (!name) return { unavailable: "no full name for the contract" };
  const email = safeEmail(details?.email) ?? safeEmail(contact.email);

  const contract = buildContract({
    company,
    customer: {
      name,
      phone,
      email,
      serviceAddress: `${address.street}, ${address.city}, ${address.state} ${address.zip}`,
    },
    yards,
    requestedDeliveryDate,
    contactId: input.contactId,
    now,
  });

  // Test mode: nothing is stored, and the draft only shows where the link
  // would go.
  if (input.dryRun) {
    const c = contract.customer;
    return { link: `<contract link: ${yards} yard, ${requestedDeliveryDate}, ${c.name}, ${c.serviceAddress}, ${c.email ?? "no email"}>` };
  }

  await saveContract(contract);
  return { link: contractLink(baseUrl!, contract.id, secret!), contractId: contract.id };
}

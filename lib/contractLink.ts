import { buildContract, contractLink } from "./contract.js";
import { saveContract } from "./contractStore.js";
import { extractJson } from "./claude.js";
import { buildContractDetailsPrompt } from "./rollOffPrompt.js";
import { formatHistory } from "./prompt.js";
import { normalizePhone } from "./rollOffIntake.js";
import type { CompanyConfig, ConversationTurn } from "./types.js";

// Making the contract a reply links to (Thomas, 2026-10-10). The model only
// says "send their contract here" (ROLLOFF_CONTRACT_LINK_MARKER). The size
// and date come from a separate extraction call, are checked here against
// what the brand actually rents, and the contract's words come from code
// (lib/contract.ts). The address and phone are the ones on file, never
// anything typed in the chat.

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
  if (!(contact.address1 && contact.city && contact.state && contact.postalCode)) {
    return { unavailable: "no full service address on file for the contract" };
  }
  const phone = normalizePhone(contact.phone);
  if (!phone) return { unavailable: "no usable phone number on file for the contract" };

  const details = await extractJson(
    buildContractDetailsPrompt(company, company.rollOff),
    `Today is ${dayInZone(now, company.timezone)} (${company.timezone}).\n\nConversation:\n${formatHistory(input.history)}\n\nOutput the JSON object now, and nothing else.`
  );
  const yards = details?.yards;
  if (typeof yards !== "number" || !company.rollOff.contract.sizes.some((s) => s.yards === yards)) {
    return { unavailable: "couldn't tell which dumpster size they chose" };
  }
  const requestedDeliveryDate = acceptRequestedDate(details?.requested_delivery_date, now, company.timezone);

  const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim() || "Customer";
  const contract = buildContract({
    company,
    customer: {
      name,
      phone,
      email: contact.email || undefined,
      serviceAddress: `${contact.address1}, ${contact.city}, ${contact.state} ${contact.postalCode}`,
    },
    yards,
    requestedDeliveryDate,
    contactId: input.contactId,
    now,
  });

  // Test mode: nothing is stored, and the draft only shows where the link
  // would go.
  if (input.dryRun) return { link: `<contract link: ${yards} yard${requestedDeliveryDate ? `, ${requestedDeliveryDate}` : ""}>` };

  await saveContract(contract);
  return { link: contractLink(baseUrl!, contract.id, secret!), contractId: contract.id };
}

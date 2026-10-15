import type { Contract, SignatureRecord } from "./contract.js";
import { logEvent } from "./logging.js";

// Thomas, 2026-10-10/15: when the lead signs the contract they were texted,
// the bot enters the roll-off booking in MTS itself, with the signed
// contract attached, so the office only calls to take payment and confirm
// the date. Off while the bot is in test mode: a signing only logs what
// would be entered.
//
// The step that actually types the booking into MTS isn't built yet: it
// needs a screenshot of MTS's roll-off booking entry screen, and whether
// MTS needs a card to save one. Until then, switching this on still
// submits nothing.

/** Code switch, like ROLLOFF_TCPA_CONSENT_CONFIRMED: stays false until
 * Thomas turns MTS submission on. DRY_RUN also keeps it off. */
const MTS_SUBMIT_ENABLED = false;

/** What gets entered in MTS for one signed contract. */
export interface MtsBooking {
  company: string;
  customerName: string;
  phone: string;
  email?: string;
  serviceAddress: string;
  yards: number;
  pricePerDump: number;
  tonLimit: number;
  requestedDeliveryDate?: string;
  contractId: string;
  signedBy: string;
  signedAt: string;
}

export function buildMtsBooking(contract: Contract, signature: SignatureRecord): MtsBooking {
  return {
    company: contract.companyMatchValue,
    customerName: contract.customer.name,
    phone: contract.customer.phone,
    email: contract.customer.email,
    serviceAddress: contract.customer.serviceAddress,
    yards: contract.size.yards,
    pricePerDump: contract.size.pricePerDump,
    tonLimit: contract.size.tonLimit,
    requestedDeliveryDate: contract.requestedDeliveryDate,
    contractId: contract.id,
    signedBy: signature.typedName,
    signedAt: signature.signedAt,
  };
}

export type MtsSubmitResult = { status: "test_mode" | "not_built"; booking: MtsBooking };

/** Called once a contract is signed. Never throws: the signature is
 * already saved, and a submission problem is the office's to follow up. */
export async function submitSignedContract(contract: Contract, signature: SignatureRecord): Promise<MtsSubmitResult> {
  const booking = buildMtsBooking(contract, signature);
  if (!MTS_SUBMIT_ENABLED || process.env.DRY_RUN === "true") {
    logEvent({ event: "mts_submit_test_mode", contractId: contract.id, booking });
    return { status: "test_mode", booking };
  }
  logEvent({ event: "mts_submit_not_built", contractId: contract.id });
  return { status: "not_built", booking };
}

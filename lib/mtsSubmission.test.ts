import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContract, type SignatureRecord } from "./contract.js";
import { findCompany } from "./companies.js";
import { buildMtsBooking, submitSignedContract } from "./mtsSubmission.js";

const company = findCompany("Mountain High Disposal")!;
const contract = buildContract({
  company,
  customer: { name: "Jane Doe", phone: "+15551112222", email: "jane@example.com", serviceAddress: "12 Elm St, Greeley, CO 80631" },
  yards: 8,
  requestedDeliveryDate: "2026-10-25",
  contactId: "c1",
  now: new Date("2026-10-15T12:00:00Z"),
});
const signature: SignatureRecord = {
  contractId: contract.id,
  documentSha256: contract.documentSha256,
  typedName: "Jane Doe",
  signaturePng: "data:image/png;base64,AAAA",
  signedAt: "2026-10-15T12:05:00.000Z",
  ip: "203.0.113.9",
  userAgent: "test",
  consentText: "ok",
};

test("the MTS booking carries every contract detail plus who signed and when", () => {
  assert.deepEqual(buildMtsBooking(contract, signature), {
    company: "Mountain High Disposal",
    customerName: "Jane Doe",
    phone: "+15551112222",
    email: "jane@example.com",
    serviceAddress: "12 Elm St, Greeley, CO 80631",
    yards: 8,
    pricePerDump: 325,
    tonLimit: 1,
    requestedDeliveryDate: "2026-10-25",
    contractId: contract.id,
    signedBy: "Jane Doe",
    signedAt: "2026-10-15T12:05:00.000Z",
  });
});

test("submission stays in test mode: nothing is submitted, with or without DRY_RUN", async () => {
  const saved = process.env.DRY_RUN;
  const logs: string[] = [];
  const log = console.log;
  console.log = (line: string) => logs.push(line);
  try {
    for (const dryRun of ["true", "false"]) {
      process.env.DRY_RUN = dryRun;
      const result = await submitSignedContract(contract, signature);
      assert.equal(result.status, "test_mode");
    }
  } finally {
    console.log = log;
    process.env.DRY_RUN = saved;
  }
  assert.equal(logs.filter((l) => l.includes('"event":"mts_submit_test_mode"')).length, 2);
});

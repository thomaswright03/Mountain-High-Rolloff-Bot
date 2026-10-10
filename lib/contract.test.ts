import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAiDownload,
  buildContract,
  buildSignedDocument,
  checkSignatureSubmission,
  contractLink,
  contractToHtml,
  sha256,
  signingToken,
  verifySigningToken,
  ESIGN_CONSENT_TEXT,
} from "./contract.js";
import { findCompany } from "./companies.js";
import { FAKE_PNG } from "./testHelpers/fakePng.js";

const company = findCompany("Mountain High Disposal")!;
const customer = { name: "Jane Doe", phone: "+17205550101", email: "jane_doe@example.com", serviceAddress: "12 Elm St, Greeley, CO 80631" };
const NOW = new Date("2026-10-10T16:00:00Z");

test("every contract size and price matches what the bot is allowed to quote", () => {
  for (const s of company.rollOff.contract.sizes) {
    assert.ok(company.rollOff.facts.includes(`${s.yards} yard: $${s.pricePerDump}, up to ${s.tonLimit} ton`), `${s.yards} yard`);
    assert.ok(company.rollOff.facts.includes(`${s.yards} yard: ${s.dimensions}`), `${s.yards} yard dimensions`);
  }
});

test("a contract states the size, price, weight limit, rental days, address and the payment step", () => {
  const c = buildContract({ company, customer, yards: 20, requestedDeliveryDate: "2026-10-20", now: NOW, id: "abcdefghijkl" });
  assert.match(c.markdown, /20 yard roll-off/);
  assert.match(c.markdown, /\$400 per dump, which includes up to 4 tons/);
  assert.match(c.markdown, /7 days from delivery/);
  assert.match(c.markdown, /12 Elm St, Greeley, CO 80631/);
  assert.match(c.markdown, /October 20, 2026/);
  assert.match(c.markdown, /doesn't take payment/);
  assert.match(c.markdown, /jane_doe@example.com/);
  assert.equal(c.documentSha256, sha256(c.markdown));
});

test("without Mountain High's own terms, every contract says it's a test", () => {
  const c = buildContract({ company, customer, yards: 6, now: NOW });
  assert.equal(c.isTest, true);
  assert.match(c.markdown, /TEST CONTRACT, NOT BINDING/);
});

test("a size Mountain High doesn't rent, or a malformed date, is refused", () => {
  assert.throws(() => buildContract({ company, customer, yards: 15 }));
  assert.throws(() => buildContract({ company, customer, yards: 20, requestedDeliveryDate: "next tuesday" }));
});

test("customer-typed details can't add structure to the contract", () => {
  const c = buildContract({ company, customer: { ...customer, name: "Jane\n## Price: $1 <script>x</script> **free**" }, yards: 20, now: NOW });
  assert.ok(!c.markdown.includes("\n## Price"));
  assert.ok(!c.markdown.includes("<script>"));
  assert.ok(!contractToHtml(c.markdown).includes("<script>"));
  assert.ok(!c.markdown.includes("**free**"));
});

test("signing links: the token only works for its own contract", () => {
  const t = signingToken("contract-one", "s3cret");
  assert.equal(verifySigningToken("contract-one", t, "s3cret"), true);
  assert.equal(verifySigningToken("contract-two", t, "s3cret"), false);
  assert.equal(verifySigningToken("contract-one", t, "other-secret"), false);
  assert.equal(verifySigningToken("contract-one", undefined, "s3cret"), false);
  assert.equal(contractLink("https://x.example/", "contract-one", "s3cret"), `https://x.example/contract/contract-one?t=${t}`);
});

test("download for AI: the exact contract text, with a note asking the AI to explain it", () => {
  const c = buildContract({ company, customer, yards: 20, now: NOW, id: "abcdefghijkl" });
  const file = buildAiDownload(c);
  assert.equal(file.filename, "roll-off-contract-abcdefghijkl.md");
  assert.ok(file.body.endsWith(c.markdown));
  assert.match(file.body, /Note for an AI assistant/);
  assert.ok(file.body.includes(c.documentSha256));
});

test("a signature is only accepted for the exact contract shown, with consent, a name and a drawn signature", () => {
  const c = buildContract({ company, customer, yards: 20, now: NOW });
  const good = { documentSha256: c.documentSha256, consent: true, typedName: " Jane  Doe ", signaturePng: FAKE_PNG };
  assert.deepEqual(checkSignatureSubmission(c, good), { ok: true, typedName: "Jane Doe", signaturePng: FAKE_PNG });
  assert.equal(checkSignatureSubmission(c, { ...good, documentSha256: "0".repeat(64) }).ok, false);
  assert.equal(checkSignatureSubmission(c, { ...good, consent: false }).ok, false);
  assert.equal(checkSignatureSubmission(c, { ...good, typedName: "" }).ok, false);
  assert.equal(checkSignatureSubmission(c, { ...good, signaturePng: "data:image/png;base64,AAAA" }).ok, false);
  assert.equal(checkSignatureSubmission(c, { ...good, signaturePng: "data:image/svg+xml;base64,PHN2Zz4=" }).ok, false);
  assert.equal(checkSignatureSubmission(c, null).ok, false);
});

test("the signed copy holds the contract, the signature image and the signing record, all escaped", () => {
  const c = buildContract({ company, customer, yards: 20, now: NOW, id: "abcdefghijkl" });
  const html = buildSignedDocument(c, {
    contractId: c.id,
    documentSha256: c.documentSha256,
    typedName: "Jane <b>Doe</b>",
    signaturePng: FAKE_PNG,
    signedAt: "2026-10-10T16:05:00.000Z",
    ip: "203.0.113.9",
    userAgent: "Mozilla/5.0 <x>",
    consentText: ESIGN_CONSENT_TEXT,
  });
  assert.match(html, /\$400 per dump/);
  assert.ok(html.includes(`src="${FAKE_PNG}"`));
  assert.match(html, /phone ending 0101/);
  assert.ok(html.includes(c.documentSha256));
  assert.ok(html.includes("Jane &lt;b&gt;Doe&lt;/b&gt;"));
  assert.ok(!html.includes("<x>"));
});

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { randomBytes } from "node:crypto";
import {
  ESIGN_CONSENT_TEXT,
  buildAiDownload,
  buildSignedDocument,
  checkSignatureSubmission,
  contractToHtml,
  escapeHtml,
  verifySigningToken,
  type Contract,
  type SignatureRecord,
} from "../lib/contract.js";
import { loadContract, loadSignature, loadSignedDocument, saveSignature } from "../lib/contractStore.js";
import { findCompany } from "../lib/companies.js";
import { CONTRACT_SIGNED_TAG as SIGNED_TAG, notifyOfficeOrPark } from "../lib/pendingNotices.js";
import { logEvent } from "../lib/logging.js";

export const CONTRACT_SIGNED_TAG = SIGNED_TAG;

/**
 * The contract signing page, at /contract/{id}?t={token} (vercel.json).
 *   GET                     the contract, a "download for AI" button and the signature pad
 *   GET  &download=ai       the contract as a Markdown file to give to an AI
 *   GET  &download=signed   the signed copy, once signed
 *   POST                    signs it: { typedName, signaturePng, consent, documentSha256 }
 *
 * Every request needs the link's token (lib/contract.ts signingToken), so
 * a contract can't be read or signed by guessing its number. Signing
 * stores the signature and the signed copy together (lib/contractStore.ts)
 * and, outside DRY_RUN, notes it on the GHL contact and hands it to the
 * office to take payment and confirm the date.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex");

  const secret = process.env.CONTRACT_SIGNING_SECRET;
  if (!secret) {
    res.status(503).send(page("Not available", "<p>Contract signing isn't set up yet.</p>"));
    return;
  }

  const id = typeof req.query.id === "string" ? req.query.id : "";
  const token = typeof req.query.t === "string" ? req.query.t : undefined;
  // Same answer for a bad token and a missing contract: nothing to learn.
  const contract = verifySigningToken(id, token, secret) ? await loadContract(id) : null;
  if (!contract) {
    res.status(404).send(page("Contract not found", "<p>This link isn't valid. Please use the link you were texted, or call the office.</p>"));
    return;
  }

  if (req.method === "GET") {
    if (req.query.download === "ai") {
      const file = buildAiDownload(contract);
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
      res.status(200).send(file.body);
      return;
    }
    if (req.query.download === "signed") {
      const signed = await loadSignedDocument(contract.id);
      if (!signed) {
        res.status(404).send(page("Not signed yet", "<p>This contract hasn't been signed yet.</p>"));
        return;
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'");
      res.setHeader("Content-Disposition", `attachment; filename="signed-roll-off-contract-${contract.id}.html"`);
      res.status(200).send(signed);
      return;
    }
    const signature = await loadSignature(contract.id);
    const nonce = randomBytes(16).toString("base64");
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src data:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`
    );
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(renderContractPage(contract, signature, token!, nonce));
    return;
  }

  if (req.method === "POST") {
    await handleSign(req, res, contract);
    return;
  }

  res.setHeader("Allow", "GET, POST");
  res.status(405).json({ ok: false, error: "Method not allowed." });
}

async function handleSign(req: VercelRequest, res: VercelResponse, contract: Contract): Promise<void> {
  if (await loadSignature(contract.id)) {
    res.status(409).json({ ok: false, error: "This contract is already signed." });
    return;
  }
  let body: unknown = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = null;
    }
  }
  const check = checkSignatureSubmission(contract, body);
  if (!check.ok) {
    res.status(400).json({ ok: false, error: check.error });
    return;
  }

  const forwarded = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";
  const record: SignatureRecord = {
    contractId: contract.id,
    documentSha256: contract.documentSha256,
    typedName: check.typedName,
    signaturePng: check.signaturePng,
    signedAt: new Date().toISOString(),
    ip,
    userAgent: String(req.headers["user-agent"] ?? "unknown").slice(0, 300),
    consentText: ESIGN_CONSENT_TEXT,
  };

  try {
    await saveSignature(record, buildSignedDocument(contract, record));
  } catch (err: any) {
    // Most likely a second, simultaneous signing attempt losing the race.
    logEvent({ event: "contract_sign_store_failed", contractId: contract.id, error: err.message });
    if (await loadSignature(contract.id)) {
      res.status(409).json({ ok: false, error: "This contract is already signed." });
      return;
    }
    res.status(500).json({ ok: false, error: "We couldn't save your signature. Please try again, or call the office." });
    return;
  }
  logEvent({ event: "contract_signed", contractId: contract.id, isTest: contract.isTest });

  await notifyOffice(contract, record);
  res.status(200).json({ ok: true });
}

/** The office takes it from here: payment and the delivery date. Never
 * fails the signing itself, which is already saved. */
async function notifyOffice(contract: Contract, record: SignatureRecord): Promise<void> {
  if (!contract.contactId) return;
  if (process.env.DRY_RUN === "true") {
    logEvent({ event: "contract_signed_dry_run_no_ghl", contractId: contract.id, contactId: contract.contactId });
    return;
  }
  await notifyOfficeOrPark(
    contract.id,
    contract.contactId,
    `Signed the roll-off contract online${contract.isTest ? " (TEST contract)" : ""}: ${contract.size.yards} yard, $${contract.size.pricePerDump} per dump up to ${contract.size.tonLimit} ton(s), ` +
      `requested delivery ${contract.requestedDeliveryDate ?? "not given"}, at ${contract.customer.serviceAddress}. Signed by "${record.typedName}" at ${record.signedAt}. ` +
      `Contract ${contract.id}. Please call to take payment and confirm the delivery date.`
  );
}

function page(title: string, body: string, nonce?: string, extraCss = ""): string {
  const n = nonce ? ` nonce="${nonce}"` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)}</title>
<style${n}>
:root { --ink: #1c1d1f; --muted: #5d6066; --line: #d9dbe0; --bg: #f6f6f4; --card: #fff; --accent: #2e6b3f; --accent-ink: #fff; --warn-bg: #fff4d6; --warn-line: #d9a400; --err: #b3261e; }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink); background: var(--bg); }
main { max-width: 760px; margin: 0 auto; padding: 24px 16px 64px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 20px; margin-top: 16px; }
h1 { font-size: 1.45rem; line-height: 1.25; margin: 0 0 8px; } h2 { font-size: 1.05rem; margin: 1.5em 0 0.4em; }
.warning { background: var(--warn-bg); border: 1px solid var(--warn-line); border-radius: 8px; padding: 10px 12px; }
.muted { color: var(--muted); font-size: 0.92rem; }
${extraCss}
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

function renderContractPage(contract: Contract, signature: SignatureRecord | null, token: string, nonce: string): string {
  const brand = escapeHtml(findCompany(contract.companyMatchValue)?.displayName ?? contract.companyMatchValue);
  const base = `/contract/${encodeURIComponent(contract.id)}?t=${encodeURIComponent(token)}`;
  const aiLink = `${base}&amp;download=ai`;
  const signedLink = `${base}&amp;download=signed`;

  const css = `
.actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
.btn { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 16px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--ink); font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; }
.btn-primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.btn:disabled { opacity: 0.55; cursor: not-allowed; }
label { display: block; font-weight: 600; margin: 16px 0 6px; }
input[type=text] { width: 100%; min-height: 44px; padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px; font: inherit; }
.pad { position: relative; border: 1px dashed var(--muted); border-radius: 8px; background: #fff; touch-action: none; }
.pad canvas { display: block; width: 100%; height: 180px; }
.consent { display: flex; gap: 10px; align-items: flex-start; font-weight: 400; }
.consent input { margin-top: 5px; width: 20px; height: 20px; flex: none; }
.error { color: var(--err); font-weight: 600; min-height: 1.5em; }
.done { border-color: var(--accent); }
h2.first { margin-top: 0; }`;

  const aiCard = `<div class="card"><div class="actions"><a class="btn" href="${aiLink}" download>Download for AI</a></div>
<p class="muted">Want a second opinion? Download the contract and give the file to whatever AI you use (ChatGPT, Claude, Gemini and so on) to explain it before you sign.</p></div>`;
  const contractCard = `${aiCard}
<div class="card">${contractToHtml(contract.markdown)}</div>`;

  if (signature) {
    return page(
      `Signed: roll-off contract`,
      `<h1>${brand} roll-off contract</h1>
<div class="card done"><h2 class="first">Signed</h2><p>Signed by <strong>${escapeHtml(signature.typedName)}</strong> on ${escapeHtml(new Date(signature.signedAt).toLocaleString("en-US", { timeZone: findCompany(contract.companyMatchValue)?.timezone ?? "America/Denver", dateStyle: "long", timeStyle: "short" }))}. The office will contact you to take payment and confirm your delivery date.</p>
<div class="actions"><a class="btn btn-primary" href="${signedLink}" download>Download your signed copy</a></div></div>
${contractCard}`,
      nonce,
      css
    );
  }

  const script = `
(function () {
  var canvas = document.getElementById("pad");
  var ctx = canvas.getContext("2d");
  var drawn = false, drawing = false, last = null;
  function size() {
    var ratio = window.devicePixelRatio || 1, rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * ratio; canvas.height = rect.height * ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.lineWidth = 2.5; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#111";
    drawn = false; update();
  }
  function point(e) { var r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  canvas.addEventListener("pointerdown", function (e) { drawing = true; last = point(e); canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener("pointermove", function (e) {
    if (!drawing) return;
    var p = point(e); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p;
    if (!drawn) { drawn = true; update(); }
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach(function (t) { canvas.addEventListener(t, function () { drawing = false; }); });
  var name = document.getElementById("typed-name"), consent = document.getElementById("consent");
  var button = document.getElementById("sign"), error = document.getElementById("error");
  function update() { button.disabled = !(drawn && consent.checked && name.value.trim().length >= 2); }
  name.addEventListener("input", update); consent.addEventListener("change", update);
  document.getElementById("clear").addEventListener("click", function () { ctx.clearRect(0, 0, canvas.width, canvas.height); drawn = false; update(); });
  window.addEventListener("resize", size); size();
  button.addEventListener("click", function () {
    button.disabled = true; error.textContent = "";
    fetch(window.location.href, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ typedName: name.value, signaturePng: canvas.toDataURL("image/png"), consent: consent.checked, documentSha256: ${JSON.stringify(contract.documentSha256)} })
    }).then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
      .then(function (r) { if (r.body.ok || r.status === 409) { window.location.reload(); } else { error.textContent = r.body.error || "Something went wrong. Please try again."; update(); } })
      .catch(function () { error.textContent = "Couldn't reach the server. Please try again."; update(); });
  });
})();`;

  return page(
    `Roll-off contract`,
    `<h1>${brand} roll-off contract</h1>
<p class="muted">Read it over, download it to check with your own AI if you like, then sign at the bottom. Signing doesn't charge you anything: the office will contact you to take payment and confirm your delivery date.</p>
${contractCard}
<div class="card">
<h2>Sign</h2>
<label for="typed-name">Your full name</label>
<input id="typed-name" type="text" autocomplete="name" maxlength="100" />
<label for="pad">Draw your signature</label>
<div class="pad"><canvas id="pad" aria-label="Signature pad"></canvas></div>
<div class="actions"><button class="btn" id="clear" type="button">Clear signature</button></div>
<label class="consent"><input id="consent" type="checkbox" /> <span>${escapeHtml(ESIGN_CONSENT_TEXT)}</span></label>
<p class="error" id="error" role="alert"></p>
<div class="actions"><button class="btn btn-primary" id="sign" type="button" disabled>Sign contract</button></div>
</div>
<script nonce="${nonce}">${script}</script>`,
    nonce,
    css
  );
}

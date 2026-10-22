# Mountain High Roll-Off Bot: STATE

Texts people who start booking a roll-off dumpster on mountainhighdisposal.com but don't finish, answers replies, and books in the text thread: code-written summary, full-name signature, office takes the card and enters the MTS contract. Never sends a link or takes a card. Mountain High Disposal only, Colorado only, Loveland blocked.

## Status (2026-10-22): deployed, still TEST MODE
- Live at https://mountain-high-rolloff-bot.vercel.app (/dashboard, /admin, /admin/status.json). Thomas ticked off: Vercel deploy + GHL and signing secrets, GHL connected, kill-switch URL, HITTA_API_KEY, branch protection, eval run, MTS fixture.
- DRY_RUN is on (repo variable) and `ROLLOFF_TCPA_CONSENT_CONFIRMED=false` (lib/rollOff.ts): no scheduled text goes out. Texting, replies, booking and the email have never run against real GHL (docs/live-smoke.md lists what is unrun).
- Tests: `npm test` (195), `npm run typecheck`, `npm run lint` pass. CI runs all three.

## Parts
- GitHub Actions every 10 min: `mts-sync/importRollOffLeads.ts` then `sendRollOffTexts.ts`. Daily `backup-blobs.yml`.
- Vercel: `api/webhook.ts` (replies), `api/contract.ts` (e-sign), `api/dashboard.ts`, `api/admin.ts` (+ `/admin/status.json`, lowercase enums).
- Safety: kill switch (fails closed when live), DRY_RUN (repo variable), `ROLLOFF_TCPA_CONSENT_CONFIRMED=false` in `lib/rollOff.ts`.
- Blob folders: `lib/blobNamespace.ts`; workflows set `BLOB_NAMESPACE=production` so job and Vercel share `status/`, `pending/`, `contracts/`.

## Earlier rounds
Kill switch, status page, backups, reply lock, eval, prompt caching, booking by text: see git history and docs/eval-results.md.

## Shared number with the residential bot (2026-10-21)
- Both bots send from the same GHL location with no `fromNumber`, so both use the location's default number. Kaizen has no idea roll-off tags exist, so this bot steps aside for anyone tagged `ai-outreach-eligible`: not imported (one note + `ai-rolloff-skipped-residential`), not texted, replies skipped.

## Booking by text (2026-10-21)
- Thomas: no links; book in the thread like residential. `lib/rollOffBooking.ts` (answers, summary, signature, notes), `lib/rollOffReply.ts` (flow), `lib/rollOffPrompt.ts` (modes). The e-sign link path (`lib/contractLink.ts`) is gone; `api/contract.ts` stays for manual use.
- MTS roll-off form requires a card (Thomas's test), so no automatic MTS submit: on signing the office gets a note + star and enters it. Summary covers all 7 MTS Agreements. Delivery Type is always Default Delivery.
- 2026-10-22: each signed booking is emailed via GHL (`sendEmail`, type Email) to `rollOff.bookingEmail` (t@thomasewright.com for now) with every MTS field but the card. Recipient contact found by email first so it isn't renamed.

## Excellence fix round 1 (59 -> ?), 2026-10-22, done in code
- /admin Latest Update brought up to date; rows: Important "Bookings signed by text", Key "Booking email to the office" (heartbeats `booking-signed`, `booking-email`), Basic "Manual contract signing page" (old link check, can't take overall Down).
- Signing: booking note, office note, tag, star in that order, 3 tries, notes skipped if already written (`writeSigningRecords`); tests for email failure and note retry (mock GHL `failures`).
- Dashboard labels now booking language; eased motion + reduced-motion on both pages; README documents manual contract use and the eval-commit rule.
- NOT done: dated model ID (no verified snapshot ID; needs the first eval run), `docs/eval-results.md`, cheaper model/prompt caching (needs eval), browser motion capture.

## Excellence fix round 2 (60 -> ?), 2026-10-22, done in code
- Prompt caching (`cache_control` on system block, cache tokens logged); handoff + JSON extraction on `CLAUDE_CHEAP_MODEL` (default claude-haiku-5-5, env `CLAUDE_CHEAP_MODEL_ID`), validated by eval 8/8 (2026-10-22).
- Backup row has next_expected_run (next 09:17 UTC). Stuck processing tag: swept each live send run (`releaseStuckProcessingTags`), Key row "Contacts stuck mid-send". Importer: 0 rows => Warning heartbeat.
- Icons in `public/` (favicon.svg, apple-touch-icon.png), linked on all pages, CSP img-src 'self'.
- `any` removed from catches (`lib/errors.ts`) and GHL JSON; TODOs moved here. 190 tests, tsc, lint pass.
- MTS fixture test now exists (mts-sync/fixtures). NOT done: browser motion capture (no browser), compare model eval, two-part booking SMS (optional).

## Open questions (moved from the company config)
- Should the agent trust the lead's Serviceable Yes/No/Possibly field or re-derive it from a city list?
- What should "Prohibit Sales Outside Areas = No" mean for how cautious the AI is about serviceability?
- Mountain High's standard roll-off terms (overweight, extra days, damage, placement, cancellation) are still missing (`standardTerms: null`).

## Excellence fix round 3 (69 -> ?), 2026-10-22, done in code
- Docs/workflow comments match the live deployment; Latest Update is "replace each round".
- `/` redirects to /dashboard, unknown paths get a branded 404 (`api/notFound.ts`, last rewrite in vercel.json).
- One design: `lib/siteStyle.ts` shared by /dashboard, /admin, 404; cross-links; staggered rows, count-up totals, bars via scaleX, sign-in loading state.
- Follow-up drafts now come after the DRY_RUN and consent gates; two `(err as Error)` spots use `errorMessage`.
- NOT done (needs real systems or a decision): live smoke test, kill-switch flip, real restore drill and Vercel rollback (docs/live-smoke.md); real cost per purpose on a page; held-out eval set; manual contract page keep/remove decision.

## Not done / open
- Booking email still goes to `t@thomasewright.com` (lib/companies.ts) although Thomas ticked off the customer team's address: need the address.
- Admin GHL check calls `/locations/{id}`; confirm the token can read it.
- CEO's TCPA consent and standard terms (`standardTerms: null`) and fee prices; privacy notice for IP/browser.
- Decide whether to keep the manual e-sign page (`api/contract.ts`, `scripts/createContract.ts`); remove if nobody uses it.

# Mountain High Roll-Off Bot: STATE

Texts people who start booking a roll-off dumpster on mountainhighdisposal.com but don't finish, answers replies, and books in the text thread: code-written summary, full-name signature, office takes the card and enters the MTS contract. Never sends a link or takes a card. Mountain High Disposal only, Colorado only, Loveland blocked.

## Status (2026-11-04): LIVE since 2026-11-03
- Live at https://mountain-high-rolloff-bot.vercel.app (/dashboard, /admin, /admin/status.json), texting real leads on the shared GHL number. DRY_RUN is `false` (GitHub repo variable and Vercel) and `ROLLOFF_TCPA_CONSENT_CONFIRMED=true` (lib/rollOff.ts, PR #15). Kill switch: https://rolloff-killswitch.vercel.app/flag.json, tested 2026-10-22.
- Runs every 30 minutes (GitHub schedule, often throttled, plus Thomas's outside timer dispatching the workflow). Alerts: failures go to /admin/status.json, which Thomas's CAO reads (README "Who gets alerted"); no HITTA_API_KEY.
- Checks: `npm test`, `npm run typecheck`, `npm run lint`, `npm run deadcode` (knip) in CI. CI also fails until docs/eval-results.md matches the current prompts and models (lib/evalFingerprint.test.ts).
- What has and hasn't been tried on the live systems: docs/live-smoke.md.

## Parts
- GitHub Actions every 30 min: `mts-sync/importRollOffLeads.ts` then `sendRollOffTexts.ts` (also drains replies parked during a pause and checks for unanswered replies). Daily `backup-blobs.yml`. Model check (`eval-drafts.yml`) by hand.
- Vercel: `api/webhook.ts` (replies, via `lib/inbound.ts`), `api/dashboard.ts`, `api/admin.ts` (+ `/admin/status.json`, lowercase enums), branded 404.
- Safety: kill switch (fails closed when live), DRY_RUN (repo variable), consent flag, `lib/draftChecks.ts` on every model-written text before it is sent.
- Blob folders: `lib/blobNamespace.ts`; workflows set `BLOB_NAMESPACE=production` so job and Vercel share `status/`, `funnel/`, `parked/`, `quality/`.

## Earlier rounds
Kill switch, status page, backups, reply lock, eval, prompt caching, booking by text: see git history and docs/eval-results.md.

## Shared number with the residential bot (2026-10-21)
- Both bots send from the same GHL location with no `fromNumber`, so both use the location's default number. Kaizen has no idea roll-off tags exist, so this bot steps aside for anyone tagged `ai-outreach-eligible`: not imported (one note + `ai-rolloff-skipped-residential`), not texted, replies skipped.

## Booking by text (2026-10-21)
- Thomas: no links; book in the thread like residential. `lib/rollOffBooking.ts` (answers, summary, signature, notes), `lib/rollOffReply.ts` (flow), `lib/rollOffPrompt.ts` (modes). The e-sign link path and the manual contract page are gone (page removed 2026-11-04).
- MTS roll-off form requires a card (Thomas's test), so no automatic MTS submit: on signing the office gets a note + star and enters it. Summary covers all 7 MTS Agreements. Delivery Type is always Default Delivery.
- 2026-10-22: each signed booking is emailed via GHL (`sendEmail`, type Email) with every MTS field but the card. Recipient: the `ROLLOFF_BOOKING_EMAIL` setting, else `rollOff.bookingEmail` (t@thomasewright.com, a stand-in that /admin flags). Recipient contact found by email first so it isn't renamed.

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

## Open questions
- Should the agent trust the lead's Serviceable Yes/No/Possibly field or re-derive it from a city list?
- What should "Prohibit Sales Outside Areas = No" mean for how cautious the AI is about serviceability?

## Excellence fix round 3 (69 -> ?), 2026-10-22, done in code
- Docs/workflow comments match the live deployment; Latest Update is "replace each round".
- `/` redirects to /dashboard, unknown paths get a branded 404 (`api/notFound.ts`, last rewrite in vercel.json).
- One design: `lib/siteStyle.ts` shared by /dashboard, /admin, 404; cross-links; staggered rows, count-up totals, bars via scaleX, sign-in loading state.
- Follow-up drafts now come after the DRY_RUN and consent gates; two `(err as Error)` spots use `errorMessage`.
- NOT done (needs real systems or a decision): live smoke test, kill-switch flip, real restore drill and Vercel rollback (docs/live-smoke.md); real cost per purpose on a page; held-out eval set; manual contract page keep/remove decision.

## Review fix round (65 -> ?), 2026-11-04
- New delivery address or a change after the summary goes to the office, never "confirmed". Importer never overwrites a GHL contact (blank fields only), restarts a returning lead after 30 days, caps only new pick-ups.
- Every model draft is checked before sending (held drafts go to the office; /admin "Reply quality"). No links of any kind.
- Replies during a pause are parked and answered after; unanswered replies (>15 min) mark "Replies answered" Down.
- Booking email setting `ROLLOFF_BOOKING_EMAIL`; manual contract page removed; /admin readable on phones; dead code removed (knip in CI); Anthropic SDK 1.x.
- Held-out eval set, eval fingerprint gate in CI, model alias decision recorded (re-check 2027-02-01).

## Not done / open
- Booking email still goes to `t@thomasewright.com`: need the customer team's address (set `ROLLOFF_BOOKING_EMAIL` in Vercel).
- Confirm the CAO is polling /admin/status.json and that a Down reaches Thomas (docs/live-smoke.md).
- Live smoke test, restore drill and Vercel rollback still to run (docs/live-smoke.md).
- CEO's standard terms beyond the MTS Agreements, if there are any.

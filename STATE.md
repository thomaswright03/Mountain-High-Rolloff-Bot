# Mountain High Roll-Off Bot: STATE

Texts people who start booking a roll-off dumpster on mountainhighdisposal.com but don't finish, answers replies, and books in the text thread: code-written summary, full-name signature, office takes the card and enters the MTS contract. Never sends a link or takes a card. Mountain High Disposal only, Colorado only, Loveland blocked.

## Status (2026-10-21): TEST MODE, not deployed
- Reads real MTS leads; texts no one; writes nothing to GHL (replies included).
- Not on Vercel yet; GHL not connected; texting, replies and contracts never run against real systems.
- Tests: `npm test` (186), `npm run typecheck`, `npm run lint` (typescript-eslint, floating promises) pass. CI runs all three.

## Parts
- GitHub Actions every 10 min: `mts-sync/importRollOffLeads.ts` then `sendRollOffTexts.ts`. Daily `backup-blobs.yml`.
- Vercel: `api/webhook.ts` (replies), `api/contract.ts` (e-sign), `api/dashboard.ts`, `api/admin.ts` (+ `/admin/status.json`, lowercase enums).
- Safety: kill switch (fails closed when live), DRY_RUN (repo variable), `ROLLOFF_TCPA_CONSENT_CONFIRMED=false` in `lib/rollOff.ts`.
- Blob folders: `lib/blobNamespace.ts`; workflows set `BLOB_NAMESPACE=production` so job and Vercel share `status/`, `pending/`, `contracts/`.

## Round 1 (53 -> 58) done
Kill switch fail-closed; job failure alerts; /admin + JSON + Latest Update; contract notice retry; test-mode gating; CI.

## Round 2 (fix of the 58/100 grade), done in code
- High 1: shared Blob namespace (tests in `lib/blobNamespace.test.ts`).
- High 2: backup job + restore script (`lib/backup.ts`, `scripts/backupBlobs.ts`, `restoreBlobs.ts`), "Latest backup" row on /admin, README restore steps. Restore only tested against an in-memory store, not the real one.
- High 3: stale-run => `overall: down` after 60 min (tested); README "Who gets alerted" names the path (Hitta on failure, CAO reads status.json for silence).
- Medium 4-6: lowercase JSON; kill-switch pause shows Warning on "Scheduled texts"; test-mode row reports real effect; clean `rollOff.serviceArea` in the prompt.
- Medium 7: `npm run eval` + `lib/draftChecks.ts` written; ran live 2026-10-22 (docs/eval-results.md). Model still the alias; `CLAUDE_MODEL_ID` env pins a snapshot.
- Medium 8: per-message reply lock (`lib/replyLock.ts`, Blob `reply-locks/`), concurrent-delivery test.
- Low 10-12, 14 fixed (README, stale refs, CSP style, log retention documented).

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

## Not done / open
- Medium 9: no live GHL/Blob reads yet (not deployed). MTS scraper fixture needs real HTML.
- Run `npm run eval` once with a key and commit `docs/eval-results.md`; measure cost per conversation.
- Admin GHL check calls `/locations/{id}`; confirm the token can read it once GHL is connected.
- Thomas: kill-switch flag + `KILLSWITCH_URL`; deploy to Vercel with secrets (`ADMIN_STATUS_TOKEN`, `BLOB_READ_WRITE_TOKEN` also as GitHub secret); `HITTA_API_KEY` GitHub secret; CEO's TCPA consent; standard terms and fee prices; branch protection; privacy notice for IP/browser.

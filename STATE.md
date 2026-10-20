# Mountain High Roll-Off Bot: STATE

Texts people who start booking a roll-off dumpster on mountainhighdisposal.com but don't finish, answers replies, can text a contract to e-sign. Never books anything itself. Mountain High Disposal only, Colorado only, Loveland blocked.

## Status (2026-10-20): TEST MODE, not deployed
- Reads real MTS leads; texts no one; writes nothing to GHL (replies included).
- Not on Vercel yet; GHL not connected; texting, replies and contracts never run against real systems.
- Tests: `npm test` (151) and `npm run typecheck` pass. CI (`.github/workflows/ci.yml`) runs both.

## Parts
- GitHub Actions every 10 min: `mts-sync/importRollOffLeads.ts` then `sendRollOffTexts.ts`.
- Vercel: `api/webhook.ts` (replies), `api/contract.ts` (e-sign), `api/dashboard.ts`, `api/admin.ts` (+ `/admin/status.json`).
- Safety: kill switch (fails closed when live), DRY_RUN (repo variable), `ROLLOFF_TCPA_CONSENT_CONFIRMED=false` in `lib/rollOff.ts`.

## Excellence round 1 (fix of the 53/100 grade), done
Kill switch fail-closed + tests; DRY_RUN from repo variable; job exits non-zero on errors, send step runs after pick-up failure, Hitta alert step; `/admin` + JSON + Latest Update; signed-contract GHL notice retried/parked/retried (`lib/pendingNotices.ts`); reply-path GHL writes gated on DRY_RUN; GHL timeout + retry (never for texts); funnel `contract-sent` event; one model constant, token logging, offline eval set; webhook errors generic; CI; this file.

## Not done / open
- MTS scraper fixture test: needs saved real HTML from the roll-off leads page (don't have it).
- Live eval of drafts against Claude and measured cost per conversation (token logs now exist, `claude_usage` events).
- Admin GHL check calls `/locations/{id}`; confirm the token can read it once GHL is connected.
- Thomas: host kill-switch flag + set `KILLSWITCH_URL`; deploy to Vercel with secrets (incl. `ADMIN_STATUS_TOKEN`, `BLOB_READ_WRITE_TOKEN` as a GitHub secret); add `HITTA_API_KEY` GitHub secret; CEO's written TCPA consent; Mountain High's standard terms and fee prices; privacy notice for IP/browser in e-sign records.

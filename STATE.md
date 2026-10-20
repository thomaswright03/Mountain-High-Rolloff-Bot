# Mountain High Roll-Off Bot: STATE

Texts people who start booking a roll-off dumpster on mountainhighdisposal.com but don't finish, answers replies, can text a contract to e-sign. Never books anything itself. Mountain High Disposal only, Colorado only, Loveland blocked.

## Status (2026-10-21): TEST MODE, not deployed
- Reads real MTS leads; texts no one; writes nothing to GHL (replies included).
- Not on Vercel yet; GHL not connected; texting, replies and contracts never run against real systems.
- Tests: `npm test` (163) and `npm run typecheck` pass. CI (`.github/workflows/ci.yml`) runs both.

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
- Medium 7: `npm run eval` + `lib/draftChecks.ts` written; NOT yet run (needs ANTHROPIC_API_KEY), so `docs/eval-results.md` does not exist. Model still the alias; `CLAUDE_MODEL_ID` env pins a snapshot.
- Medium 8: per-message reply lock (`lib/replyLock.ts`, Blob `reply-locks/`), concurrent-delivery test.
- Low 10-12, 14 fixed (README, stale refs, CSP style, log retention documented).

## Not done / open
- Low 13: a stuck `ROLLOFF_PROCESSING_TAG` is still only logged.
- Medium 9: no live GHL/Blob reads yet (not deployed). MTS scraper fixture needs real HTML.
- Run `npm run eval` once with a key and commit `docs/eval-results.md`; measure cost per conversation.
- Admin GHL check calls `/locations/{id}`; confirm the token can read it once GHL is connected.
- Thomas: kill-switch flag + `KILLSWITCH_URL`; deploy to Vercel with secrets (`ADMIN_STATUS_TOKEN`, `BLOB_READ_WRITE_TOKEN` also as GitHub secret); `HITTA_API_KEY` GitHub secret; CEO's TCPA consent; standard terms and fee prices; branch protection; privacy notice for IP/browser.

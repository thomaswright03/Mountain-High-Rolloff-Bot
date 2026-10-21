# Mountain High Roll-off Bot

Texts people who start booking a roll-off dumpster on
mountainhighdisposal.com (MTS's roll-off booking widget) and don't finish,
and books the dumpster with them right in the text thread. It never sends a
link and never takes a card: the lead signs a code-written summary by
texting their full name, and the office calls to take the card and enter
the contract in MTS.

Split out of the Kaizen lead-responder repo (Mountain High's residential
trash bot) on 2026-10-10. Both bots share the same GHL location and MTS
login; they're kept apart by GHL tags.

## How it works

- **Who it texts:** GHL contacts tagged `ai-rolloff-eligible`.
  `mts-sync/importRollOffLeads.ts` applies the tag. Every 10 minutes it reads
  MTS's Manage Roll-Off Leads page (`/rolloffleads/list`) and picks up Mountain
  High leads that are New or Follow-Up, serviceable, and dated today or
  yesterday. The old backlog is never picked up, and neither is Loveland or
  anyone out of state. The residential bot (Kaizen) skips these contacts.
- **Scheduled texts:** `mts-sync/sendRollOffTexts.ts`, run every 10 minutes by
  `.github/workflows/send-rolloff-texts.yml`. A fixed first text 30+ minutes
  after the lead lands, a nudge the next day, a final nudge 3 days later, then
  nothing. Texts only go out 8am-10pm Denver time, never to Loveland or out of
  state, and never once MTS shows a contract made since they started.
- **Replies:** `api/webhook.ts` (a Vercel function) calls
  `lib/rollOffReply.ts`. Contacts without the roll-off tag are ignored.
  STOP and similar opt out. Card numbers, legal threats, a request for a
  person and the like go straight to the office (tagged `ai-needs-human` and
  starred). Once a rep texts in a thread, the bot stays out of it.
- **Booking by text** (Thomas, 2026-10-21, `lib/rollOffBooking.ts`): a
  separate model call reads what the lead has said so far, and the bot asks
  for whatever MTS's New Roll-Off Contract form still needs, one question at
  a time: size, business or personal, where to put it, and whether to call
  before delivery. Name, address, phone and email come from the contact on
  file. Material is always MSW and Sales Medium is Door to Door.
- **The summary** is written by code, never the model: size and price,
  drop-off window, address, placement, use, the call-before-delivery
  choice, and every term on the MTS contract's Agreements list (specific
  day $100, overweight fees by size, overfill $100, street permit, pickup on
  day 7, not allowed items, payment by phone). It ends by asking for their
  full name.
- **The signature:** their reply must be the first and last name on file,
  right after that exact summary (checked by code; "yes" never signs).
  What's recorded is read back out of the summary they signed. The contact
  is tagged `ai-rolloff-confirmed`, gets a JSON booking note
  (`AI_ROLLOFF_BOOKING_V1:`) and a field-by-field note for the office, and
  the conversation is starred. MTS won't save a roll-off contract without a
  card, so the office calls, takes the card and enters it. If anything on
  file is missing, the office finishes the booking instead.
- **Facts the bot may state:** `rollOff` in `lib/companies.ts`: sizes, the
  CEO's per-dump prices and weight limits, the 7-day rental, what can't go
  in, and the fees from the MTS contract's Agreements. Anything else (the
  daily rate past 7 days) goes to the office.

## Contract signing page

Thomas, 2026-10-10: a page where a lead reads and e-signs their roll-off
contract, at `/contract/{id}?t={token}` (`api/contract.ts`). Since
2026-10-21 the bot no longer texts these links (it books by text instead);
the page and `npm run contract:create` still work for the office to use by
hand.

- **The contract** (`lib/contract.ts`) is built by code from the brand's
  config: size, the CEO's per-dump price and weight limit, the 7-day rental,
  what can't go in, the service address and requested delivery date. It
  says that signing doesn't take payment: the office calls to take the card
  and confirm the date. Until Mountain High's own standard terms are added
  (`rollOff.contract.standardTerms` in `lib/companies.ts`), every contract is
  marked as a test, not binding.
- **Download for AI** gives the exact contract as a Markdown file, with a
  short note asking the customer's AI to explain it.
- **Signing** takes a typed name, a drawn signature and an e-sign consent
  box. The signature is only accepted for the exact text shown, and only
  once. The signature record (name, image, time, IP, browser, the
  contract's SHA-256) and a signed copy (contract plus signature plus
  signing record) are stored together in the private Vercel Blob store,
  and the signer can download the signed copy.
- **After signing**, outside DRY_RUN, the GHL contact gets a note and the
  `ai-rolloff-contract-signed` and `ai-needs-human` tags, so the office
  takes it from there.
- **Trying it by hand:** `npm run contract:create -- --yards=20
  --name="Test Person" --phone=+15555550100
  --address="12 Elm St, Greeley, CO 80631" --date=2026-10-20` prints a
  signing link.

## Dashboard

Thomas, 2026-10-10: a page showing how many roll-off leads the bot has
reached and how many roll-off contracts have been signed, laid out like the
Kaizen lead-responder dashboard but counting roll-off leads only. It's at
`/dashboard` (`api/dashboard.ts`, numbers from `api/dashboardData.ts`).

- **Sign-in:** a password form. Set `DASHBOARD_PASSWORD` in Vercel (12+
  characters). Signing in sets a signed, HttpOnly cookie for 30 days; nothing
  secret ever goes in the URL, unlike Kaizen's `?secret=` dashboard.
  Changing the password signs everyone out.
- **What it counts,** per Denver day, each on the day it happened: Reached
  (the bot's first text to a lead), Responded (the lead's first text back),
  Contracts sent (a booking summary texted, or before 2026-10-21 a signing
  link) and Signed (a summary signed by name, or a signed contract page). A window picker
  shows the last 7 to 90 days.
- **Where the numbers come from:** the same private Blob store as the
  contracts (`lib/funnelStore.ts`). `sendRollOffTexts.ts` records a lead's
  first text and `api/webhook.ts` their first reply, as one small file per
  lead under `funnel/`; contracts are counted from the contract files. In
  test mode (DRY_RUN) nothing is recorded, so Reached and Responded stay at
  0 until the bot goes live. For the scheduled job to record first texts,
  add the Blob store's `BLOB_READ_WRITE_TOKEN` as a GitHub Actions secret
  too; without it texts still go out, they just aren't counted.

## Before it goes live

1. **Test mode for now (Thomas, 2026-10-10).** The workflow runs with
   `DRY_RUN` true unless the GitHub repo *variable* `DRY_RUN` says otherwise
   (Settings > Secrets and variables > Actions > Variables), so switching
   needs no commit. In test mode it only logs what it would pick up and send,
   and writes nothing to GHL, replies included (opt-out and hand-off tags and
   notes are logged, not written). Set the same `DRY_RUN` in Vercel.
2. `ROLLOFF_TCPA_CONSENT_CONFIRMED` in `lib/rollOff.ts` stays
   `false` until Mountain High's CEO OKs texting these leads.
3. **Kill switch.** Host a `{"active":true}` file and set `KILLSWITCH_URL`
   (GitHub secret and Vercel env var). Flip it to `{"active":false}` to stop
   the importer, the sender and the reply webhook with no deploy. It fails
   closed: with test mode off, a missing, unreachable or erroring flag means
   paused (in test mode a missing URL is allowed; a URL that can't be reached
   is still paused).
4. **Failure alerts.** A failed or partly failed run fails the GitHub job and
   a last step posts to Hitta (`HITTA_API_KEY` secret; without it the run log
   shows a warning). The send step runs even when pick-up failed.
5. The first test-mode runs should be checked against the real MTS page:
   the lead pick-up was built from a screenshot, not the page's HTML.

## Status page

`/admin` (sign in with `DASHBOARD_PASSWORD`) and `/admin/status.json` (also
`Authorization: Bearer $ADMIN_STATUS_TOKEN`, 16+ characters). Groups
Important, Key and Basic; each row has a status, last checked and last
success in Denver time. Job and service results are recorded in the Blob
store (`lib/runStatus.ts`) and anything stale shows Warning, Down or
Unknown. The Latest Update section reads `lib/latestUpdate.ts`: add an entry
each round. Signed contracts whose GHL note failed are parked in Blob and
retried by the scheduled job; any still waiting show on the page.

## Who gets alerted

- A failed or partly failed scheduled run: the last workflow step posts to
  Hitta, which tells Thomas (needs the `HITTA_API_KEY` secret).
- A job that simply stops running (GitHub disables schedules on inactive
  repos, or Actions has an outage) cannot alert itself. `/admin/status.json`
  turns `overall` to `down` once the pick-up or texting job has not run for
  60 minutes (`warning` after 30). The COO/CAO health check reads that URL
  (with the `ADMIN_STATUS_TOKEN` bearer token) and reports a `down` to Thomas.
  Values are lowercase: `ok|warning|down|unknown`, tiers
  `important|key|basic`.
- A run paused by the kill switch shows "Scheduled texts: Warning".
- A failed or stale daily backup shows on `/admin` as "Latest backup".

## Backup and restore

`.github/workflows/backup-blobs.yml` copies `contracts/`, `pending/` and
`funnel/` from the Blob store every day into a GitHub Actions artifact
named `blob-backup` (kept 90 days) and records the "Latest backup" row on
`/admin` (Warning after 30 hours, Down after 54). Run it by hand any time:
`BLOB_READ_WRITE_TOKEN=... BLOB_NAMESPACE=production npm run backup`.

Restore: download the artifact, unzip it to a folder, then
`npm run restore -- <folder> restore-test/` puts every file under a scratch
prefix (`restore-test/contracts/<id>/signed.html` opens the signed copy).
For a real restore leave the prefix off; it never overwrites existing files.
The copy and restore code is covered by `lib/backup.test.ts`; a restore
against the real store has not been run yet (the store isn't set up).

## Model checks

`npm test` checks the prompt and the safety rules offline.
`npm run eval` (needs `ANTHROPIC_API_KEY`) sends the tricky messages to the
real model, grades each draft with code (no URLs, only approved prices, no
date promises, no "booked", admits being an AI) and writes
`docs/eval-results.md`. Without the key locally, run the **Model check**
workflow from the Actions tab (`.github/workflows/eval-drafts.yml`): it
uses the repo's `ANTHROPIC_API_KEY` secret and prints the results to the
run log. Re-run after any prompt or model change. The model
is the alias `claude-sonnet-5`; set `CLAUDE_MODEL_ID` to a dated snapshot to
pin it.

## Logs

Logs are JSON lines on stdout: Vercel keeps them only a short time (check
the plan's retention) and GitHub Actions keeps run logs 90 days. The
durable records are the Blob store (contracts, signatures, funnel counts)
and the GHL notes and tags the bot writes on every send and hand-off.

## Setup

1. `npm ci`, copy `.env.example` to `.env.local` and fill it in.
2. Deploy to Vercel (`vercel deploy --prod`) and set the same variables
   there. Connect a Blob store (Storage tab) for contracts and signatures.
3. In GHL, add a workflow: trigger **Customer Replied** (SMS), filtered to
   contacts with the `ai-rolloff-eligible` tag, action **Webhook** POST to
   `https://<vercel-domain>/api/webhook?secret=<WEBHOOK_SHARED_SECRET>` with
   contact ID, conversation ID, location ID, phone and message in the body.
4. Add the GitHub Actions secrets the workflow reads: `ANTHROPIC_API_KEY`,
   `MTS_EMAIL`, `MTS_PASSWORD`, `GHL_API_TOKEN`, `GHL_LOCATION_ID`,
   `GHL_COMPANY_FIELD_KEY`, `KILLSWITCH_URL`, `BLOB_READ_WRITE_TOKEN` (the
   Vercel project's Blob token) and `HITTA_API_KEY` (failure alerts). The
   workflows set `BLOB_NAMESPACE=production` so the job and the Vercel site
   use the same Blob folders (`status/`, `pending/`, `contracts/`); without
   it, or on a preview, everything goes to `test-` folders.
   Until they're added, the job skips the step that needs them instead of
   failing: lead pick-up needs the MTS login, texts need the GHL token and
   location ID.

## Checks

```
npm run typecheck
npm test
```

Tests mock GHL and Claude, so they need no keys.

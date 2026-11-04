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
  `mts-sync/importRollOffLeads.ts` applies the tag. Every 30 minutes it reads
  MTS's Manage Roll-Off Leads page (`/rolloffleads/list`) and picks up Mountain
  High leads that are New or Follow-Up, serviceable, and dated today or
  yesterday. The old backlog is never picked up, and neither is Loveland or
  anyone out of state. The residential bot (Kaizen) skips these contacts.
- **Scheduled texts:** `mts-sync/sendRollOffTexts.ts`, run every 30 minutes by
  `.github/workflows/send-rolloff-texts.yml`. A fixed first text on the first run
  after the lead lands, a nudge the next day, a final nudge a week later, then
  nothing. Texts only go out 8am-9pm Denver time, never to Loveland or out of
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
- **Changes after the summary** (2026-11-04): if a lead asks for a
  different delivery address or wants to change the booking, the bot never
  says it's changed. A different address hands the lead to the office
  (`ai-needs-human` tag, star, a note with the address they gave).
- **Every model-written text is checked before it's sent**
  (`lib/draftChecks.ts`: no links, only approved prices, no delivery-date
  promise, no "booked", no "changed", admits being an AI). A draft that
  fails is never sent: the lead goes to the office with a note, and /admin
  "Reply quality" shows the share held back over the last 7 days.
- **The booking email** (Thomas, 2026-10-22): each signed booking is also
  emailed through GHL to the `ROLLOFF_BOOKING_EMAIL` setting (Vercel), or
  to Thomas's own address (`rollOff.bookingEmail`) until the customer
  team's address is set; /admin "Booking email to the office" shows a
  warning while it's the stand-in. It lists every field on the
  MTS form except the card, in form order, plus the signed summary and a
  link to the GHL contact. It goes to the GHL contact with that email (one
  is created as "<company> Customer Team" if none exists; an existing one
  is never renamed). A failed send leaves a note on the lead. In dry run
  it only logs `rolloff_booking_email_dry_run`.
- **Facts the bot may state:** `rollOff` in `lib/companies.ts`: sizes, the
  CEO's per-dump prices and weight limits, the 7-day rental, what can't go
  in, and the fees from the MTS contract's Agreements. Anything else (the
  daily rate past 7 days) goes to the office.

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
  Booking summaries sent and Bookings signed (a summary signed by name). A window picker
  shows the last 7 to 90 days.
- **Where the numbers come from:** the private Vercel Blob store
  (`lib/funnelStore.ts`). `sendRollOffTexts.ts` records a lead's first text
  and `api/webhook.ts` their first reply and booking steps, as one small
  file per lead under `funnel/`. In test mode (DRY_RUN) nothing is
  recorded. The scheduled job needs the Blob store's
  `BLOB_READ_WRITE_TOKEN` as a GitHub Actions secret (set) to count first
  texts.

## Live, and how to stop it

The bot has been live since 2026-11-03: the GitHub repo variable `DRY_RUN`
and the Vercel `DRY_RUN` are `false`, and `ROLLOFF_TCPA_CONSENT_CONFIRMED`
in `lib/rollOff.ts` is `true`.

1. **Kill switch (fastest, no deploy).** `KILLSWITCH_URL` (GitHub secret
   and Vercel env var) points at https://rolloff-killswitch.vercel.app/flag.json.
   Set it to `{"active":false}` to stop the importer, the sender and the
   reply webhook. Replies that arrive while paused are parked (Blob
   `parked/`), shown on /admin as "Texts waiting from a pause", and answered
   by the next run after it's switched back on if they're under 12 hours
   old; older ones go to the office. It fails closed: with DRY_RUN off, a
   missing or unreachable flag means paused. Tested 2026-10-22
   (docs/live-smoke.md).
2. **Test mode.** Set the repo variable `DRY_RUN` back to `true` (and the
   Vercel one): everything is logged, nothing is written to GHL.
3. **Consent flag.** Set `ROLLOFF_TCPA_CONSENT_CONFIRMED` to `false` to stop
   scheduled texts with a deploy (replies keep going).
4. **Rolling back a bad deploy:** docs/live-smoke.md.
5. Lead pick-up is tested against a saved copy of the real MTS leads page
   (`mts-sync/fixtures/rolloff-leads.html`, 2026-10-22). If MTS changes
   the page, /admin "Lead pick-up from MTS" warns on 0 rows; save it again.

## Status page

`/admin` (sign in with `DASHBOARD_PASSWORD`) and `/admin/status.json` (also
`Authorization: Bearer $ADMIN_STATUS_TOKEN`, 16+ characters). Groups
Important, Key and Basic; each row has a status, last checked and last
success in Denver time. Job and service results are recorded in the Blob
store (`lib/runStatus.ts`) and anything stale shows Warning, Down or
Unknown. The Latest Update section reads `lib/latestUpdate.ts`: replace the entry
each round (only the current round is shown).

## Who gets alerted

**Thomas**, through one path: his CAO health check reads
`/admin/status.json` (bearer `ADMIN_STATUS_TOKEN`), reports a problem to
Hitta, and Hitta tells him. There is no `HITTA_API_KEY` in the workflows
(Thomas's decision, 2026-10-21): every failure is written to the status
page instead, so the one check sees all of it.

- **A failed scheduled run:** the job's own code marks its row Down, and
  if a step failed anyway, the last workflow step
  (`scripts/recordFailedRun.ts`) marks it Down. "Lead pick-up from MTS"
  and "Scheduled texts" are Important rows, so `overall` turns `down`
  straight away.
- **A job that stops running** (GitHub throttles or disables schedules,
  Actions is down): `overall` turns `warning` once pick-up or texting has
  not run for 60 minutes and `down` after 120 (`lib/adminStatus.ts`).
- **Replies:** a webhook error marks "Replies answered" Down. If GHL stops
  calling the webhook, each texting run checks for leads whose last text
  has gone unanswered for more than 15 minutes and marks "Replies
  answered" Down within 120 minutes.
- **The daily backup:** a failure marks "Latest backup" Down (Key row, so
  `overall` is `warning`); no backup for 30 hours is a Warning, 54 hours
  Down.
- A run paused by the kill switch shows "Scheduled texts: Warning".

Values are lowercase: `ok|warning|down|unknown`, tiers `important|key|basic`.
Whether the CAO is polling and an alert reaches Thomas is recorded in
docs/live-smoke.md.

## Backup and restore

`.github/workflows/backup-blobs.yml` copies the saved records (`funnel/`,
`parked/`, `quality/`, and any old `contracts/`) from the Blob store every day into a GitHub Actions artifact
named `blob-backup` (kept 90 days) and records the "Latest backup" row on
`/admin` (Warning after 30 hours, Down after 54). Run it by hand any time:
`BLOB_READ_WRITE_TOKEN=... BLOB_NAMESPACE=production npm run backup`.

Restore: download the artifact, unzip it to a folder, then
`npm run restore -- <folder> restore-test/` puts every file under a scratch
prefix. For a real restore leave the prefix off; it never overwrites
existing files. The copy and restore code is covered by
`lib/backup.test.ts`; the restore drill against the real store is recorded
in docs/live-smoke.md.

## Model checks

`npm test` checks the prompt and the safety rules offline. The **Model
check** workflow (`.github/workflows/eval-drafts.yml`, Actions tab, uses the
repo's `ANTHROPIC_API_KEY` secret, sends no texts) runs `npm run eval`:

- a **tuning set** (`EVAL_CASES` in `lib/draftChecks.ts`), the messages the
  prompt was written against;
- a **held-out set** (`lib/heldOutCases.ts`), whole threads in each reply
  mode (new address, change after the summary, after signing, wrong name)
  that are never used to tune the prompt;
- the cheap model's two jobs (reading booking answers, spotting a
  hand-off) against known answers.

Each draft is graded by the same code checks that run before every live
text. It writes `docs/eval-results.md` with the run link, commit and
results. **CI enforces it:** `lib/evalFingerprint.test.ts` hashes every
prompt, customer text, approved fact, both eval sets and both model IDs, and
fails until `docs/eval-results.md` was written for that exact hash with
every case passing. So after a prompt, text, fact or model change, run the
Model check on the branch and commit the `docs/eval-results.md` from its
artifact.

Models: `claude-sonnet-5` (`CLAUDE_MODEL_ID`) writes replies and nudges;
`claude-haiku-5-5` (`CLAUDE_CHEAP_MODEL_ID`) does the hand-off yes/no and
reads booking answers (set it to `claude-sonnet-5` to roll back). Neither
has a dated snapshot ID to pin (the API serves the alias as is), so the
decision is recorded in `lib/claude.ts` with a re-check date of
2027-02-01, and drift is caught by the checks before every text plus the
"Reply quality" row on /admin (7-day share of drafts held back; Warning
above 10%).

## Logs

Logs are JSON lines on stdout: Vercel keeps them only a short time (check
the plan's retention) and GitHub Actions keeps run logs 90 days. The
durable records are the Blob store (funnel counts, parked replies,
reply-quality records) and the GHL notes and tags the bot writes on every send and hand-off.

## Setup

1. `npm ci`, then `npx playwright install chromium` (the lead-import test
   needs it), copy `.env.example` to `.env.local` and fill it in.
2. Deploy to Vercel (`vercel deploy --prod`) and set the same variables
   there. Connect a Blob store (Storage tab) for the saved records.
3. In GHL, add a workflow: trigger **Customer Replied** (SMS), filtered to
   contacts with the `ai-rolloff-eligible` tag, action **Webhook** POST to
   `https://<vercel-domain>/api/webhook?secret=<WEBHOOK_SHARED_SECRET>` with
   contact ID, conversation ID, location ID, phone and message in the body.
4. Add the GitHub Actions secrets the workflow reads: `ANTHROPIC_API_KEY`,
   `MTS_EMAIL`, `MTS_PASSWORD`, `GHL_API_TOKEN`, `GHL_LOCATION_ID`,
   `GHL_COMPANY_FIELD_KEY`, `KILLSWITCH_URL`, `BLOB_READ_WRITE_TOKEN` (the
   Vercel project's Blob token). The workflows set
   `BLOB_NAMESPACE=production` so the job and the Vercel site use the same
   Blob folders (`status/`, `funnel/`, `parked/`, `quality/`); without
   it, or on a preview, everything goes to `test-` folders.
   Until they're added, the job skips the step that needs them instead of
   failing: lead pick-up needs the MTS login, texts need the GHL token and
   location ID.

## Checks

```
npx playwright install chromium   # once, before npm test
npm run typecheck
npm run lint
npm run deadcode                  # knip: unused files and exports
npm test
```

Tests mock GHL and Claude, so they need no keys.

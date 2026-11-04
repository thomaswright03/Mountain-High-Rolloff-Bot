# Live smoke test record

The bot is live (since 2026-11-03), so these checks run on the real systems.
An unrun step is never claimed as done: fill in the date, link and result as
each one is run.

| # | Step | Status |
|---|---|---|
| 1 | Kill switch flip (scheduled run and webhook both paused, then back on) | **pass, 2026-10-22** (Thomas) |
| 2 | An alert reaches Thomas (CAO reads a Down on /admin/status.json) | not run |
| 3 | Full booking by text on a test contact | not run |
| 4 | Backup restore drill | not run |
| 5 | Vercel rollback and roll forward | not run |

## 1. Kill switch (pass, 2026-10-22)

Set https://rolloff-killswitch.vercel.app/flag.json to `{"active":false}`
(from `~/rolloff-killswitch` on Thomas's Mac, then `npx vercel@65.0.0 --prod`).
Both the scheduled run and the reply webhook paused. Flipped back to
`{"active":true}`. Since 2026-11-04, replies that arrive while
paused are parked and answered after; re-check that the next time it's
flipped.

## 2. Alert path

1. From the repo, with the production Blob token:
   `BLOB_READ_WRITE_TOKEN=... BLOB_NAMESPACE=production npx tsx scripts/recordFailedRun.ts rolloff-send "Alert test"`
2. `/admin` should show "Scheduled texts: Down" and `/admin/status.json`
   `"overall": "down"`.
3. Within the CAO's polling interval, Hitta should tell Thomas.
4. The next scheduled run clears it (its own result overwrites the row).

Record: date, when the alert arrived, result.

## 3. Full booking by text (from Thomas's phone)

The bot texts every eligible lead, so use a GHL contact that is only Thomas:

1. In GHL, create a contact with Thomas's mobile, first and last name, a
   full address (street, city, state, zip in the service area, not
   Loveland), and the tag `ai-rolloff-eligible`. No `ai-outreach-eligible`
   tag (the bot steps aside for residential contacts).
2. In Actions, run **Send roll-off texts** (or wait for the next run). The
   cold open arrives on Thomas's phone.
3. Reply, in separate texts: `yes I need a 20 yard`, `personal`,
   `driveway on the left`, `yes call me first`. The bot asks one thing at a
   time, then sends the summary ending "reply with your full name to sign".
4. Reply with the full name on the contact.
5. Check: the reply says "you're signed" and never "booked"; the contact has
   the `ai-rolloff-confirmed` tag, the `AI_ROLLOFF_BOOKING_V1:` note and the
   office note; the conversation is starred; the booking email arrived
   (subject "Roll-off booking to enter: ..."); /admin "Bookings signed by
   text" and "Booking email to the office" are OK; "Reply quality" counts
   the drafts.
6. Also try `can you bring it to 412 Oak St instead?` on a second run: the
   bot should say the office will call, and the contact gets
   `ai-needs-human` and a note with that address.
7. Delete the test contact (or remove the confirmed tag) so the office
   doesn't call.

Record: date, GHL contact link, result per check.

## 4. Backup restore drill

1. Actions, **Back up signed contracts**, latest run, download the
   `blob-backup` artifact and unzip it.
2. `BLOB_READ_WRITE_TOKEN=... BLOB_NAMESPACE=production npm run restore -- <folder> restore-test/`
3. In the Vercel Blob store, open one restored file under `restore-test/`
   and compare it with the original; then delete `restore-test/`.

Record: date, artifact run link, files restored, result.

## 5. Vercel rollback

1. Vercel, project `mountain-high-rolloff-bot`, Deployments: on the
   previous production deployment choose **Instant Rollback**.
2. `/admin` "Deployed version" shows the older commit.
3. On the current deployment choose **Promote** to roll forward, and check
   "Deployed version" again.

Do it outside 8am-9pm Denver time, when no texts go out. Record: date, both
commits, result.

# Live smoke test record

Nothing below has been run yet. Each step needs a real system (GHL, Blob, Vercel) and Thomas's own test contact; an unrun step is not claimed as done. Fill in the date, contact link and result as each is run.

| Step | How | Status |
|---|---|---|
| Full scripted conversation on a test contact (cold open, reply, summary, signature, notes, star, booking email) | `npm run rolloff:send -- --contact-id=<test contact>` with DRY_RUN off for that run; reply from the test phone | not run |
| /admin shows GHL, "Bookings signed by text", "Booking email to the office" OK | read `/admin/status.json` with the bearer token | not run |
| Kill switch flip: set the flag to `{"active":false}`, see /admin "Kill switch" Warning, next run logs `rolloff_text_service_paused`, flip back | live flag + Actions log | not run |
| Backup restore: download latest `blob-backup` artifact, `npm run restore -- <folder> restore-test/`, open one file | real Blob store | not run |
| Vercel rollback: promote previous deployment, then roll forward | Vercel dashboard | not run |

The consent gate (`ROLLOFF_TCPA_CONSENT_CONFIRMED` in lib/rollOff.ts) still blocks scheduled sends; the test contact run needs a per-contact allow-list or Thomas's approval to flip it briefly.

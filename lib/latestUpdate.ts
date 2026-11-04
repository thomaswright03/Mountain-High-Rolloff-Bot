/** Shown in the "Latest Update" section of /admin. Only the current round:
 * replace the entry each round with the date, the Frontend changes first
 * (kept separate), then every other change. Older rounds live in git history. */
export interface UpdateEntry {
  date: string;
  frontend: string[];
  changes: string[];
}

export const LATEST_UPDATES: UpdateEntry[] = [
  {
    date: "2026-11-04 (covers PR #18 from 2026-11-03, this round's review fixes, and fixes from Sam Fairchild's thread)",
    frontend: [
      "Texts customers get (PR #18): the booking question now asks whether they want the driver to call before drop-off, and says the driver calls from a different number. The summary line is now \"- the driver will call you before drop-off, from a different number than this one\" (was \"- we'll call before we deliver\") and the payment line is \"- the office will call you from a different number to take payment, nothing is charged by text\". The reply after signing now says \"the office will give you a call from a different number to take payment\". Whenever the bot mentions a call, it says the call comes from a different number. A summary sent with the old wording can still be signed.",
      "Texts customers get (this round): if a lead asks to deliver to a different address, the bot says the office will call to book it at that address, and never says the address is changed. If they ask to change something after the summary, the bot says the office will sort it out on a quick call, and never says it's changed or confirmed.",
      "Texts customers get (this round): every AI-written text is checked before it is sent (no links, only approved prices, no promised delivery day, never \"booked\" or \"changed\", admits being an AI when asked). A text that fails is not sent: the lead goes to the office instead.",
      "Texts customers get (this round): a lead whose reply came in while the bot was paused now gets an answer after it's switched back on (within 12 hours; older ones go to the office). A lead who comes back more than 30 days after their last pick-up gets the texts again as a new booking attempt.",
      "Texts customers get (from a real thread, Sam Fairchild, 2026-11-03): a signature with a short or long form of the first name on file now counts (\"Samuel\" for \"Sam\", \"Bob\" for \"Robert\"; the last name must match). The booking summary is no longer sent again after the bot answers a question. Before a booking is signed, a text saying \"you're all set\" or \"that locks in your booking\" is held back for the office. A lead who says they already booked or submitted the form online is handed to the office instead of being asked to sign again. The first time a lead shows interest, the bot says once \"I can get you signed up right here over text!\" before its question (Thomas's wording), so they don't leave to finish on the website.",
      "/admin: readable on a phone (each row stacks into a card), the row animation plays, and the wording is plain (no setting names).",
      "/admin new rows: \"Texts waiting from a pause\" and \"Reply quality\" (share of AI texts held back by the checks over 7 days). \"Replies answered\" goes Down if replies sit unanswered for over 15 minutes. \"Booking email to the office\" warns while it still goes to Thomas's stand-in address.",
      "The manual contract signing page is gone (bookings happen by text). The 404 page and the dashboard keep their own look and pass their security rules.",
    ],
    changes: [
      "Lead pick-up never overwrites a contact already in GHL: it only fills blank fields, and a residential customer just gets a note and the skipped tag. Only new pick-ups count toward the per-run cap.",
      "A failed scheduled run or backup now marks its row Down on /admin, which Thomas's CAO health check reads; the unused Hitta steps are gone.",
      "Booking email address can be set with ROLLOFF_BOOKING_EMAIL without a code change.",
      "Model check: new held-out set of whole conversations, separate from the tuning set; CI now fails until the Model check has been run on the current prompts, texts and models (run 2026-11-04: 12/12, 8/8 held out, 8/8 cheap model). The decision to stay on the model aliases is recorded with a re-check date of 2027-02-01.",
      "Dead code removed with a dead-code check in CI, Anthropic SDK upgraded to 1.x.",
      "README, STATE.md, workflow comments and docs/live-smoke.md describe the live setup, the alert path and the tests still to run.",
    ],
  },
];

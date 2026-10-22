/** Shown in the "Latest Update" section of /admin. Newest round first. Add an
 * entry each round: the date, the Frontend changes first (kept separate),
 * then every other change. */
export interface UpdateEntry {
  date: string;
  frontend: string[];
  changes: string[];
}

export const LATEST_UPDATES: UpdateEntry[] = [
  {
    date: "2026-10-22 (fourth round)",
    frontend: [
      "/admin: the \"Deployed version\" row now shows when the running version went live, in Denver time.",
      "/dashboard: the sign-in line now says \"bookings signed\" instead of \"contracts signed\", since bookings are signed by text.",
    ],
    changes: [
      "Model check re-run on the flat $85 fix (docs/eval-results.md): replies 12/12, booking answers and hand-off 8/8. The weight limit reply now says \"a flat $85 extra, not per ton\".",
      "When a scheduled text fails, the note left for the office is now plain language asking them to reach the person; the technical error stays in the logs.",
    ],
  },
  {
    date: "2026-10-22 (third round)",
    frontend: [
      "/admin: row names and details are now in plain business language, each saying what to do; technical names are no longer in the main text.",
      "/admin on a phone: each status now shows when it was last checked underneath it, instead of hiding the times.",
    ],
    changes: [
      "Model check results are committed (docs/eval-results.md): replies 12/12 on claude-sonnet-5, booking answers and the hand-off check 8/8 on the cheaper claude-haiku-5-5, with the served model IDs recorded. This validates the cheaper-model switch from the last round.",
      "The model check now also fails any reply that calls the 6 and 8 yard $85 overweight fee per ton; it is one flat charge, and the facts the AI is given now say so. The model check should be re-run to record this.",
      "The lead import is tested against a saved copy of the real MTS roll-off leads page (personal details swapped for fakes).",
      "The hand-off check was tightened: the case it must catch is now a lead who says they are done, and the eval records one accepted miss.",
      "README: setup and checks now list the one-time browser install (npx playwright install chromium) and the lead-import test explains the fix if it is missing; stale notes about screenshots and a dated model ID corrected.",
    ],
  },
  {
    date: "2026-10-22 (second round)",
    frontend: [
      "/admin, /dashboard and the signing page now show the Mountain High mark as the browser-tab icon (SVG favicon and an iPhone home-screen icon).",
      "/admin: new \"Contacts stuck mid-send\" row (Warning with a count), and \"Latest backup\" now shows the next expected run.",
    ],
    changes: [
      "Claude calls send the stable system prompt as a cached block and log cache read/write tokens; the yes/no handoff check and JSON extraction use the cheaper Haiku model (validated by npm run eval in the next round).",
      "A contact stranded with the processing tag is released and noted at the start of each live send run, then retried.",
      "A pick-up run that reads zero rows from the MTS table now shows as a Warning on /admin.",
      "Error handling and GHL responses are typed instead of any; developer TODOs moved out of the company config.",
    ],
  },
  {
    date: "2026-10-22",
    frontend: [
      "/admin: \"Contracts signable\" is replaced by \"Bookings signed by text\" (Important) and \"Booking email to the office\" (Key), both from recorded results; the old link-signing check is now \"Manual contract signing page\" (Basic) and can't take the overall status down.",
      "Dashboard: \"Contracts sent\" is now \"Booking summaries sent\" and \"Signed\" is \"Bookings signed\".",
      "Dashboard and /admin: short eased fade-ins, hover, focus and press states, all switched off when the device asks for reduced motion.",
    ],
    changes: [
      "Leads now book a roll-off in the text thread: the bot texts a summary written by code and a full-name reply signs it. No signing link is sent any more.",
      "Signed booking: booking note, office note, confirmed tag and star are written in that order and retried up to 3 times without duplicating notes, so a half-finished signing is never marked signed.",
      "Each signed booking is emailed to the customer team (still a test address) with every MTS field except the card; a failed email adds a note on the contact and shows on /admin.",
      "The bot no longer calls delivery free or rules out weekend days.",
      "The bot steps aside for leads the residential bot already owns (tagged ai-outreach-eligible).",
      "New \"Model check\" GitHub Actions workflow runs npm run eval.",
      "A linter (typescript-eslint, including floating-promise checks) now runs in CI.",
    ],
  },
  {
    date: "2026-10-21",
    frontend: [
      "/admin: the sign-in form is now the right width (its style was being blocked).",
      "/admin: new \"Latest backup\" row; \"Scheduled texts\" shows Warning when the kill switch has paused the bot; the test mode row says what it blocks.",
    ],
    changes: [
      "The scheduled job and the Vercel site now share the same Blob folders (BLOB_NAMESPACE), so /admin sees the job's results and parked contract notices get retried.",
      "Daily backup of signed contracts to a GitHub Actions artifact, with a restore script.",
      "/admin/status.json now uses lowercase status and tier values.",
      "Replies: two deliveries of the same text send one reply.",
      "The AI gets a clean roll-off service-area block (no residential or developer notes).",
      "npm run eval grades real model drafts with code checks; model can be pinned with CLAUDE_MODEL_ID.",
    ],
  },
  {
    date: "2026-10-20",
    frontend: [
      "New /admin status page (sign in with the dashboard password) and /admin/status.json: what is working, grouped Important, Key and Basic, with last checked and last success in Denver time.",
      "New Latest Update section on /admin (this list).",
      "The dashboard's \"Contracts sent\" now counts a contract only after its text went out.",
    ],
    changes: [
      "Kill switch fails closed: with test mode off, an unset, unreachable or erroring flag means paused. A configured flag that can't be reached always means paused.",
      "Test mode (DRY_RUN) is now the repo variable DRY_RUN in GitHub (default true), not a value in the workflow file.",
      "The scheduled job now exits with an error when any lead errored, still runs the text step if lead pick-up failed, and reports failures to Hitta (needs the HITTA_API_KEY secret).",
      "Every job, and Claude and reply handling, record a result that /admin reads.",
      "A signed contract whose GHL note fails is retried, then parked and retried by the scheduled job; anything still waiting shows on /admin.",
      "Test mode no longer writes opt-out or hand-off tags and notes to GHL on replies; it logs what it would write.",
      "GHL calls have a 10 second timeout and up to 3 tries on timeouts, 429 and 5xx (texts are never retried).",
      "The model name is one constant, each Claude call logs its token counts, and an offline set of tricky lead messages is tested.",
      "The webhook no longer returns internal error text.",
      "CI runs typecheck and tests on every push and pull request.",
    ],
  },
];

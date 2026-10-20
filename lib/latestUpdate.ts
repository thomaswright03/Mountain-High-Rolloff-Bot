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

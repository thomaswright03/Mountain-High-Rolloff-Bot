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
    date: "2026-10-22 (fifth round)",
    frontend: [
      "/admin: the \"Deployed version\" row now shows when the running version went live, in Denver time. It reads the optional DEPLOYED_AT setting and says so when it is not set.",
      "/admin: this Latest Update section now shows only the current round instead of every past round.",
      "/dashboard: the sign-in line now says \"bookings signed\" instead of \"contracts signed\", since bookings are signed by text.",
    ],
    changes: [
      "New optional settings: DEPLOYED_AT (when this version went live) and CLAUDE_CHEAP_MODEL_ID (the cheaper model for the yes/no hand-off check and small jobs; set it to claude-sonnet-5 to use one model for everything). Both are in .env.example and the README.",
      "The model check now fails any reply that pairs the $85 overweight fee with \"per ton\" (it is one flat $85 over 1 ton). It was re-run after that fix and docs/eval-results.md is committed: replies 12/12, booking answers and hand-off 8/8, no \"per ton\" next to $85.",
      "When a scheduled text fails, the GHL note for the office is plain language asking them to text or call the person; the technical error stays in the logs.",
    ],
  },
];

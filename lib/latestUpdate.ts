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
    date: "2026-10-22 (sixth round)",
    frontend: [
      "The bare web address now opens the dashboard, and any other unknown address shows a Mountain High page with links and the office phone instead of Vercel's error page.",
      "/admin and /dashboard now share one design: the same brand heading, cards, buttons and links between Dashboard and Status.",
      "Motion: status rows slide in one after another, dashboard totals count up, bars grow with a smooth stretch, and Sign in shows a pressed state while it works. All of it is off for people who ask for reduced motion.",
    ],
    changes: [
      "A scheduled run that is dry or blocked by the consent gate no longer asks the AI to write a follow-up, so it spends nothing.",
      "Two error messages in the send job now use the shared error helper.",
      "README, STATE.md and the workflow comments now describe the live site, not the old not-deployed state.",
    ],
  },
];

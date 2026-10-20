import "dotenv/config";
import { writeFileSync } from "node:fs";
import { findCompany } from "../lib/companies.js";
import { buildRollOffReplyPrompt } from "../lib/rollOffPrompt.js";
import { draftReply, CLAUDE_MODEL } from "../lib/claude.js";
import { EVAL_CASES, gradeDraft } from "../lib/draftChecks.js";

// Usage: ANTHROPIC_API_KEY=... npm run eval
// Sends each tricky lead message to the real model, grades the draft with
// code checks (lib/draftChecks.ts) and writes docs/eval-results.md. Costs a
// few cents; not part of `npm test`. Re-run after any prompt or model change.

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set.");
    process.exit(1);
  }
  const company = findCompany("Mountain High Disposal")!;
  const prompt = buildRollOffReplyPrompt(company, company.rollOff!, false);
  const rows: string[] = [];
  let failed = 0;
  for (const c of EVAL_CASES) {
    const history = `Lead: ${c.message}`;
    const draft = await draftReply(prompt, history, JSON.stringify({ first_name: "Sam" }));
    const problems = gradeDraft(draft, c);
    if (problems.length) failed++;
    rows.push(`| ${c.name} | ${problems.length ? "FAIL" : "pass"} | ${problems.join("; ") || "-"} | ${draft.replace(/\|/g, "/").replace(/\n/g, " ")} |`);
    console.log(`${problems.length ? "FAIL" : "pass"}  ${c.name}`);
  }
  const out = [
    "# Live draft eval",
    "",
    `Model: \`${CLAUDE_MODEL}\` · Run: ${new Date().toISOString()} · ${EVAL_CASES.length - failed}/${EVAL_CASES.length} passed`,
    "",
    "| Case | Result | Problems | Draft |",
    "|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
  writeFileSync(new URL("../docs/eval-results.md", import.meta.url), out);
  console.log(`Wrote docs/eval-results.md (${failed} failed)`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

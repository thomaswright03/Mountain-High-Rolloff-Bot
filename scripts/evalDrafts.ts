import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { findCompany } from "../lib/companies.js";
import { buildRollOffReplyPrompt } from "../lib/rollOffPrompt.js";
import { buildHandoffCheckPrompt } from "../lib/prompt.js";
import { HELD_OUT_CASES } from "../lib/heldOutCases.js";
import { customerFacingFingerprint } from "../lib/evalFingerprint.js";
import { buildBookingExtractionPrompt, parseBookingState, type BookingState } from "../lib/rollOffBooking.js";
import { draftReply, detectHandoff, extractJson, servedModels, CLAUDE_MODEL, CLAUDE_CHEAP_MODEL } from "../lib/claude.js";
import { EVAL_CASES, gradeDraft } from "../lib/draftChecks.js";

// The cheaper model's two jobs, each with a known right answer: reading the
// booking answers out of a thread, and spotting a hand-off to the office.
const t = (from: "lead" | "us", text: string) => JSON.stringify({ from, text });
const EXTRACTION_CASES: Array<{ name: string; conversation: string; expect: Partial<BookingState> }> = [
  { name: "picks a size", conversation: [t("us", "would you like a 6 yard, 8 yard, 20 yard, or 30 yard dumpster?"), t("lead", "yes I need a 20 yard for a garage cleanout")].join("\n"), expect: { wantsToBook: true, yards: 20 } },
  {
    name: "gives every answer",
    conversation: [
      t("us", "would you like a 6 yard, 8 yard, 20 yard, or 30 yard dumpster?"),
      t("lead", "the 8 yard"),
      t("us", "sweet, is this for personal use or a business? and where should we put it?"),
      t("lead", "personal, left side of the driveway. and yes call me before you come"),
    ].join("\n"),
    expect: { wantsToBook: true, yards: 8, customerType: "Personal", callBeforeDelivery: true },
  },
  { name: "says no", conversation: [t("us", "would you like a 6 yard, 8 yard, 20 yard, or 30 yard dumpster?"), t("lead", "no thanks, I found someone else")].join("\n"), expect: { wantsToBook: false, yards: null } },
  { name: "only asks a price", conversation: [t("us", "would you like a 6 yard, 8 yard, 20 yard, or 30 yard dumpster?"), t("lead", "how much is the 30 yard?")].join("\n"), expect: { yards: null } },
];
const HANDOFF_CASES: Array<{ name: string; draft: string; expect: boolean }> = [
  { name: "office takes over", draft: "no problem, the office will give you a call to sort that out", expect: true },
  // A friendly close after a "no" isn't required to count: missing it only
  // means the bot can still answer if they text again.
  { name: "says it's done texting", draft: "got it. I won't text you again, the office has your info if you ever need one", expect: true },
  { name: "keeps booking", draft: "the 20 yard is $400 per dump, up to 4 tons. is it for personal use or a business?", expect: false },
  { name: "defers one detail but keeps going", draft: "the office can give you the exact daily rate. where would you like it placed?", expect: false },
];

// Usage: ANTHROPIC_API_KEY=... npm run eval (or the Model check workflow)
// Sends each tricky lead message to the real model, grades the draft with
// code checks (lib/draftChecks.ts) and writes docs/eval-results.md: the
// tuning set (EVAL_CASES), then the held-out set (lib/heldOutCases.ts),
// graded separately. Costs a few cents; not part of `npm test`, but
// lib/evalFingerprint.test.ts fails CI until this has been run on the
// current prompts and models. Anything under "## Notes kept on record" in
// the old file is kept.

const NOTES_HEADING = "## Notes kept on record";
const cell = (s: string) => s.replace(/\|/g, "/").replace(/\n/g, " ");

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set.");
    process.exit(1);
  }
  const company = findCompany("Mountain High Disposal")!;
  const prompt = buildRollOffReplyPrompt(company, company.rollOff!, false);
  const fingerprint = customerFacingFingerprint();
  const rows: string[] = [];
  let failed = 0;
  // The transcript goes in exactly as lib/rollOffReply.ts sends it (formatHistory).
  for (const c of EVAL_CASES) {
    const history = JSON.stringify({ from: "lead", text: c.message });
    const draft = await draftReply(prompt, history, JSON.stringify({ first_name: "Sam" }));
    const problems = gradeDraft(draft, c);
    if (problems.length) failed++;
    rows.push(`| ${c.name} | ${problems.length ? "FAIL" : "pass"} | ${problems.join("; ") || "-"} | ${cell(draft)} |`);
    console.log(`${problems.length ? "FAIL" : "pass"}  ${c.name}`);
  }
  const heldRows: string[] = [];
  let heldFailed = 0;
  for (const c of HELD_OUT_CASES) {
    const history = [...c.thread, { from: "lead", text: c.message }].map((t) => JSON.stringify(t)).join("\n");
    const details = JSON.stringify({ first_name: "Sam", service_address: "12 Elm St, Greeley, CO 80631", ...c.details });
    const draft = await draftReply(buildRollOffReplyPrompt(company, company.rollOff!, false, c.mode), history, details);
    const problems = gradeDraft(draft, c);
    if (problems.length) heldFailed++;
    heldRows.push(`| ${c.name} | ${problems.length ? "FAIL" : "pass"} | ${problems.join("; ") || "-"} | ${cell(draft)} |`);
    console.log(`${problems.length ? "FAIL" : "pass"}  held out: ${c.name}`);
  }
  failed += heldFailed;
  const draftsServed = [...servedModels];
  servedModels.clear();

  const cheapRows: string[] = [];
  let cheapFailed = 0;
  const extractionPrompt = buildBookingExtractionPrompt(company);
  for (const c of EXTRACTION_CASES) {
    const state = parseBookingState(await extractJson(extractionPrompt, `Conversation:\n${c.conversation}\n\nOutput the JSON object now, and nothing else.`), company.rollOff!);
    const wrong = Object.entries(c.expect).filter(([k, v]) => state[k as keyof BookingState] !== v).map(([k, v]) => `${k}: expected ${v}, got ${state[k as keyof BookingState]}`);
    if (wrong.length) cheapFailed++;
    cheapRows.push(`| booking answers: ${c.name} | ${wrong.length ? "FAIL" : "pass"} | ${wrong.join("; ") || "-"} |`);
    console.log(`${wrong.length ? "FAIL" : "pass"}  booking answers: ${c.name}`);
  }
  const handoffPrompt = buildHandoffCheckPrompt();
  for (const c of HANDOFF_CASES) {
    const got = await detectHandoff(handoffPrompt, c.draft);
    if (got !== c.expect) cheapFailed++;
    cheapRows.push(`| hand-off: ${c.name} | ${got === c.expect ? "pass" : "FAIL"} | ${got === c.expect ? "-" : `expected ${c.expect}, got ${got}`} |`);
    console.log(`${got === c.expect ? "pass" : "FAIL"}  hand-off: ${c.name}`);
  }
  const cheapTotal = EXTRACTION_CASES.length + HANDOFF_CASES.length;

  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_SHA, GITHUB_REF_NAME } = process.env;
  const where = GITHUB_RUN_ID
    ? ` ([Model check run](${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}), on ${GITHUB_REF_NAME} at ${GITHUB_SHA?.slice(0, 7)})`
    : " (run by hand, not from the Model check workflow)";
  const tuningFailed = failed - heldFailed;
  const out = [
    "# Live draft eval",
    "",
    `Run: ${new Date().toISOString()}${where}`,
    "",
    `Prompt fingerprint: \`${fingerprint}\` (lib/evalFingerprint.ts; CI fails when the prompts, texts, facts or models no longer match it)`,
    "",
    `## Replies, tuning set: \`${CLAUDE_MODEL}\` (served as ${draftsServed.map((m) => `\`${m}\``).join(", ") || "?"}) · ${EVAL_CASES.length - tuningFailed}/${EVAL_CASES.length} passed`,
    "",
    "| Case | Result | Problems | Draft |",
    "|---|---|---|---|",
    ...rows,
    "",
    `## Replies, held-out set (lib/heldOutCases.ts, never used to tune the prompt): \`${CLAUDE_MODEL}\` · ${HELD_OUT_CASES.length - heldFailed}/${HELD_OUT_CASES.length} passed`,
    "",
    "| Case | Result | Problems | Draft |",
    "|---|---|---|---|",
    ...heldRows,
    "",
    `## Booking answers and hand-off check: \`${CLAUDE_CHEAP_MODEL}\` (served as ${[...servedModels].map((m) => `\`${m}\``).join(", ") || "?"}) · ${cheapTotal - cheapFailed}/${cheapTotal} passed`,
    "",
    "| Case | Result | Problems |",
    "|---|---|---|",
    ...cheapRows,
    "",
  ].join("\n");
  failed += cheapFailed;
  const resultsUrl = new URL("../docs/eval-results.md", import.meta.url);
  const old = existsSync(resultsUrl) ? readFileSync(resultsUrl, "utf8") : "";
  const notes = old.includes(NOTES_HEADING) ? old.slice(old.indexOf(NOTES_HEADING)) : "";
  mkdirSync(new URL("../docs/", import.meta.url), { recursive: true });
  writeFileSync(resultsUrl, notes ? `${out}\n${notes}` : out);
  console.log(`Wrote docs/eval-results.md (${failed} failed)`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

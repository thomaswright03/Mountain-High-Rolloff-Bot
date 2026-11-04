import "dotenv/config";
import { readHeartbeat, recordHeartbeat } from "../lib/runStatus.js";

// Usage: tsx scripts/recordFailedRun.ts <heartbeat name> <what failed>
// The last step of each scheduled workflow, run only when a step failed.
// It marks that job's /admin row Down (and /admin/status.json `overall`
// for the Important rows), which is how a failure reaches Thomas: his CAO
// health check reads /admin/status.json, reports to Hitta, Hitta tells him
// (README "Who gets alerted"). A failure the job already recorded itself in
// the last 30 minutes is kept, since its detail is more specific.
async function main(): Promise<void> {
  const [name, what] = process.argv.slice(2);
  if (!name || !what) throw new Error("usage: recordFailedRun.ts <heartbeat name> <what failed>");
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  const beat = await readHeartbeat(name);
  if (beat && !beat.ok && Date.now() - new Date(beat.lastRun).getTime() < 30 * 60_000) {
    console.log(`${name} already shows the failure on /admin.`);
    return;
  }
  const run = GITHUB_RUN_ID ? ` See ${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}` : "";
  await recordHeartbeat(name, false, `${what} failed in GitHub Actions.${run}`);
  console.log(`Marked ${name} as failed on /admin.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

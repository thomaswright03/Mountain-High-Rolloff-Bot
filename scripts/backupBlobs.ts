import "dotenv/config";
import { backupToDirectory, vercelBlobStore } from "../lib/backup.js";
import { recordHeartbeat } from "../lib/runStatus.js";
import { errorMessage } from "../lib/errors.js";

// Usage: tsx scripts/backupBlobs.ts <output-dir>
// Run daily by .github/workflows/backup-blobs.yml, which uploads the folder.
const dir = process.argv[2] ?? "blob-backup";

async function main(): Promise<void> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.log("BLOB_READ_WRITE_TOKEN is not set: nothing to back up yet.");
    return;
  }
  try {
    const { files, bytes } = await backupToDirectory(vercelBlobStore, dir);
    console.log(`Backed up ${files} file(s), ${bytes} bytes, to ${dir}`);
    await recordHeartbeat("backup", true, `${files} file(s), ${bytes} bytes copied to a GitHub Actions artifact`);
  } catch (err: unknown) {
    await recordHeartbeat("backup", false, String(errorMessage(err) ?? err).slice(0, 200));
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

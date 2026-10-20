import "dotenv/config";
import { restoreFromDirectory, vercelBlobStore } from "../lib/backup.js";

// Usage: tsx scripts/restoreBlobs.ts <backup-dir> [scratch-prefix]
// Put a scratch prefix such as "restore-test/" first to try a restore
// without touching the live folders. Never overwrites an existing file.
const [dir, prefix = ""] = process.argv.slice(2);
if (!dir) {
  console.error("Usage: tsx scripts/restoreBlobs.ts <backup-dir> [scratch-prefix]");
  process.exit(1);
}
restoreFromDirectory(vercelBlobStore, dir, prefix)
  .then((n) => console.log(`Restored ${n} file(s) under "${prefix}"`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

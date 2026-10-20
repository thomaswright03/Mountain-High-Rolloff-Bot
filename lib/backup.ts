import { list, get, put } from "@vercel/blob";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { blobFolder } from "./blobNamespace.js";

// Copies the private Blob store's legal records (signed contracts and
// signatures, parked office notices, funnel counts) into a local folder,
// which .github/workflows/backup-blobs.yml uploads as a GitHub Actions
// artifact. restoreFromDirectory puts them back, optionally under a scratch
// prefix. README.md has the procedure.

export interface BlobStore {
  list(prefix: string): Promise<string[]>;
  read(pathname: string): Promise<Buffer | null>;
  write(pathname: string, body: Buffer): Promise<void>;
}

export const vercelBlobStore: BlobStore = {
  async list(prefix) {
    const out: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ prefix, cursor, limit: 1000 });
      for (const b of page.blobs) out.push(b.pathname);
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return out;
  },
  async read(pathname) {
    const result = await get(pathname, { access: "private", useCache: false });
    return result ? Buffer.from(await new Response(result.stream).arrayBuffer()) : null;
  },
  async write(pathname, body) {
    await put(pathname, body, { access: "private", addRandomSuffix: false, allowOverwrite: false, contentType: pathname.endsWith(".html") ? "text/html" : "application/json" });
  },
};

/** The folders worth keeping, in the live or test namespace. */
export function backupPrefixes(env: NodeJS.ProcessEnv = process.env): string[] {
  return [`${blobFolder("contracts", env)}/`, `${blobFolder("pending", env)}/`, "funnel/"];
}

export async function backupToDirectory(store: BlobStore, dir: string, prefixes: string[] = backupPrefixes()): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  for (const prefix of prefixes) {
    for (const pathname of await store.list(prefix)) {
      const body = await store.read(pathname);
      if (!body) throw new Error(`listed but unreadable: ${pathname}`);
      const target = join(dir, pathname);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, body);
      files++;
      bytes += body.length;
    }
  }
  return { files, bytes };
}

async function walk(dir: string, base = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(dir, rel)));
    else out.push(rel);
  }
  return out;
}

/** `scratchPrefix` (for example "restore-test/") keeps a trial restore apart
 * from the live folders. Existing files are never overwritten. */
export async function restoreFromDirectory(store: BlobStore, dir: string, scratchPrefix = ""): Promise<number> {
  let n = 0;
  for (const rel of await walk(dir)) {
    await store.write(`${scratchPrefix}${rel}`, await readFile(join(dir, rel)));
    n++;
  }
  return n;
}

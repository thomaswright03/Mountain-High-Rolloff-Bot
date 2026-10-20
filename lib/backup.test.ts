import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupPrefixes, backupToDirectory, restoreFromDirectory, type BlobStore } from "./backup.js";

function memoryStore(initial: Record<string, string> = {}): BlobStore & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>(Object.entries(initial).map(([k, v]) => [k, Buffer.from(v)]));
  return {
    files,
    async list(prefix) { return [...files.keys()].filter((k) => k.startsWith(prefix)); },
    async read(p) { return files.get(p) ?? null; },
    async write(p, body) {
      if (files.has(p)) throw new Error(`exists: ${p}`);
      files.set(p, body);
    },
  };
}

test("backup copies contracts, pending notices and funnel files, and a restore into a scratch prefix reads back the same", async () => {
  const live = memoryStore({
    "contracts/c1/contract.json": '{"id":"c1"}',
    "contracts/c1/signed.json": '{"name":"Sam"}',
    "contracts/c1/signed.html": "<p>signed</p>",
    "pending/c1.json": '{"contractId":"c1"}',
    "funnel/reached/a.json": "x",
    "test-contracts/t/contract.json": "not live",
    "status/send.json": "not a record",
  });
  const dir = await mkdtemp(join(tmpdir(), "backup-"));
  const result = await backupToDirectory(live, dir, backupPrefixes({ BLOB_NAMESPACE: "production" }));
  assert.equal(result.files, 5);

  const scratch = memoryStore();
  assert.equal(await restoreFromDirectory(scratch, dir, "restore-test/"), 5);
  assert.equal(scratch.files.get("restore-test/contracts/c1/signed.html")!.toString(), "<p>signed</p>");
  assert.equal(scratch.files.get("restore-test/contracts/c1/signed.json")!.toString(), '{"name":"Sam"}');
  assert.equal((await readFile(join(dir, "contracts/c1/contract.json"))).toString(), '{"id":"c1"}');
  assert.equal([...scratch.files.keys()].some((k) => k.includes("test-contracts") || k.includes("status")), false);
});

test("a restore never overwrites an existing file", async () => {
  const live = memoryStore({ "contracts/c1/contract.json": "a" });
  const dir = await mkdtemp(join(tmpdir(), "backup-"));
  await backupToDirectory(live, dir, ["contracts/"]);
  await assert.rejects(restoreFromDirectory(live, dir, ""));
});

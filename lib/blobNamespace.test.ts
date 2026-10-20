import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { blobFolder, isLiveNamespace } from "./blobNamespace.js";

// GitHub Actions has no VERCEL_ENV; the workflow sets BLOB_NAMESPACE instead.
const actions: NodeJS.ProcessEnv = { BLOB_NAMESPACE: "production", DRY_RUN: "false" };
const vercelProduction: NodeJS.ProcessEnv = { VERCEL_ENV: "production" };

test("the scheduled job and the Vercel production site use the same folders", () => {
  for (const name of ["status", "pending", "contracts"]) {
    assert.equal(blobFolder(name, actions), blobFolder(name, vercelProduction), name);
    assert.equal(blobFolder(name, actions), name);
  }
});

test("previews, local runs and an explicit non-production namespace stay in test folders", () => {
  assert.equal(blobFolder("status", { VERCEL_ENV: "preview" }), "test-status");
  assert.equal(blobFolder("pending", {}), "test-pending");
  assert.equal(isLiveNamespace({ BLOB_NAMESPACE: "test", VERCEL_ENV: "production" }), false);
});

test("the workflows that use the Blob store set BLOB_NAMESPACE=production", () => {
  for (const f of ["send-rolloff-texts.yml", "backup-blobs.yml"]) {
    const text = readFileSync(new URL(`../.github/workflows/${f}`, import.meta.url), "utf8");
    assert.match(text, /BLOB_NAMESPACE: production/, f);
  }
});

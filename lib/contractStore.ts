import { put, get } from "@vercel/blob";
import type { Contract, SignatureRecord } from "./contract.js";
import { blobFolder } from "./blobNamespace.js";

// Contracts and signatures live in the Vercel project's private Blob store
// (connecting a store in Vercel's Storage tab sets BLOB_READ_WRITE_TOKEN),
// same approach as the hauler signup site in the Kaizen repo. Nothing in it
// is public: the signing page reads it server-side.
//
// Per contract, under `contracts/` in production and `test-contracts/`
// everywhere else:
//   {id}/contract.json  the contract as created (never changed)
//   {id}/signed.json    the signature record (written once)
//   {id}/signed.html    the signed copy: contract + signature + signing record
//
// Blobs are never overwritten. A second signature for the same contract
// fails at the store, so a contract can only be signed once.

export interface BlobBackend {
  /** Throws if the path already exists. */
  put(path: string, body: string, contentType: string): Promise<void>;
  /** Null if not found. */
  get(path: string): Promise<string | null>;
}

const vercelBlob: BlobBackend = {
  async put(path, body, contentType) {
    await put(path, body, { access: "private", contentType, addRandomSuffix: false, allowOverwrite: false });
  },
  async get(path) {
    const result = await get(path, { access: "private", useCache: false });
    if (!result) return null;
    return await new Response(result.stream).text();
  },
};

let backend: BlobBackend = vercelBlob;

/** Tests swap in an in-memory store. Pass null to restore. */
export function setBlobBackendForTests(fake: BlobBackend | null): void {
  backend = fake ?? vercelBlob;
}

export function memoryBlobBackend(): BlobBackend & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async put(path, body) {
      if (files.has(path)) throw new Error(`blob already exists: ${path}`);
      files.set(path, body);
    },
    async get(path) {
      return files.get(path) ?? null;
    },
  };
}

/** Also read by the dashboard (lib/funnelStore.ts) to count contracts. */
export function contractsFolder(env: NodeJS.ProcessEnv = process.env): string {
  return blobFolder("contracts", env);
}

export async function saveContract(contract: Contract): Promise<void> {
  await backend.put(`${contractsFolder()}/${contract.id}/contract.json`, JSON.stringify(contract, null, 2), "application/json");
}

export async function loadContract(id: string): Promise<Contract | null> {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return null;
  const raw = await backend.get(`${contractsFolder()}/${id}/contract.json`);
  return raw ? (JSON.parse(raw) as Contract) : null;
}

export async function loadSignature(id: string): Promise<SignatureRecord | null> {
  const raw = await backend.get(`${contractsFolder()}/${id}/signed.json`);
  return raw ? (JSON.parse(raw) as SignatureRecord) : null;
}

export async function loadSignedDocument(id: string): Promise<string | null> {
  return backend.get(`${contractsFolder()}/${id}/signed.html`);
}

/** The record goes first: it's the write that can only happen once. */
export async function saveSignature(record: SignatureRecord, signedHtml: string): Promise<void> {
  await backend.put(`${contractsFolder()}/${record.contractId}/signed.json`, JSON.stringify(record, null, 2), "application/json");
  await backend.put(`${contractsFolder()}/${record.contractId}/signed.html`, signedHtml, "text/html; charset=utf-8");
}

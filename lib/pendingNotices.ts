import { put, get, list, del } from "@vercel/blob";
import { addNote, addTag } from "./ghl.js";
import { logEvent } from "./logging.js";
import { blobFolder } from "./blobNamespace.js";

// A signed contract must reach the office. If the GHL note and tags can't be
// written right after signing, the notice is parked here (private Blob
// store, pending/{contractId}.json) and retried by the scheduled job
// (retryPendingNotices, called from mts-sync/sendRollOffTexts.ts). Anything
// still waiting shows on /admin.

export const CONTRACT_SIGNED_TAG = "ai-rolloff-contract-signed";
export const NEEDS_HUMAN_TAG = "ai-needs-human";

export interface PendingNotice {
  contractId: string;
  contactId: string;
  note: string;
  createdAt: string;
  attempts: number;
  lastError: string;
}

export interface PendingBackend {
  put(id: string, notice: PendingNotice): Promise<void>;
  get(id: string): Promise<PendingNotice | null>;
  list(): Promise<string[]>;
  remove(id: string): Promise<void>;
  ready(): boolean;
}

const folder = () => blobFolder("pending");

const vercelBackend: PendingBackend = {
  ready: () => Boolean(process.env.BLOB_READ_WRITE_TOKEN),
  async put(id, notice) {
    await put(`${folder()}/${id}.json`, JSON.stringify(notice), { access: "private", contentType: "application/json", addRandomSuffix: false, allowOverwrite: true });
  },
  async get(id) {
    const result = await get(`${folder()}/${id}.json`, { access: "private", useCache: false });
    return result ? (JSON.parse(await new Response(result.stream).text()) as PendingNotice) : null;
  },
  async list() {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ prefix: `${folder()}/`, cursor, limit: 1000 });
      for (const b of page.blobs) ids.push(b.pathname.slice(folder().length + 1).replace(/\.json$/, ""));
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return ids;
  },
  async remove(id) {
    await del(`${folder()}/${id}.json`);
  },
};

let backend: PendingBackend = vercelBackend;

export function setPendingBackendForTests(fake: PendingBackend | null): void {
  backend = fake ?? vercelBackend;
}

export function memoryPendingBackend(): PendingBackend & { items: Map<string, PendingNotice> } {
  const items = new Map<string, PendingNotice>();
  return {
    items,
    ready: () => true,
    put: async (id, n) => void items.set(id, n),
    get: async (id) => items.get(id) ?? null,
    list: async () => [...items.keys()],
    remove: async (id) => void items.delete(id),
  };
}

/** Writes the note and tags that tell the office a contract was signed. */
export async function deliverSignedNotice(contactId: string, note: string): Promise<void> {
  await addNote(contactId, note);
  await addTag(contactId, CONTRACT_SIGNED_TAG);
  await addTag(contactId, NEEDS_HUMAN_TAG);
}

/** Tries the GHL write; on failure parks it for the scheduled job. Never
 * throws: the signature itself is already saved. Returns whether it was
 * delivered right away. */
export async function notifyOfficeOrPark(contractId: string, contactId: string, note: string): Promise<boolean> {
  try {
    await deliverSignedNotice(contactId, note);
    return true;
  } catch (err: any) {
    logEvent({ event: "contract_signed_ghl_failed", contractId, error: err.message });
    try {
      if (!backend.ready()) throw new Error("no Blob store to park the notice in");
      await backend.put(contractId, { contractId, contactId, note, createdAt: new Date().toISOString(), attempts: 1, lastError: String(err.message).slice(0, 300) });
      logEvent({ event: "contract_notice_parked", contractId });
    } catch (parkErr: any) {
      // Last resort: the log line is all there is. Loud on purpose.
      logEvent({ event: "contract_notice_LOST", contractId, contactId, error: parkErr.message });
    }
    return false;
  }
}

/** Retries every parked notice. Returns how many were delivered / still wait. */
export async function retryPendingNotices(): Promise<{ delivered: number; stillPending: number }> {
  if (!backend.ready()) return { delivered: 0, stillPending: 0 };
  let delivered = 0;
  let stillPending = 0;
  for (const id of await backend.list()) {
    const notice = await backend.get(id);
    if (!notice) continue;
    try {
      await deliverSignedNotice(notice.contactId, notice.note);
      await backend.remove(id);
      delivered++;
      logEvent({ event: "contract_notice_delivered_on_retry", contractId: id });
    } catch (err: any) {
      stillPending++;
      await backend.put(id, { ...notice, attempts: notice.attempts + 1, lastError: String(err.message).slice(0, 300) });
      logEvent({ event: "contract_notice_retry_failed", contractId: id, attempts: notice.attempts + 1, error: err.message });
    }
  }
  return { delivered, stillPending };
}

/** For /admin. Null when the store can't be read. */
export async function pendingNoticeSummary(): Promise<{ count: number; oldest: string | null } | null> {
  if (!backend.ready()) return null;
  try {
    const items = await Promise.all((await backend.list()).map((id) => backend.get(id)));
    const found = items.filter((n): n is PendingNotice => Boolean(n)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { count: found.length, oldest: found[0]?.createdAt ?? null };
  } catch {
    return null;
  }
}

import { put, list } from "@vercel/blob";
import { contractsFolder } from "./contractStore.js";
import { logEvent } from "./logging.js";
import { errorMessage } from "./errors.js";

// What the roll-off dashboard counts (Thomas, 2026-10-10: "displays how many
// roll off dumpster contracts have been signed, how many people have been
// reached out to"). Everything lives in the same private Vercel Blob store
// as the contracts, so there's no second database to set up:
//
//   funnel/reached/{contactId}.json    the bot's first text to a lead went out
//   funnel/responded/{contactId}.json  the lead's first text back
//   funnel/contract-sent/{contractId}.json  the contract link was texted to them (before 2026-10-21)
//   funnel/summary-sent/{contactId}.json    the booking summary was texted to them
//   funnel/signed/{contactId}.json          they signed it by texting their name
//   {contracts folder}/{id}/signed.json    they signed a linked contract (before 2026-10-21)
//
// The funnel files are written once per lead (the first one wins), and
// only for real texts: under DRY_RUN nothing is recorded, so test runs
// never show up as reached. The dashboard only lists the files and uses
// each one's upload time, it never reads them.

export type FunnelEvent = "reached" | "responded" | "contract-sent" | "summary-sent" | "signed";

export const FUNNEL_FOLDER = "funnel";

export interface BlobListing {
  pathname: string;
  uploadedAt: Date;
}

export interface FunnelBlobBackend {
  /** Throws if the path already exists. */
  putOnce(path: string, body: string): Promise<void>;
  list(prefix: string): Promise<BlobListing[]>;
  /** False when no Blob store is connected, so nothing can be recorded. */
  ready(): boolean;
}

const vercelBlob: FunnelBlobBackend = {
  async putOnce(path, body) {
    await put(path, body, { access: "private", contentType: "application/json", addRandomSuffix: false, allowOverwrite: false });
  },
  async list(prefix) {
    const out: BlobListing[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ prefix, cursor, limit: 1000 });
      for (const b of page.blobs) out.push({ pathname: b.pathname, uploadedAt: new Date(b.uploadedAt) });
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return out;
  },
  ready() {
    return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
  },
};

let backend: FunnelBlobBackend = vercelBlob;

/** Tests swap in an in-memory store. Pass null to restore. */
export function setFunnelBackendForTests(fake: FunnelBlobBackend | null): void {
  backend = fake ?? vercelBlob;
}

export function memoryFunnelBackend(): FunnelBlobBackend & { files: Map<string, BlobListing & { body: string }> } {
  const files = new Map<string, BlobListing & { body: string }>();
  return {
    files,
    async putOnce(path, body) {
      if (files.has(path)) throw new Error(`blob already exists: ${path}`);
      files.set(path, { pathname: path, uploadedAt: new Date(), body });
    },
    async list(prefix) {
      return [...files.values()].filter((f) => f.pathname.startsWith(prefix)).map(({ pathname, uploadedAt }) => ({ pathname, uploadedAt }));
    },
    ready: () => true,
  };
}

/** False until a Blob store is connected to the Vercel project. */
export function funnelStoreReady(): boolean {
  return backend.ready();
}

/** Never throws: a lead's text has already gone out (or come in) by the
 * time this runs, and a missed count must never turn into an error that
 * hands the lead to the office. */
export async function recordFunnelEvent(event: FunnelEvent, contactId: string): Promise<void> {
  if (process.env.DRY_RUN === "true") return;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(contactId)) {
    logEvent({ event: "funnel_event_bad_contact_id", funnelEvent: event });
    return;
  }
  if (!backend.ready()) {
    logEvent({ event: "funnel_event_not_recorded_no_store", funnelEvent: event, contactId });
    return;
  }
  try {
    await backend.putOnce(`${FUNNEL_FOLDER}/${event}/${contactId}.json`, JSON.stringify({ contactId, event, at: new Date().toISOString() }));
  } catch (err: unknown) {
    // Already recorded for this lead: their first text counts, not this one.
    if (/exist/i.test(String(errorMessage(err)))) return;
    logEvent({ event: "funnel_event_record_failed", funnelEvent: event, contactId, error: errorMessage(err) });
  }
}

export interface FunnelActivity {
  reached: Date[];
  responded: Date[];
  contractsSent: Date[];
  contractsSigned: Date[];
}

/** When each thing happened, from the store's file list. Two list calls,
 * however many days the dashboard shows. */
export async function loadFunnelActivity(): Promise<FunnelActivity> {
  const [funnel, contracts] = await Promise.all([backend.list(`${FUNNEL_FOLDER}/`), backend.list(`${contractsFolder()}/`)]);
  const at = (files: BlobListing[], test: (path: string) => boolean) => files.filter((f) => test(f.pathname)).map((f) => f.uploadedAt);
  return {
    reached: at(funnel, (p) => p.startsWith(`${FUNNEL_FOLDER}/reached/`)),
    responded: at(funnel, (p) => p.startsWith(`${FUNNEL_FOLDER}/responded/`)),
    contractsSent: at(funnel, (p) => p.startsWith(`${FUNNEL_FOLDER}/contract-sent/`) || p.startsWith(`${FUNNEL_FOLDER}/summary-sent/`)),
    contractsSigned: [...at(contracts, (p) => p.endsWith("/signed.json")), ...at(funnel, (p) => p.startsWith(`${FUNNEL_FOLDER}/signed/`))],
  };
}

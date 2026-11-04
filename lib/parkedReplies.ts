import { put, list, get, del } from "@vercel/blob";
import { blobFolder } from "./blobNamespace.js";
import { logEvent } from "./logging.js";
import { errorMessage } from "./errors.js";
import type { InboundMessage } from "./types.js";

// A text that arrives while the kill switch has the bot paused is parked
// here instead of being dropped (grader, 2026-11-04). Nothing is written to
// GHL while paused. Once the bot runs again, the scheduled job takes each
// parked text: a recent one is answered as if it had just come in, an old
// one goes to the office (mts-sync/sendRollOffTexts.ts, drainParkedReplies).
// /admin counts what is waiting. One small private file per contact:
//
//   parked/{contactId}.json   the newest text from them while paused

export interface ParkedReply extends InboundMessage {
  receivedAt: string;
}

export interface ParkedBackend {
  ready(): boolean;
  write(contactId: string, body: string): Promise<void>;
  /** contact ids, oldest first */
  list(): Promise<string[]>;
  read(contactId: string): Promise<string | null>;
  remove(contactId: string): Promise<void>;
}

const folder = () => blobFolder("parked");

const vercelBackend: ParkedBackend = {
  ready: () => Boolean(process.env.BLOB_READ_WRITE_TOKEN),
  async write(contactId, body) {
    await put(`${folder()}/${contactId}.json`, body, { access: "private", contentType: "application/json", addRandomSuffix: false, allowOverwrite: true });
  },
  async list() {
    const out: Array<{ id: string; at: number }> = [];
    let cursor: string | undefined;
    do {
      const page = await list({ prefix: `${folder()}/`, cursor, limit: 1000 });
      for (const b of page.blobs) out.push({ id: b.pathname.slice(folder().length + 1).replace(/\.json$/, ""), at: new Date(b.uploadedAt).getTime() });
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return out.sort((a, b) => a.at - b.at).map((o) => o.id);
  },
  async read(contactId) {
    const result = await get(`${folder()}/${contactId}.json`, { access: "private", useCache: false });
    return result ? await new Response(result.stream).text() : null;
  },
  async remove(contactId) {
    await del(`${folder()}/${contactId}.json`);
  },
};

let backend: ParkedBackend = vercelBackend;

/** Tests swap in an in-memory store. Pass null to restore. */
export function setParkedBackendForTests(fake: ParkedBackend | null): void {
  backend = fake ?? vercelBackend;
}

export function memoryParkedBackend(): ParkedBackend & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    ready: () => true,
    write: async (id, body) => void files.set(id, body),
    list: async () => [...files.keys()],
    read: async (id) => files.get(id) ?? null,
    remove: async (id) => void files.delete(id),
  };
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** True if it was kept. Never throws: the webhook still answers GHL. */
export async function parkReply(inbound: InboundMessage, now: Date = new Date()): Promise<boolean> {
  if (!backend.ready() || !SAFE_ID.test(inbound.contactId)) return false;
  try {
    const record: ParkedReply = { ...inbound, receivedAt: now.toISOString() };
    await backend.write(inbound.contactId, JSON.stringify(record));
    return true;
  } catch (err: unknown) {
    logEvent({ event: "parked_reply_write_failed", contactId: inbound.contactId, error: errorMessage(err) });
    return false;
  }
}

export async function listParkedReplies(): Promise<ParkedReply[]> {
  if (!backend.ready()) return [];
  const out: ParkedReply[] = [];
  for (const id of await backend.list()) {
    const raw = await backend.read(id);
    if (!raw) continue;
    try {
      out.push(JSON.parse(raw) as ParkedReply);
    } catch {
      logEvent({ event: "parked_reply_unreadable", contactId: id });
    }
  }
  return out;
}

export async function removeParkedReply(contactId: string): Promise<void> {
  await backend.remove(contactId);
}

/** How many texts are waiting, or null if the store can't be read. */
export async function countParkedReplies(): Promise<number | null> {
  if (!backend.ready()) return 0;
  try {
    return (await backend.list()).length;
  } catch (err: unknown) {
    logEvent({ event: "parked_reply_count_failed", error: errorMessage(err) });
    return null;
  }
}

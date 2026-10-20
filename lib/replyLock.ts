import { put } from "@vercel/blob";
import { createHash } from "node:crypto";
import { blobFolder } from "./blobNamespace.js";
import { logEvent } from "./logging.js";

// One reply per inbound text. Two webhook calls for the same message that
// arrive together both see "last message is inbound", so each claims a
// small Blob file named after the contact and the message. put() without
// overwrite fails for the second caller, which then stands down.

export interface LockBackend {
  /** True if this caller got the claim, false if someone already had it. */
  claim(key: string): Promise<boolean>;
  ready(): boolean;
}

const vercelBackend: LockBackend = {
  ready: () => Boolean(process.env.BLOB_READ_WRITE_TOKEN),
  async claim(key) {
    try {
      await put(`${blobFolder("reply-locks")}/${key}.json`, JSON.stringify({ at: new Date().toISOString() }), {
        access: "private",
        contentType: "application/json",
        addRandomSuffix: false,
        allowOverwrite: false,
      });
      return true;
    } catch (err: any) {
      if (/already exists/i.test(String(err?.message))) return false;
      throw err;
    }
  },
};

let backend: LockBackend = vercelBackend;

export function setLockBackendForTests(fake: LockBackend | null): void {
  backend = fake ?? vercelBackend;
}

export function memoryLockBackend(): LockBackend & { keys: Set<string> } {
  const keys = new Set<string>();
  return {
    keys,
    ready: () => true,
    async claim(key) {
      // Yield first so concurrent callers genuinely interleave.
      await new Promise((r) => setImmediate(r));
      if (keys.has(key)) return false;
      keys.add(key);
      return true;
    },
  };
}

export function replyLockKey(contactId: string, message: { body: string; dateAdded?: string }): string {
  const h = createHash("sha256").update(`${message.dateAdded ?? ""}\n${message.body}`).digest("hex").slice(0, 24);
  return `${contactId.replace(/[^A-Za-z0-9_-]/g, "_")}-${h}`;
}

/** True when this call may reply. With no Blob store it can't lock, so it
 * allows the reply (the thread check still catches sequential duplicates);
 * a store error also allows it rather than dropping a real customer. */
export async function claimReply(key: string): Promise<boolean> {
  if (!backend.ready()) return true;
  try {
    return await backend.claim(key);
  } catch (err: any) {
    logEvent({ event: "reply_lock_failed", error: err?.message });
    return true;
  }
}

import { put, get } from "@vercel/blob";
import { logEvent } from "./logging.js";
import { blobFolder } from "./blobNamespace.js";

// Recorded results for /admin (api/admin.ts): each job and each outside
// service writes one small JSON file (a "heartbeat") to the private Blob
// store after it runs. The status page reads them back, so a row is only
// OK because something really ran and succeeded recently. Everything here
// is best-effort: a status write never breaks the job it describes.

export interface Heartbeat {
  name: string;
  /** Result of the most recent run. */
  ok: boolean;
  /** When that run finished. */
  lastRun: string;
  /** When it last succeeded. */
  lastSuccess: string | null;
  detail: string;
  /** Set when the run was stopped by the kill switch rather than finishing its work. */
  paused?: boolean;
}

export interface StatusBackend {
  read(name: string): Promise<Heartbeat | null>;
  write(beat: Heartbeat): Promise<void>;
  ready(): boolean;
}

const folder = () => blobFolder("status");
const SAFE_NAME = /^[a-z0-9-]{1,40}$/;

const vercelBackend: StatusBackend = {
  ready: () => Boolean(process.env.BLOB_READ_WRITE_TOKEN),
  async read(name) {
    const result = await get(`${folder()}/${name}.json`, { access: "private", useCache: false });
    if (!result) return null;
    return JSON.parse(await new Response(result.stream).text()) as Heartbeat;
  },
  async write(beat) {
    await put(`${folder()}/${beat.name}.json`, JSON.stringify(beat), {
      access: "private",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  },
};

let backend: StatusBackend = vercelBackend;

/** Tests swap in an in-memory store. Pass null to restore. */
export function setStatusBackendForTests(fake: StatusBackend | null): void {
  backend = fake ?? vercelBackend;
}

export function memoryStatusBackend(): StatusBackend & { beats: Map<string, Heartbeat> } {
  const beats = new Map<string, Heartbeat>();
  return { beats, ready: () => true, read: async (n) => beats.get(n) ?? null, write: async (b) => void beats.set(b.name, b) };
}

export function statusStoreReady(): boolean {
  return backend.ready();
}

/** Never throws. */
export async function recordHeartbeat(name: string, ok: boolean, detail: string, now: Date = new Date(), extra: { paused?: boolean } = {}): Promise<void> {
  if (!SAFE_NAME.test(name) || !backend.ready()) return;
  try {
    const previous = await backend.read(name).catch(() => null);
    await backend.write({
      name,
      ok,
      lastRun: now.toISOString(),
      lastSuccess: ok ? now.toISOString() : previous?.lastSuccess ?? null,
      detail: detail.slice(0, 300),
      ...(extra.paused ? { paused: true } : {}),
    });
  } catch (err: any) {
    logEvent({ event: "heartbeat_write_failed", name, error: err?.message });
  }
}

/** Null when never recorded, or when the store can't be read. */
export async function readHeartbeat(name: string): Promise<Heartbeat | null> {
  if (!SAFE_NAME.test(name) || !backend.ready()) return null;
  try {
    return await backend.read(name);
  } catch (err: any) {
    logEvent({ event: "heartbeat_read_failed", name, error: err?.message });
    return null;
  }
}

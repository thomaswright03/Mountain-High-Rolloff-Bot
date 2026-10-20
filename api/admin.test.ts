import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { memoryStatusBackend, setStatusBackendForTests, recordHeartbeat } from "../lib/runStatus.js";
import { memoryPendingBackend, setPendingBackendForTests } from "../lib/pendingNotices.js";
import { buildStatus, type StatusInputs } from "../lib/adminStatus.js";

const PASSWORD = "correct horse battery";
let admin: (req: any, res: any) => Promise<void>;

before(async () => {
  admin = (await import("./admin.js")).default as any;
});
after(() => {
  setStatusBackendForTests(null);
  setPendingBackendForTests(null);
});
beforeEach(() => {
  process.env.DASHBOARD_PASSWORD = PASSWORD;
  process.env.ADMIN_STATUS_TOKEN = "monitoring-token-123456";
  delete process.env.KILLSWITCH_URL;
  delete process.env.GHL_API_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  process.env.DRY_RUN = "true";
  setStatusBackendForTests(memoryStatusBackend());
  setPendingBackendForTests(memoryPendingBackend());
});

async function call(method: string, opts: { query?: Record<string, string>; headers?: Record<string, string>; body?: unknown } = {}) {
  const state: { status?: number; body?: any; headers: Record<string, string> } = { headers: {} };
  const res: any = {
    setHeader(k: string, v: string) { state.headers[k.toLowerCase()] = v; return res; },
    status(code: number) { state.status = code; return res; },
    send(b: any) { state.body = b; return res; },
    json(b: any) { state.body = b; return res; },
  };
  await admin({ method, query: opts.query ?? {}, headers: opts.headers ?? {}, body: opts.body } as any, res);
  return state;
}

async function cookie(): Promise<string> {
  const r = await call("POST", { body: { password: PASSWORD } });
  assert.equal(r.status, 303);
  assert.equal(r.headers.location, "/admin");
  return r.headers["set-cookie"]!.split(";")[0]!;
}

test("signed out, /admin is only a password form and the JSON is refused", async () => {
  const page = await call("GET");
  assert.match(page.body, /type="password"/);
  assert.ok(!page.body.includes("Latest Update"));
  const json = await call("GET", { query: { format: "json" } });
  assert.equal(json.status, 401);
  const wrong = await call("GET", { query: { format: "json" }, headers: { authorization: "Bearer nope-nope-nope-nope" } });
  assert.equal(wrong.status, 401);
});

test("signed in, /admin shows the three groups in order, the rows, and the Latest Update with Frontend changes first", async () => {
  const c = await cookie();
  const r = await call("GET", { headers: { cookie: c } });
  assert.equal(r.status, 200);
  const html: string = r.body;
  const at = (s: string) => html.indexOf(s);
  assert.ok(at("<h2>Important</h2>") > 0 && at("<h2>Important</h2>") < at("<h2>Key</h2>") && at("<h2>Key</h2>") < at("<h2>Basic</h2>") && at("<h2>Basic</h2>") < at("Latest Update"));
  for (const name of ["Lead pick-up from MTS", "Scheduled texts", "Replies answered", "Contracts signable", "GHL API", "Claude API", "MTS login", "Blob store", "GitHub Actions job", "Kill switch", "Deployed version"]) {
    assert.ok(html.includes(name), name);
  }
  assert.ok(at("Frontend changes") > at("Latest Update") && at("Frontend changes") < at("Other changes"));
});

test("/admin/status.json has the agreed shape, for a signed-in session and for the bearer token", async () => {
  const c = await cookie();
  for (const headers of [{ cookie: c }, { authorization: `Bearer ${process.env.ADMIN_STATUS_TOKEN}` }] as Record<string, string>[]) {
    const r = await call("GET", { query: { format: "json" }, headers });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ["checked_at", "functions", "overall", "product"]);
    assert.deepEqual(Object.keys(r.body.functions[0]).sort(), ["detail", "last_checked", "last_success", "name", "next_expected_run", "status", "tier"]);
    assert.ok(["OK", "Warning", "Down", "Unknown"].includes(r.body.overall));
  }
});

test("a recorded job result drives its row", async () => {
  await recordHeartbeat("rolloff-import", true, "read 100 rows, picked up 2");
  await recordHeartbeat("rolloff-send", false, "errored 3");
  const c = await cookie();
  const r = await call("GET", { query: { format: "json" }, headers: { cookie: c } });
  const row = (n: string) => r.body.functions.find((f: any) => f.name === n);
  assert.equal(row("Lead pick-up from MTS").status, "OK");
  assert.equal(row("Scheduled texts").status, "Down");
  assert.equal(r.body.overall, "Down");
  assert.equal(row("GitHub Actions job").status, "Down");
});

function inputs(over: Partial<StatusInputs> = {}): StatusInputs {
  const now = new Date("2026-10-20T18:00:00Z");
  const beat = (minAgo: number, ok = true) => ({ name: "x", ok, lastRun: new Date(now.getTime() - minAgo * 60_000).toISOString(), lastSuccess: new Date(now.getTime() - minAgo * 60_000).toISOString(), detail: "fine" });
  return {
    now,
    env: { DRY_RUN: "true", CONTRACT_SIGNING_SECRET: "s", PUBLIC_BASE_URL: "https://x", BLOB_READ_WRITE_TOKEN: "t", KILLSWITCH_URL: "https://flag" },
    beats: { "rolloff-import": beat(5), "rolloff-send": beat(5), replies: beat(600), claude: beat(60), "mts-login": beat(5) },
    blob: { ok: true, detail: "answers" },
    ghl: { status: "OK", detail: "ok" },
    killswitch: { active: true },
    pending: { count: 0, oldest: null },
    ...over,
  };
}

test("everything healthy is OK; stale or missing is never OK", () => {
  assert.equal(buildStatus(inputs()).overall, "OK");
  const stale = buildStatus(inputs({ beats: { ...inputs().beats, "rolloff-send": { ...inputs().beats["rolloff-send"]!, lastRun: "2026-10-20T17:20:00Z" } } }));
  assert.equal(stale.functions.find((f) => f.name === "Scheduled texts")!.status, "Warning");
  const veryStale = buildStatus(inputs({ beats: { ...inputs().beats, "rolloff-import": { ...inputs().beats["rolloff-import"]!, lastRun: "2026-10-20T15:00:00Z" } } }));
  assert.equal(veryStale.functions.find((f) => f.name === "Lead pick-up from MTS")!.status, "Down");
  assert.equal(veryStale.overall, "Down");
  const none = buildStatus(inputs({ beats: {} }));
  assert.equal(none.functions.find((f) => f.name === "Scheduled texts")!.status, "Unknown");
  assert.notEqual(none.overall, "OK");
});

test("a signed contract still waiting for the office is a visible warning; a paused switch is shown", () => {
  const s = buildStatus(inputs({ pending: { count: 2, oldest: "2026-10-20T10:00:00Z" }, killswitch: { active: false } }));
  const signable = s.functions.find((f) => f.name === "Contracts signable")!;
  assert.equal(signable.status, "Warning");
  assert.match(signable.detail, /2 signed contract/);
  assert.match(s.functions.find((f) => f.name === "Kill switch")!.detail, /PAUSED/);
  const missing = buildStatus(inputs({ env: { DRY_RUN: "true" } }));
  assert.equal(missing.functions.find((f) => f.name === "Contracts signable")!.status, "Down");
});

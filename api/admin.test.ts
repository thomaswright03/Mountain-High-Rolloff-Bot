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
  for (const name of ["Lead pick-up from MTS", "Scheduled texts", "Replies answered", "Bookings signed by text", "Booking email to the office", "Manual contract signing page", "GHL API", "Claude API", "MTS login", "Record storage", "GitHub Actions job", "Kill switch", "Deployed version"]) {
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
    assert.ok(["ok", "warning", "down", "unknown"].includes(r.body.overall));
    for (const f of r.body.functions) {
      assert.ok(["ok", "warning", "down", "unknown"].includes(f.status), f.status);
      assert.ok(["important", "key", "basic"].includes(f.tier), f.tier);
    }
  }
});

test("a recorded job result drives its row", async () => {
  await recordHeartbeat("rolloff-import", true, "read 100 rows, picked up 2");
  await recordHeartbeat("rolloff-send", false, "errored 3");
  const c = await cookie();
  const r = await call("GET", { query: { format: "json" }, headers: { cookie: c } });
  const row = (n: string) => r.body.functions.find((f: any) => f.name === n);
  assert.equal(row("Lead pick-up from MTS").status, "ok");
  assert.equal(row("Scheduled texts").status, "down");
  assert.equal(r.body.overall, "down");
  assert.equal(row("GitHub Actions job").status, "down");
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
  const signable = s.functions.find((f) => f.name === "Manual contract signing page")!;
  assert.equal(signable.status, "Warning");
  assert.match(signable.detail, /2 signed contract/);
  assert.match(s.functions.find((f) => f.name === "Kill switch")!.detail, /PAUSED/);
  const missing = buildStatus(inputs({ env: { DRY_RUN: "true" } }));
  assert.equal(missing.functions.find((f) => f.name === "Manual contract signing page")!.status, "Unknown");
});

test("booking by text and its email have their own rows; failures show Down; missing link-signing secrets don't take overall down", () => {
  const base = inputs();
  const beat = (ok: boolean, detail: string) => ({ name: "x", ok, lastRun: "2026-10-20T17:50:00Z", lastSuccess: ok ? "2026-10-20T17:50:00Z" : null, detail });
  const bad = buildStatus(inputs({ beats: { ...base.beats, "booking-email": beat(false, "email down"), "booking-signed": beat(false, "note failed") } }));
  assert.equal(bad.functions.find((f) => f.name === "Booking email to the office")!.status, "Down");
  assert.equal(bad.functions.find((f) => f.name === "Bookings signed by text")!.status, "Down");
  assert.equal(bad.overall, "Down");
  const good = buildStatus(inputs({ env: { DRY_RUN: "true", KILLSWITCH_URL: "https://flag", BLOB_READ_WRITE_TOKEN: "t" }, beats: { ...base.beats, "booking-email": beat(true, "sent"), "booking-signed": beat(true, "signed") } }));
  assert.equal(good.functions.find((f) => f.name === "Bookings signed by text")!.status, "OK");
  assert.equal(good.functions.find((f) => f.name === "Booking email to the office")!.status, "OK");
  assert.notEqual(good.overall, "Down");
});

test("a run paused by the kill switch, or an unreachable flag with test mode off, is not shown as OK", () => {
  const base = inputs();
  const pausedBeat = { ...base.beats["rolloff-send"]!, paused: true };
  const a = buildStatus(inputs({ beats: { ...base.beats, "rolloff-send": pausedBeat } }));
  const rowA = a.functions.find((f) => f.name === "Scheduled texts")!;
  assert.equal(rowA.status, "Warning");
  assert.match(rowA.detail, /kill switch/);
  const b = buildStatus(inputs({ env: { ...base.env, DRY_RUN: "false" }, killswitch: null }));
  assert.notEqual(b.functions.find((f) => f.name === "Scheduled texts")!.status, "OK");
  assert.equal(b.functions.find((f) => f.name === "Test mode and texting permission")!.status, "Warning");
});

test("no run for over 60 minutes makes the overall status down", () => {
  const base = inputs();
  const old = { ...base.beats["rolloff-send"]!, lastRun: "2026-10-20T16:30:00Z" };
  assert.equal(buildStatus(inputs({ beats: { ...base.beats, "rolloff-send": old } })).overall, "Down");
});

test("a stale backup warns and then goes down; a fresh one is OK", () => {
  const base = inputs();
  const row = (hoursAgo: number) => {
    const t = new Date(base.now.getTime() - hoursAgo * 3_600_000).toISOString();
    return buildStatus(inputs({ beats: { ...base.beats, backup: { name: "backup", ok: true, lastRun: t, lastSuccess: t, detail: "12 files" } } })).functions.find((f) => f.name === "Latest backup")!;
  };
  assert.equal(row(2).status, "OK");
  assert.equal(row(40).status, "Warning");
  assert.equal(row(70).status, "Down");
});

test("the daily backup row names the next 09:17 UTC run", () => {
  const base = inputs();
  const t = "2026-10-21T09:20:00Z";
  const row = buildStatus(inputs({ beats: { ...base.beats, backup: { name: "backup", ok: true, lastRun: t, lastSuccess: t, detail: "12 files" } } })).functions.find((f) => f.name === "Latest backup")!;
  assert.equal(row.next_expected_run, "2026-10-22T09:17:00.000Z");
  const before = buildStatus(inputs({ beats: { ...base.beats, backup: { name: "backup", ok: true, lastRun: "2026-10-21T08:00:00Z", lastSuccess: "2026-10-21T08:00:00Z", detail: "" } } })).functions.find((f) => f.name === "Latest backup")!;
  assert.equal(before.next_expected_run, "2026-10-21T09:17:00.000Z");
});

test("contacts stuck mid-send show as a Warning with a count; an import that read no rows warns", () => {
  const base = inputs();
  const t = base.now.toISOString();
  const stuck = buildStatus(inputs({ beats: { ...base.beats, "rolloff-stuck": { name: "rolloff-stuck", ok: false, lastRun: t, lastSuccess: null, detail: "3 still tagged", count: 3 } } }));
  const row = stuck.functions.find((f) => f.name === "Contacts stuck mid-send")!;
  assert.equal(row.status, "Warning");
  assert.match(row.detail, /^3 contact/);
  const empty = buildStatus(inputs({ beats: { ...base.beats, "rolloff-import": { ...base.beats["rolloff-import"]!, lastRun: t, warning: true, detail: "read 0 rows" } } }));
  assert.equal(empty.functions.find((f) => f.name === "Lead pick-up from MTS")!.status, "Warning");
  assert.notEqual(empty.overall, "Down");
});

test("every page links the Mountain High icon, and the icon files exist", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  for (const f of ["api/admin.ts", "api/dashboard.ts", "api/contract.ts"]) {
    const src = readFileSync(f, "utf8");
    assert.match(src, /rel="icon" type="image\/svg\+xml" href="\/favicon.svg"/, f);
    assert.match(src, /rel="apple-touch-icon" href="\/apple-touch-icon.png"/, f);
  }
  assert.ok(existsSync("public/favicon.svg") && existsSync("public/apple-touch-icon.png"));
  assert.match(readFileSync("public/favicon.svg", "utf8"), /^<svg/);
});

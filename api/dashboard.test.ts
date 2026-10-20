import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { memoryFunnelBackend, setFunnelBackendForTests } from "../lib/funnelStore.js";
import { toLocalDay } from "../lib/dashboardStats.js";

// The roll-off dashboard (api/dashboard.ts) and its numbers
// (api/dashboardData.ts), signed in through the real form.

const PASSWORD = "correct horse battery";
let page: (req: any, res: any) => Promise<void>;
let data: (req: any, res: any) => Promise<void>;
let store: ReturnType<typeof memoryFunnelBackend>;

before(async () => {
  page = (await import("./dashboard.js")).default as any;
  data = (await import("./dashboardData.js")).default as any;
});

after(() => setFunnelBackendForTests(null));

beforeEach(() => {
  process.env.DASHBOARD_PASSWORD = PASSWORD;
  process.env.DRY_RUN = "false";
  delete process.env.VERCEL_ENV;
  store = memoryFunnelBackend();
  setFunnelBackendForTests(store);
});

async function call(handler: typeof page, method: string, opts: { body?: unknown; cookie?: string; query?: Record<string, string> } = {}) {
  const state: { status?: number; body?: any; headers: Record<string, string> } = { headers: {} };
  const res: any = {
    setHeader(k: string, v: string) { state.headers[k.toLowerCase()] = v; return res; },
    status(code: number) { state.status = code; return res; },
    send(b: any) { state.body = b; return res; },
    json(b: any) { state.body = b; return res; },
  };
  await handler({ method, query: opts.query ?? {}, body: opts.body, headers: opts.cookie ? { cookie: opts.cookie } : {} } as any, res);
  return state;
}

async function signIn(): Promise<string> {
  const r = await call(page, "POST", { body: { password: PASSWORD } });
  assert.equal(r.status, 303);
  assert.equal(r.headers.location, "/dashboard");
  return r.headers["set-cookie"]!.split(";")[0]!;
}

test("signed out, the page is only a password form, and the numbers are refused", async () => {
  const r = await call(page, "GET");
  assert.equal(r.status, 200);
  assert.match(r.body, /type="password"/);
  assert.match(r.body, /method="post" action="\/dashboard"/);
  assert.ok(!r.body.includes("Contracts sent"));
  assert.match(r.headers["content-security-policy"]!, /script-src 'nonce-/);
  assert.equal(r.headers["cache-control"], "no-store");

  const d = await call(data, "GET");
  assert.equal(d.status, 401);
  assert.equal(d.body.stats, undefined);
});

test("a secret in the URL doesn't open anything, unlike the Kaizen dashboard", async () => {
  const r = await call(page, "GET", { query: { secret: PASSWORD } });
  assert.match(r.body, /type="password"/);
  assert.equal((await call(data, "GET", { query: { secret: PASSWORD, password: PASSWORD } })).status, 401);
});

test("the right password signs you in with a cookie, and the page then shows the dashboard", async () => {
  const cookie = await signIn();
  const r = await call(page, "GET", { cookie });
  assert.equal(r.status, 200);
  assert.match(r.body, /Roll-off dumpster bot/);
  assert.match(r.body, /Contracts sent/);
  assert.match(r.body, /Sign out/);
  assert.ok(!r.body.includes(PASSWORD), "the password is never echoed into the page");
});

test("a wrong password is refused, slowly, with no cookie", async () => {
  const started = Date.now();
  const r = await call(page, "POST", { body: "password=nope" });
  assert.equal(r.status, 401);
  assert.equal(r.headers["set-cookie"], undefined);
  assert.match(r.body, /That password didn&#39;t work/);
  assert.ok(Date.now() - started >= 900);
});

test("signing out clears the cookie", async () => {
  const cookie = await signIn();
  const r = await call(page, "POST", { body: { action: "logout" }, cookie });
  assert.equal(r.status, 303);
  assert.match(r.headers["set-cookie"]!, /Max-Age=0/);
});

test("with no password set (or too short), nothing opens", async () => {
  const cookie = await signIn();
  process.env.DASHBOARD_PASSWORD = "short";
  assert.equal((await call(page, "GET", { cookie })).status, 503);
  assert.equal((await call(page, "POST", { body: { password: "short" } })).status, 503);
  assert.equal((await call(data, "GET", { cookie })).status, 503);
});

test("the numbers: 90 Denver days, each thing counted on its own day", async () => {
  const now = Date.now();
  const hoursAgo = (h: number) => new Date(now - h * 3_600_000);
  const put = (pathname: string, at: Date) => store.files.set(pathname, { pathname, uploadedAt: at, body: "{}" });
  put("funnel/reached/a.json", hoursAgo(1));
  put("funnel/reached/b.json", hoursAgo(1));
  put("funnel/responded/a.json", hoursAgo(1));
  put("funnel/contract-sent/c1.json", hoursAgo(1));
  put("test-contracts/c9/contract.json", hoursAgo(1)); // made but never texted: not counted
  put("test-contracts/c1/signed.json", hoursAgo(1));
  put("funnel/reached/old.json", hoursAgo(24 * 200)); // outside the window

  const cookie = await signIn();
  const r = await call(data, "GET", { cookie });
  assert.equal(r.status, 200);
  assert.equal(r.headers["cache-control"], "no-store");
  assert.equal(r.body.stats.length, 90);
  const today = r.body.stats.find((d: any) => d.date === toLocalDay(hoursAgo(1), "America/Denver"));
  assert.deepEqual(today, { date: today.date, reached: 2, responded: 1, contractsSent: 1, contractsSigned: 1 });
  const total = r.body.stats.reduce((n: number, d: any) => n + d.reached, 0);
  assert.equal(total, 2);
});

test("the page says why numbers may be zero: test mode, test contracts, no store", async () => {
  process.env.DRY_RUN = "true";
  const cookie = await signIn();
  let r = await call(data, "GET", { cookie });
  assert.ok(r.body.notices.some((n: string) => /Test mode/.test(n)));
  assert.ok(r.body.notices.some((n: string) => /marked TEST/.test(n)));

  setFunnelBackendForTests({ ...store, ready: () => false });
  r = await call(data, "GET", { cookie });
  assert.equal(r.status, 200);
  assert.ok(r.body.stats.every((d: any) => d.reached + d.responded + d.contractsSent + d.contractsSigned === 0));
  assert.ok(r.body.notices.some((n: string) => /No Blob store/.test(n)));
});

test("if the store fails, the page gets a plain error, not a crash", async () => {
  setFunnelBackendForTests({
    ...store,
    async list() {
      throw new Error("boom");
    },
  });
  const cookie = await signIn();
  const r = await call(data, "GET", { cookie });
  assert.equal(r.status, 500);
  assert.match(r.body.error, /try again/);
});

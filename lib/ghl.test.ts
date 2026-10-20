import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { addTag, getContact, sendSms } from "./ghl.js";

// ghl.ts timeouts and retries, against a local server that fails on demand.

let calls: string[] = [];
let script: Array<number | "hang"> = [];
const server = createServer((req, res) => {
  calls.push(`${req.method} ${req.url}`);
  const next = script.shift() ?? 200;
  if (next === "hang") return; // never answers
  res.writeHead(next, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ contact: { id: "c1" } }));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
server.unref();

beforeEach(() => {
  calls = [];
  script = [];
  process.env.GHL_API_BASE_URL = `http://127.0.0.1:${(server.address() as any).port}`;
  process.env.GHL_API_TOKEN = "t";
  process.env.GHL_RETRY_BASE_MS = "1";
});

after(() => server.close());

test("a 429 or a 5xx is retried, then succeeds", async () => {
  script = [429, 503, 200];
  assert.equal((await getContact("c1")).id, "c1");
  assert.equal(calls.length, 3);
});

test("it gives up after three tries and reports the last answer", async () => {
  script = [500, 500, 500, 500];
  await assert.rejects(getContact("c1"), /getContact failed: 500/);
  assert.equal(calls.length, 3);
});

test("a 4xx other than 429 is not retried", async () => {
  script = [404];
  await assert.rejects(getContact("c1"), /404/);
  assert.equal(calls.length, 1);
});

test("a text is never retried, so a lead can't be texted twice", async () => {
  script = [500, 200];
  await assert.rejects(sendSms("c1", "hi there"), /sendSms failed: 500/);
  assert.equal(calls.length, 1);
});

test("tag writes are retried", async () => {
  script = [502, 200];
  await addTag("c1", "x");
  assert.equal(calls.length, 2);
});

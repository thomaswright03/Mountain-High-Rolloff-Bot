import { test } from "node:test";
import assert from "node:assert/strict";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import handler from "./notFound.js";

function run(url: string) {
  const out: { code?: number; body?: string; headers: Record<string, string> } = { headers: {} };
  const res = {
    setHeader: (k: string, v: string) => ((out.headers[k] = v), res),
    status: (c: number) => ((out.code = c), res),
    send: (b: string) => ((out.body = b), res),
  };
  handler({ url } as VercelRequest, res as unknown as VercelResponse);
  return out;
}

test("the bare domain redirects to the dashboard", () => {
  const r = run("/");
  assert.equal(r.code, 302);
  assert.equal(r.headers.Location, "/dashboard");
});

test("an unknown path gets a branded 404 with the office phone and no Vercel debug text", () => {
  const r = run("/nope");
  assert.equal(r.code, 404);
  assert.match(r.body ?? "", /favicon\.svg/);
  assert.match(r.body ?? "", /970-834-1144/);
  assert.doesNotMatch(r.body ?? "", /DEBUG PROMPT/);
});

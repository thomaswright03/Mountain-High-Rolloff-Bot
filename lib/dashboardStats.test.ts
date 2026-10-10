import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateDailyStats, buildDayRange, toLocalDay } from "./dashboardStats.js";

const TZ = "America/Denver";

test("a moment counts on its Denver calendar day, not UTC's", () => {
  // 11pm Friday in Denver is already Saturday in UTC.
  assert.equal(toLocalDay(new Date("2026-10-10T05:00:00Z"), TZ), "2026-10-09");
  assert.equal(toLocalDay(new Date("2026-10-10T07:00:00Z"), TZ), "2026-10-10");
});

test("the day range ends today in Denver and has no gaps or repeats, even across a clock change", () => {
  // Daylight saving ends Sunday 2026-11-01 in Denver.
  const range = buildDayRange(5, new Date("2026-11-03T06:30:00Z"), TZ); // 11:30pm Mon Nov 2 in Denver
  assert.deepEqual(range, ["2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
  assert.equal(buildDayRange(90, new Date("2026-10-10T18:00:00Z"), TZ).length, 90);
  assert.deepEqual(buildDayRange(3, new Date("2026-03-02T18:00:00Z"), TZ), ["2026-02-28", "2026-03-01", "2026-03-02"]);
});

test("each thing counts on the day it happened, and anything outside the window is left out", () => {
  const range = ["2026-10-08", "2026-10-09", "2026-10-10"];
  const stats = aggregateDailyStats(
    range,
    {
      reached: [new Date("2026-10-08T16:00:00Z"), new Date("2026-10-08T20:00:00Z"), new Date("2026-10-10T05:00:00Z"), new Date("2026-09-01T16:00:00Z")],
      responded: [new Date("2026-10-09T16:00:00Z")],
      contractsSent: [new Date("2026-10-09T17:00:00Z")],
      contractsSigned: [new Date("2026-10-10T17:00:00Z")],
    },
    TZ
  );
  assert.deepEqual(stats, [
    { date: "2026-10-08", reached: 2, responded: 0, contractsSent: 0, contractsSigned: 0 },
    { date: "2026-10-09", reached: 1, responded: 1, contractsSent: 1, contractsSigned: 0 },
    { date: "2026-10-10", reached: 0, responded: 0, contractsSent: 0, contractsSigned: 1 },
  ]);
});

import type { FunnelActivity } from "./funnelStore.js";

export interface DailyStats {
  date: string; // YYYY-MM-DD in the brand's timezone
  reached: number;
  responded: number;
  contractsSent: number;
  contractsSigned: number;
}

/** The calendar day a moment falls on in `timeZone`. en-CA gives
 * YYYY-MM-DD directly. */
export function toLocalDay(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** Every calendar day from `days - 1` days ago through today, oldest
 * first, so days with nothing still show as a row. Steps through calendar
 * dates rather than 24-hour jumps, so a daylight-saving change can't skip
 * or repeat a day. */
export function buildDayRange(days: number, now: Date, timeZone: string): string[] {
  const [y, m, d] = toLocalDay(now, timeZone).split("-").map(Number) as [number, number, number];
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    out.push(new Date(Date.UTC(y, m - 1, d - i)).toISOString().slice(0, 10));
  }
  return out;
}

/** Counts each thing on the day it happened: a lead reached on Monday who
 * signs on Wednesday counts as reached on Monday and signed on Wednesday. */
export function aggregateDailyStats(dayRange: string[], activity: FunnelActivity, timeZone: string): DailyStats[] {
  const byDay = new Map<string, DailyStats>(
    dayRange.map((date) => [date, { date, reached: 0, responded: 0, contractsSent: 0, contractsSigned: 0 }])
  );
  const tally = (moments: Date[], key: Exclude<keyof DailyStats, "date">) => {
    for (const at of moments) {
      const bucket = byDay.get(toLocalDay(at, timeZone));
      if (bucket) bucket[key]++; // outside the window otherwise
    }
  };
  tally(activity.reached, "reached");
  tally(activity.responded, "responded");
  tally(activity.contractsSent, "contractsSent");
  tally(activity.contractsSigned, "contractsSigned");
  return dayRange.map((date) => byDay.get(date)!);
}

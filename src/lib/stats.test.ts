import { describe, expect, it } from "vitest";
import { addDays } from "./dates.ts";
import { changeOver, highLow, lastDays, onOrBefore, type Point } from "./stats.ts";

function weekly(start: string, values: (number | null)[]): Point[] {
  return values.map((value, i) => ({ date: addDays(start, 7 * i), value }));
}

describe("52 week stats on weekly data", () => {
  // 60 Mondays starting 2025-07-21; newest is 2026-09-07.
  const values: (number | null)[] = Array.from({ length: 60 }, (_, i) => 4 + i * 0.01);
  values[20] = 6.5; // a spike inside the window
  values[3] = 7.0; // a spike outside the window
  values[40] = null; // a blank EIA cell
  const s = weekly("2025-07-21", values);
  const newestDate = s[59].date;

  it("uses the newest point as the end", () => {
    expect(newestDate).toBe("2026-09-07");
  });

  it("compares with the week exactly 52 weeks back", () => {
    const c = changeOver(s, 364)!;
    expect(c.from.date).toBe("2025-09-08");
    expect(c.to.date).toBe("2026-09-07");
    expect(c.change).toBeCloseTo(0.52, 10);
    expect(c.pct).toBeCloseTo((0.52 / 4.07) * 100, 10);
  });

  it("does 4 week change", () => {
    const c = changeOver(s, 28)!;
    expect(c.from.date).toBe("2026-08-10");
    expect(c.change).toBe(0.04);
  });

  it("finds the high and low inside the last 52 weeks only", () => {
    const hl = highLow(s)!;
    expect(hl.since).toBe("2025-09-09");
    expect(hl.high).toEqual({ date: "2025-12-08", value: 6.5 });
    expect(hl.low).toEqual({ date: "2025-09-15", value: 4.08 });
    expect(hl.complete).toBe(true);
  });

  it("ignores nulls", () => {
    expect(lastDays(s, 364)).toHaveLength(52);
    expect(onOrBefore(s, s[40].date, 0)).toBeNull();
    expect(onOrBefore(s, s[40].date, 7)!.date).toBe(s[39].date);
  });

  it("returns null when history is too short", () => {
    const short = weekly("2026-08-03", [5, 5.1, 5.2]);
    expect(changeOver(short, 364)).toBeNull();
    expect(highLow(short)!.complete).toBe(false);
  });

  it("does exact money math", () => {
    const s2 = weekly("2026-01-05", [5.967, 6.285]);
    expect(changeOver(s2, 7)!.change).toBe(0.318);
  });

  it("breaks ties toward the most recent date", () => {
    const s3 = weekly("2026-01-05", [5, 6, 5, 6]);
    const hl = highLow(s3)!;
    expect(hl.high.date).toBe("2026-01-26");
    expect(hl.low.date).toBe("2026-01-19");
  });
});

describe("daily data with a missing day", () => {
  const days: Point[] = [];
  for (let i = 0; i < 40; i++) days.push({ date: addDays("2026-08-09", i), value: 6 + i / 1000 });
  const withGap = days.filter((p) => p.date !== "2026-08-20");

  it("falls back to the day before when the exact day is missing", () => {
    const c = changeOver(withGap, 28, 3)!;
    expect(c.to.date).toBe("2026-09-17");
    expect(c.from.date).toBe("2026-08-19");
  });
});

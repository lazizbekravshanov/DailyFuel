import { describe, expect, it } from "vitest";
import { addDays } from "../../lib/dates.ts";
import { chart, H, shortMonthYear, spark, sparkLabel, ticks, W } from "./chart.ts";

/** A weekly series from a start Monday. */
function weeks(start: string, values: (number | null)[]) {
  return values.map((value, i) => ({ date: addDays(start, i * 7), value }));
}

describe("the axis", () => {
  it("picks round dollars, at most five of them", () => {
    expect(ticks(3.4, 6.5)).toEqual([4, 5, 6]);
    expect(ticks(6.01, 6.19)).toEqual([6.05, 6.1, 6.15]);
    expect(ticks(3.19, 8.4)).toEqual([4, 6, 8]);
    expect(ticks(3.19, 7.9)).toEqual([4, 5, 6, 7]);
  });
});

describe("the U.S. line", () => {
  const series = weeks("2022-06-13", [5.718, 5.81, 5.783, 5.675, 5.568, 5.432]);
  const c = chart(series, { label: "U.S. weekly diesel average", mobileHeight: 130 })!;

  it("draws the line and the dot in a 1000 by 300 box, in whole units", () => {
    expect(c.line).toMatch(/^M0 \d+(L\d+ \d+){5}$/);
    expect(c.line.startsWith("M0 ")).toBe(true);
    expect(c.line.endsWith(` ${c.line.split(" ").pop()}`)).toBe(true);
    expect(c.line).toContain(`L${W} `);
    expect(c.dot).toMatch(new RegExp(`^M${W} \\d+h0$`));
    expect(c.grid).toMatch(/^(M0 \d+H1000)+$/);
    // five rules at 5.4 to 5.8; the 5.4 label would sit under the 5.432 tag, so it goes
    expect(c.grid.split("M").length - 1).toBe(5);
    expect(c.yLabels.map((l) => l.text)).toEqual(["5.500", "5.600", "5.700", "5.800"]);
    expect(c.line).not.toMatch(/\d\.\d/);
    expect(H).toBe(300);
  });

  it("prints one value per week for the readout, with the newest as the tag", () => {
    expect(c.start).toBe("2022-06-13");
    expect(c.values).toBe("5.718,5.810,5.783,5.675,5.568,5.432");
    expect(c.count).toBe(6);
    expect(c.tag.text).toBe("5.432");
    expect(c.last).toEqual({ date: "2022-07-18", value: 5.432 });
    expect(c.low).toEqual({ date: "2022-07-18", value: 5.432 });
    expect(c.high).toEqual({ date: "2022-06-20", value: 5.81 });
  });

  it("labels the axis in dollars with three decimals, clear of the tag", () => {
    for (const l of c.yLabels) {
      expect(l.text).toMatch(/^\d\.\d{3}$/);
      expect(Math.abs(l.at - c.tag.at)).toBeGreaterThan(((18 / 130) * 100) - 0.01);
      expect(l.at).toBeGreaterThanOrEqual(0);
      expect(l.at).toBeLessThanOrEqual(100);
    }
  });

  it("marks each year at its first week, and drops a stub first year", () => {
    const long = chart(weeks("2022-06-13", Array.from({ length: 230 }, (_, i) => 4 + (i % 7) / 10)), { label: "x", mobileHeight: 130 })!;
    // Jun 2022 to Nov 2026: the 2022 stub is 13% of the line and would run into 2023, so it goes
    expect(long.xLabels.map((l) => l.text)).toEqual(["2023", "2024", "2025", "2026"]);
    expect(long.xLabels[0].at).toBeGreaterThan(12);
    // a stub that has room keeps its label
    const room = chart(weeks("2022-06-13", Array.from({ length: 120 }, (_, i) => 4 + (i % 7) / 10)), { label: "x", mobileHeight: 130 })!;
    expect(room.xLabels.map((l) => l.text)).toEqual(["2022", "2023", "2024"]);
    const fromJan = chart(weeks("2024-01-01", Array.from({ length: 60 }, (_, i) => 4 + (i % 5) / 10)), { label: "x", mobileHeight: 130 })!;
    expect(fromJan.xLabels.map((l) => l.text)).toEqual(["2024", "2025"]);
    expect(fromJan.xLabels[0].at).toBe(0);
  });

  it("says what a screen reader needs: the stretch, now, the low and the high", () => {
    expect(c.aria).toBe(
      "U.S. weekly diesel average. 6 weeks, Jun 13, 2022 to Jul 18, 2022. Now $5.432. Low $5.432 on Jul 18, 2022, high $5.810 on Jun 20, 2022. Use the left and right arrow keys to read a week.",
    );
    const record = chart(weeks("2026-06-01", [6.0, 6.1, 6.285]), { label: "U.S. weekly diesel average", mobileHeight: 130 })!;
    expect(record.aria).toContain("high $6.285 in the newest week.");
    expect(record.aria).not.toMatch(/[–—]/);
  });

  it("leaves a gap where a week has no price, and an empty slot for the readout", () => {
    const gappy = chart(weeks("2022-06-13", [5.7, null, 5.8, 5.9]), { label: "x", mobileHeight: 130 })!;
    expect(gappy.values).toBe("5.700,,5.800,5.900");
    expect(gappy.line.split("M").length - 1).toBe(2);
    expect(gappy.count).toBe(3);
    // a week missing from the series altogether gets a slot too
    const missing = chart([{ date: "2022-06-13", value: 5.7 }, { date: "2022-06-27", value: 5.8 }, { date: "2022-07-04", value: 5.9 }], { label: "x", mobileHeight: 130 })!;
    expect(missing.values).toBe("5.700,,5.800,5.900");
  });

  it("needs two prices", () => {
    expect(chart(weeks("2022-06-13", [5.7]), { label: "x", mobileHeight: 130 })).toBeNull();
    expect(chart(weeks("2022-06-13", [null, 5.7]), { label: "x", mobileHeight: 130 })).toBeNull();
    expect(chart([], { label: "x", mobileHeight: 130 })).toBeNull();
  });

  it("names where the line starts the short way", () => {
    expect(shortMonthYear("2022-06-13")).toBe("Jun 2022");
    expect(shortMonthYear("2026-01-05")).toBe("Jan 2026");
  });
});

describe("the sparklines", () => {
  it("draw the last 52 weeks in a 100 by 30 box, with a dot on the newest week", () => {
    const series = weeks("2024-01-01", Array.from({ length: 80 }, (_, i) => 3 + (i % 9) / 10));
    const s = spark(series)!;
    expect(s.d).toMatch(/^M1 \d+(L\d+ \d+){51}$/);
    expect(s.end).toMatch(/^M99 \d+h0$/);
    expect(s.last).toEqual(series[79]);
    // the newest 52 only: the high and low are in that window
    expect(s.low.date >= series[28].date).toBe(true);
    expect(s.d).not.toMatch(/\d\.\d/);
  });

  it("say where the line ends, since the low and high sit in the cells beside it", () => {
    const up = spark(weeks("2025-09-15", [3.5, 3.4, 6.25]))!;
    expect(sparkLabel("Midwest", up)).toBe("Midwest, 52 weeks, highest in the newest week");
    const off = spark(weeks("2025-09-15", [3.5, 6.25, 6.1]))!;
    expect(sparkLabel("Midwest", off)).toBe("Midwest, 52 weeks, now $6.100");
  });

  it("skip the weeks with no price and need two of them", () => {
    expect(spark(weeks("2025-09-15", [null, 3.5, null, 3.6]))!.d).toMatch(/^M1 \d+L99 \d+$/);
    expect(spark(weeks("2025-09-15", [3.5]))).toBeNull();
    expect(spark([])).toBeNull();
  });
});

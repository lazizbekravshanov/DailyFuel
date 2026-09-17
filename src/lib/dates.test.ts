import { describe, expect, it } from "vitest";
import {
  addDays,
  daysBetween,
  formatBadgeDate,
  formatDate,
  formatMonthTick,
  formatMonthYear,
  formatShortDate,
  formatWeekdayDate,
  isStale,
  todayInNewYork,
  weekday,
} from "./dates.ts";

describe("today in America/New_York", () => {
  it("is still yesterday late in the evening Eastern", () => {
    // 03:30 UTC on Sep 18 is 11:30 p.m. EDT on Sep 17.
    expect(todayInNewYork(new Date("2026-09-18T03:30:00Z"))).toBe("2026-09-17");
    expect(todayInNewYork(new Date("2026-09-18T04:00:00Z"))).toBe("2026-09-18");
  });

  it("follows standard time in winter", () => {
    // EST is UTC minus 5 hours.
    expect(todayInNewYork(new Date("2026-01-15T04:59:00Z"))).toBe("2026-01-14");
    expect(todayInNewYork(new Date("2026-01-15T05:00:00Z"))).toBe("2026-01-15");
  });

  it("handles the daylight saving switch days", () => {
    // Clocks spring forward 2026-03-08 and fall back 2026-11-01.
    expect(todayInNewYork(new Date("2026-03-08T04:59:00Z"))).toBe("2026-03-07");
    expect(todayInNewYork(new Date("2026-03-08T05:00:00Z"))).toBe("2026-03-08");
    expect(todayInNewYork(new Date("2026-11-02T04:59:00Z"))).toBe("2026-11-01");
    expect(todayInNewYork(new Date("2026-11-02T05:00:00Z"))).toBe("2026-11-02");
  });

  it("does not depend on the machine time zone", () => {
    const before = process.env.TZ;
    process.env.TZ = "Pacific/Auckland";
    try {
      expect(todayInNewYork(new Date("2026-09-17T12:00:00Z"))).toBe("2026-09-17");
      expect(formatShortDate("2026-09-14")).toBe("Sep 14");
    } finally {
      process.env.TZ = before;
    }
  });
});

describe("calendar math", () => {
  it("counts days across months and leap years", () => {
    expect(daysBetween("2026-09-14", "2026-09-17")).toBe(3);
    expect(daysBetween("2024-02-28", "2024-03-01")).toBe(2);
    expect(daysBetween("2026-09-17", "2026-09-14")).toBe(-3);
    expect(addDays("2026-09-14", -364)).toBe("2025-09-15");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("knows EIA periods are Mondays", () => {
    expect(weekday("2026-09-14")).toBe(1);
    expect(weekday("2022-06-13")).toBe(1);
  });

  it("rejects bad dates", () => {
    expect(() => daysBetween("2026-02-30", "2026-03-01")).toThrow(RangeError);
    expect(() => formatShortDate("9/14/26")).toThrow(RangeError);
  });
});

describe("date labels", () => {
  it("formats the way a person would say them", () => {
    expect(formatShortDate("2026-09-14")).toBe("Sep 14");
    expect(formatDate("2026-09-15")).toBe("Sep 15, 2026");
    expect(formatWeekdayDate("2026-09-22")).toBe("Tuesday, Sep 22");
    expect(formatMonthYear("2022-06-13")).toBe("June 2022");
    expect(formatMonthTick("2026-10-01")).toBe("Oct");
    expect(formatMonthTick("2026-01-01")).toBe("2026");
    expect(formatBadgeDate("2026-09-17")).toBe("9/17/26");
    expect(formatBadgeDate("2030-01-05")).toBe("1/5/30");
  });
});

describe("stale prices", () => {
  it("flags AAA at 2 days old", () => {
    expect(isStale({ aaaAsOf: "2026-09-17", eiaPeriod: "2026-09-14" }, "2026-09-18")).toBe(false);
    expect(isStale({ aaaAsOf: "2026-09-16", eiaPeriod: "2026-09-14" }, "2026-09-18")).toBe(true);
  });

  it("flags EIA at 10 days old", () => {
    expect(isStale({ aaaAsOf: null, eiaPeriod: "2026-09-14" }, "2026-09-23")).toBe(false);
    expect(isStale({ aaaAsOf: null, eiaPeriod: "2026-09-14" }, "2026-09-24")).toBe(true);
  });

  it("is quiet with no dates", () => {
    expect(isStale({ aaaAsOf: null, eiaPeriod: null }, "2026-09-24")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  expectedRelease, federalHolidays, formatShortWeekdayDate, isFederalHoliday, LATE_TEXT, nextEiaRelease, nextUpdateText,
} from "./release.ts";

describe("short weekday dates", () => {
  it("reads like a sign", () => {
    expect(formatShortWeekdayDate("2026-09-22")).toBe("Tue, Sep 22");
    expect(formatShortWeekdayDate("2026-09-14")).toBe("Mon, Sep 14");
    expect(formatShortWeekdayDate("2027-01-03")).toBe("Sun, Jan 3");
  });
});

describe("federal holidays", () => {
  it("lists the 2026 days as observed", () => {
    expect(federalHolidays(2026)).toEqual([
      "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-03",
      "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-12-25",
    ]);
  });

  it("moves a Saturday holiday to Friday and a Sunday one to Monday", () => {
    expect(isFederalHoliday("2026-07-03")).toBe(true);
    expect(isFederalHoliday("2026-07-04")).toBe(false);
    expect(isFederalHoliday("2027-07-05")).toBe(true); // Jul 4, 2027 is a Sunday
  });

  it("finds a New Year's Day observed in the year before", () => {
    // Jan 1, 2028 is a Saturday
    expect(isFederalHoliday("2027-12-31")).toBe(true);
  });
});

describe("expected release", () => {
  it("is the Tuesday after the next survey", () => {
    expect(expectedRelease("2026-09-14")).toBe("2026-09-22");
  });

  it("slips to Wednesday after a Monday holiday", () => {
    expect(expectedRelease("2026-08-31")).toBe("2026-09-09"); // Labor Day
    expect(expectedRelease("2026-05-18")).toBe("2026-05-27"); // Memorial Day
    expect(expectedRelease("2026-01-12")).toBe("2026-01-21"); // MLK Day
  });

  it("skips a holiday on the release day itself", () => {
    // Christmas 2029 is a Tuesday
    expect(expectedRelease("2029-12-17")).toBe("2029-12-26");
  });
});

describe("next EIA release", () => {
  it("trusts EIA's own date", () => {
    expect(nextEiaRelease("2026-09-14", "2026-09-22", "2026-09-18")).toEqual({ date: "2026-09-22", late: false });
    expect(nextEiaRelease("2026-08-31", "2026-09-09", "2026-09-05")).toEqual({ date: "2026-09-09", late: false });
  });

  it("is not late on the day itself, only after it", () => {
    expect(nextEiaRelease("2026-09-14", "2026-09-22", "2026-09-22")?.late).toBe(false);
    expect(nextEiaRelease("2026-09-14", "2026-09-22", "2026-09-23")?.late).toBe(true);
  });

  it("falls back to the schedule when EIA's date is missing", () => {
    expect(nextEiaRelease("2026-09-14", null, "2026-09-18")).toEqual({ date: "2026-09-22", late: false });
  });

  it("ignores a date left over from the week before", () => {
    // the current week's own release, not the next one
    expect(nextEiaRelease("2026-09-14", "2026-09-15", "2026-09-18")?.date).toBe("2026-09-22");
    expect(nextEiaRelease("2026-09-14", "2026-09-08", "2026-09-18")?.date).toBe("2026-09-22");
  });

  it("says nothing without a week", () => {
    expect(nextEiaRelease(null, "2026-09-22", "2026-09-18")).toBeNull();
  });
});

describe("wording", () => {
  // The paper terminal's week line ends "Next release Tue, Sep 22.", and the
  // "Weekly number." lead of the old sign went with the sign.
  it("reads the way the mockup's week line says", () => {
    expect(nextUpdateText("2026-09-22")).toBe("Next release Tue, Sep 22.");
    expect(LATE_TEXT).toBe("The next release is late.");
  });

  it("never uses dashes as punctuation", () => {
    for (const t of [LATE_TEXT, nextUpdateText("2026-09-22")]) expect(t).not.toMatch(/[–—]| - /);
  });
});

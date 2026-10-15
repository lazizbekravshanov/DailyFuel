import { describe, expect, it } from "vitest";
import {
  BASE_ERROR, centsText, DEFAULT_BASE, DEFAULT_MPG, MPG_ERROR, perMileTenths, readBase, readMpg, surcharge,
  SURCHARGE_SERIES,
} from "./surcharge.ts";

const DASH = /[–—]| - /;

describe("reading what a driver types", () => {
  it("reads a base price from 0 to 10 dollars, with or without a $", () => {
    expect(readBase("1.25")).toBe(1.25);
    expect(readBase(" 1.25 ")).toBe(1.25);
    expect(readBase("$1.25")).toBe(1.25);
    expect(readBase("$ 1.25")).toBe(1.25);
    expect(readBase(".9")).toBe(0.9);
    expect(readBase("2.")).toBe(2);
    expect(readBase("0")).toBe(0);
    expect(readBase("10")).toBe(10);
    expect(readBase(DEFAULT_BASE)).toBe(1.25);
  });

  it("refuses a base that isn't a plain number from 0 to 10", () => {
    for (const v of ["", " ", "$", ".", "-1", "−1", "10.01", "12", "1,25", "1.2.5", "abc", "1e0", "0x1", "Infinity", "NaN", "1 25", "$$1"]) {
      expect(readBase(v), v).toBeNull();
    }
  });

  it("reads miles per gallon from 2 to 20, like the map", () => {
    expect(readMpg("6")).toBe(6);
    expect(readMpg("6.5")).toBe(6.5);
    expect(readMpg(" 7 ")).toBe(7);
    expect(readMpg("2")).toBe(2);
    expect(readMpg("20")).toBe(20);
    expect(readMpg(DEFAULT_MPG)).toBe(6);
    for (const v of ["", "0", "1.99", "20.5", "-6", "$6", "6 mpg", "six", "6e0", "Infinity"]) expect(readMpg(v), v).toBeNull();
  });
});

describe("the surcharge a mile", () => {
  it("is the price over the base, over the MPG, in tenths of a cent", () => {
    // the example: $6.200 against a $1.25 base at 6 MPG is 82.5¢ a mile
    expect(perMileTenths(6.2, 1.25, 6)).toBe(825);
    expect(perMileTenths(3.75, 1.25, 5)).toBe(500);
    expect(perMileTenths(6.179, 1.25, 6.5)).toBe(758); // 4.929 / 6.5 = 75.83¢
  });

  it("rounds half up, to a tenth of a cent, with no float noise", () => {
    // 4.929 / 6 is 82.15¢ exactly, which rounds up
    expect(perMileTenths(6.179, 1.25, 6)).toBe(822);
    // 0.001 / 2 is 0.05¢, which rounds up to 0.1¢
    expect(perMileTenths(1.251, 1.25, 2)).toBe(1);
    // under a half rounds down
    expect(perMileTenths(1.251, 1.25, 6)).toBe(0);
    // prices a double can't hold exactly
    expect(perMileTenths(4.1, 1.2, 2.9)).toBe(1000);
    expect(perMileTenths(0.3, 0.1, 2)).toBe(100);
    // a base typed past the tenth of a cent rounds like a price does
    expect(perMileTenths(3.25, 1.2495, 2)).toBe(1000);
  });

  it("never goes below 0", () => {
    expect(perMileTenths(1.25, 1.25, 6)).toBe(0);
    expect(perMileTenths(1.1, 1.25, 6)).toBe(0);
    expect(perMileTenths(0, 10, 2)).toBe(0);
  });

  it("is null with no price, base or MPG to use", () => {
    expect(perMileTenths(null, 1.25, 6)).toBeNull();
    expect(perMileTenths(6.2, null, 6)).toBeNull();
    expect(perMileTenths(6.2, 1.25, null)).toBeNull();
    expect(perMileTenths(6.2, 1.25, 0)).toBeNull();
    expect(perMileTenths(Number.NaN, 1.25, 6)).toBeNull();
    expect(perMileTenths(6.2, Number.POSITIVE_INFINITY, 6)).toBeNull();
    expect(perMileTenths(6.2, -1, 6)).toBeNull();
    expect(perMileTenths(6.2, 1.25, -6)).toBeNull();
  });

  it("prints cents to a tenth", () => {
    expect(centsText(825)).toBe("82.5¢");
    expect(centsText(0)).toBe("0.0¢");
    expect(centsText(7)).toBe("0.7¢");
    expect(centsText(1140)).toBe("114.0¢");
  });
});

describe("the answer and its line", () => {
  const week = { name: "U.S.", period: "2026-10-12" };

  it("says the surcharge a mile and on 1,000 miles in one sentence, then what it used", () => {
    expect(surcharge({ ...week, price: 6.2, base: 1.25, mpg: 6 })).toEqual({
      answer: "82.5¢ a mile, $825 on 1,000 miles.",
      used: "U.S. DOE price $6.200, week of Oct 12, 2026. Base $1.250, 6 MPG.",
    });
    expect(surcharge({ name: "West Coast outside California", period: "2026-01-05", price: 8.091, base: 1.2, mpg: 6.5 })).toEqual({
      answer: "106.0¢ a mile, $1,060 on 1,000 miles.",
      used: "West Coast outside California DOE price $8.091, week of Jan 5, 2026. Base $1.200, 6.5 MPG.",
    });
  });

  it("says so plainly when the price is at or under the base", () => {
    const none = "No surcharge this week, since the price is at or under your base.";
    expect(surcharge({ ...week, price: 3.5, base: 3.5, mpg: 6 }).answer).toBe(none);
    expect(surcharge({ ...week, price: 3.499, base: 4, mpg: 6 })).toEqual({
      answer: none,
      used: "U.S. DOE price $3.499, week of Oct 12, 2026. Base $4.000, 6 MPG.",
    });
    // just over the base is a surcharge, even one too small to show
    expect(surcharge({ ...week, price: 3.501, base: 3.5, mpg: 6 }).answer).toBe("0.0¢ a mile, $0 on 1,000 miles.");
  });

  it("says when EIA has no price for that week", () => {
    expect(surcharge({ name: "Midwest", period: "2026-10-05", price: null, base: 1.25, mpg: 6 })).toEqual({
      answer: "There's no Midwest DOE price for the week of Oct 5, 2026. Pick another week.",
      used: "",
    });
  });

  it("says nothing while a field needs fixing, since the field says what's wrong", () => {
    expect(surcharge({ ...week, price: 6.2, base: null, mpg: 6 })).toEqual({ answer: "", used: "" });
    expect(surcharge({ ...week, price: 6.2, base: 1.25, mpg: null })).toEqual({ answer: "", used: "" });
    expect(surcharge({ ...week, price: null, base: null, mpg: null })).toEqual({ answer: "", used: "" });
  });

  it("rounds every price and base a contract might use to the nearest tenth of a cent", () => {
    for (let p = 2500; p <= 8000; p += 37) {
      for (const b of [0, 1, 1.15, 1.2, 1.25, 2.5, 3.999]) {
        for (const m of [4, 5, 5.5, 6, 6.5, 7]) {
          const t = perMileTenths(p / 1000, b, m)!;
          const want = Math.round(((p - Math.round(b * 1000)) / m) * 1e6) / 1e6;
          const exact = Math.max(0, want);
          expect(Math.abs(t - exact), `${p} ${b} ${m}`).toBeLessThanOrEqual(0.5);
        }
      }
    }
  });

  it("uses no dash as punctuation in anything it says", () => {
    const said = [
      BASE_ERROR,
      MPG_ERROR,
      ...Object.values(surcharge({ ...week, price: 6.2, base: 1.25, mpg: 6 })),
      ...Object.values(surcharge({ ...week, price: 1, base: 1.25, mpg: 6 })),
      surcharge({ ...week, price: null, base: 1.25, mpg: 6 }).answer,
    ];
    for (const t of said) expect(t, t).not.toMatch(DASH);
  });

  it("offers the U.S. and every region, each once", () => {
    expect(SURCHARGE_SERIES[0]).toBe("NUS");
    expect(new Set(SURCHARGE_SERIES).size).toBe(11);
  });
});

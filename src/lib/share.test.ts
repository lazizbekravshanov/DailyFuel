import { describe, expect, it } from "vitest";
import statesFile from "../data/states.json";
import type { BenchmarkKey, Move } from "./data.ts";
import type { SiteData, StateView } from "./site.ts";
import { homeShareText, stateShareText } from "./share.ts";

const REGION: Record<BenchmarkKey, string> = {
  R1X: "New England",
  R1Y: "Central Atlantic",
  R1Z: "Lower Atlantic",
  R20: "Midwest",
  R30: "Gulf Coast",
  R40: "Rocky Mountain",
  SCA: "California",
  R5XCA: "West Coast outside California",
};

// Prices from the week of Sep 14, 2026.
const PRICE: Record<BenchmarkKey, [number, number]> = {
  R1X: [6.202, 0.29],
  R1Y: [6.312, 0.291],
  R1Z: [6.096, -0.021],
  R20: [6.25, 0.304],
  R30: [6.027, 0.273],
  R40: [6.066, 0],
  SCA: [8.039, 0.275],
  R5XCA: [6.566, 0.252],
};

function move(price: number, change: number | null): Move {
  return { price, prev: change === null ? null : price - change, change, change_pct: null, direction: null };
}

function site(opts: { us?: Move | null; noChange?: string } = {}): SiteData {
  const states = statesFile.states.map((info) => {
    const series = info.eia_series as BenchmarkKey | null;
    const [price, change] = series ? PRICE[series] : [0, 0];
    return {
      ...info,
      eia_series: series,
      regionName: series ? REGION[series] : null,
      cadence: "weekly",
      primary: series ? move(price, info.code === opts.noChange ? null : change) : null,
    } as unknown as StateView;
  });
  const us = opts.us === undefined ? move(6.285, 0.318) : opts.us;
  return {
    mode: "eia_only",
    latest: { eia: { period: "2026-09-14", prev_period: "2026-09-07" }, aaa: null },
    states,
    byCode: new Map(states.map((s) => [s.code, s])),
    national: { cadence: "weekly", move: us, date: "2026-09-14", prevDate: "2026-09-07" },
    eiaUs: us,
  } as unknown as SiteData;
}

/** The same site with AAA on: daily prices for every state, AK and HI included. */
function aaaSite(gapDays = 1): SiteData {
  const base = site();
  const states = base.states.map((s) => ({ ...s, cadence: "daily", primary: move(6.1, s.code === "OH" ? 0.031 : -0.012) }) as StateView);
  return {
    ...base,
    mode: "aaa+eia",
    latest: {
      ...base.latest,
      aaa: { as_of: "2026-09-18", prev_as_of: gapDays > 1 ? "2026-09-15" : "2026-09-17", gap_days: gapDays },
    },
    states,
    byCode: new Map(states.map((s) => [s.code, s])),
    national: { cadence: "daily", move: move(6.2, 0.018), date: "2026-09-18", prevDate: "2026-09-17" },
  } as unknown as SiteData;
}

const S = site();
const by = (code: string, from = S) => from.byCode.get(code)!;

describe("share sentence on a state page", () => {
  // In a group chat a bare "Ohio diesel is $6.250" reads as Ohio's own
  // measured price. EIA prices regions, so the sentence says whose average
  // it is before it gives the number.
  it("says the price is the region's average, then the move", () => {
    expect(stateShareText(by("OH"), S)).toBe(
      "Diesel in Ohio's region, the Midwest, averaged $6.250 a gallon this week, up 30.4 cents. Weekly DOE price.",
    );
    expect(stateShareText(by("FL"), S)).toBe(
      "Diesel in Florida's region, the Lower Atlantic, averaged $6.096 a gallon this week, down 2.1 cents. Weekly DOE price.",
    );
  });

  it("calls California's number its own and the rest of the coast what it is", () => {
    expect(stateShareText(by("CA"), S)).toBe("California diesel averaged $8.039 a gallon this week, up 27.5 cents. Weekly DOE price.");
    expect(stateShareText(by("OR"), S)).toBe(
      "Diesel in Oregon's region, the West Coast outside California, averaged $6.566 a gallon this week, up 25.2 cents. Weekly DOE price.",
    );
  });

  it("never words a regional price as the state's own", () => {
    for (const s of S.states) {
      if (!s.primary || s.eia_series === "SCA") continue;
      const text = stateShareText(s, S);
      expect(text).toMatch(/^Diesel in .+'s region, the /);
      expect(text).not.toMatch(new RegExp(`^${s.code === "DC" ? "DC" : s.name} diesel`));
    }
  });

  it("says no change, or leaves the move out when there's no week before", () => {
    expect(stateShareText(by("UT"), S)).toBe(
      "Diesel in Utah's region, the Rocky Mountain, averaged $6.066 a gallon this week, no change. Weekly DOE price.",
    );
    const s = site({ noChange: "OH" });
    expect(stateShareText(by("OH", s), s)).toBe("Diesel in Ohio's region, the Midwest, averaged $6.250 a gallon this week. Weekly DOE price.");
  });

  it("calls DC by its short name", () => {
    expect(stateShareText(by("DC"), S)).toBe(
      "Diesel in DC's region, the Central Atlantic, averaged $6.312 a gallon this week, up 29.1 cents. Weekly DOE price.",
    );
  });

  it("says Alaska and Hawaii have no price of their own and gives the U.S. one, like their pages", () => {
    for (const [code, name] of [["AK", "Alaska"], ["HI", "Hawaii"]]) {
      const text = stateShareText(by(code), S);
      expect(text).toBe(
        `The government's weekly survey does not cover ${name}, so there is no ${name} price. U.S. diesel averaged $6.285 a gallon this week.`,
      );
      // the only number is the U.S. average, said as the U.S. one
      expect(text.match(/\$[\d.]+/g)).toEqual(["$6.285"]);
      expect(text).not.toMatch(new RegExp(`${name} (diesel|price) (is|averaged)`));
      // with no U.S. price either, there is no number at all
      const bare = site({ us: null });
      expect(stateShareText(by(code, bare), bare)).toBe(`The government's weekly survey does not cover ${name}, so there is no ${name} price.`);
    }
  });

  it("says AAA daily, and the day it's compared with, when AAA is on", () => {
    const a = aaaSite();
    expect(stateShareText(by("OH", a), a)).toBe("Ohio diesel is $6.100 a gallon, up 3.1 cents since yesterday. AAA daily average.");
    expect(stateShareText(by("AK", a), a)).toBe("Alaska diesel is $6.100 a gallon, down 1.2 cents since yesterday. AAA daily average.");
    const gap = aaaSite(3);
    expect(stateShareText(by("OH", gap), gap)).toBe("Ohio diesel is $6.100 a gallon, up 3.1 cents since Sep 15. AAA daily average.");
  });

  it("uses no dashes as punctuation", () => {
    for (const s of S.states) expect(stateShareText(s, S)).not.toMatch(/[‒-―]| - /);
  });
});

describe("share sentence on the home page", () => {
  it("is the U.S. number the headline prints", () => {
    expect(homeShareText(S)).toBe("U.S. diesel is $6.285 a gallon, up 31.8 cents this week. DOE weekly average.");
    const a = aaaSite();
    expect(homeShareText(a)).toBe("U.S. diesel is $6.200 a gallon, up 1.8 cents since yesterday. AAA daily average.");
  });

  it("keeps AAA's national move since yesterday after a skipped state day, like the headline", () => {
    expect(homeShareText(aaaSite(3))).toBe("U.S. diesel is $6.200 a gallon, up 1.8 cents since yesterday. AAA daily average.");
  });

  it("still says something plain with no national price", () => {
    expect(homeShareText(site({ us: null }))).toBe("Diesel prices for every state, and which way they moved.");
  });
});

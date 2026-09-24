import { describe, expect, it } from "vitest";
import statesFile from "../data/states.json";
import type { BenchmarkKey, Move } from "./data.ts";
import type { SiteData, StateView } from "./site.ts";
import {
  countPlaces, missingNote, noSurveyNote, pctOf, samePriceCaption, samePriceMeta, stateDescription,
} from "./copy.ts";
import { homeMeta } from "../components/home/home.ts";
import { formatMove } from "./format.ts";

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
  R1Z: [6.096, 0.262],
  R20: [6.25, 0.304],
  R30: [6.027, 0.273],
  R40: [6.066, 0.212],
  SCA: [8.039, 0.275],
  R5XCA: [6.566, 0.252],
};

function move(price: number, change: number | null): Move {
  return { price, prev: change === null ? null : price - change, change, change_pct: null, direction: null };
}

function site(opts: { priced?: (code: string) => boolean; us?: Move | null; flat?: string } = {}): SiteData {
  const states = statesFile.states.map((info) => {
    const series = info.eia_series as BenchmarkKey | null;
    const priced = series !== null && (opts.priced ? opts.priced(info.code) : true);
    const [price, change] = series ? PRICE[series] : [0, 0];
    return {
      ...info,
      eia_series: series,
      regionName: series ? REGION[series] : null,
      cadence: "weekly",
      primary: priced ? move(price, series === opts.flat ? 0 : change) : null,
      tax: { state: 1 },
    } as unknown as StateView;
  });
  const us = opts.us === undefined ? move(6.285, 0.318) : opts.us;
  return {
    mode: "eia_only",
    latest: { eia: { period: "2026-09-14", prev_period: "2026-09-07" }, aaa: null },
    states,
    byCode: new Map(states.map((s) => [s.code, s])),
    national: { cadence: "weekly", move: us, date: "2026-09-14", prevDate: "2026-09-07" },
  } as unknown as SiteData;
}

const S = site();
const by = (code: string) => S.byCode.get(code)!;

describe("counting places", () => {
  it("keeps DC apart from the states", () => {
    expect(countPlaces([{ code: "OH" }, { code: "IN" }], true)).toBe("2 other states");
    expect(countPlaces([{ code: "DE" }, { code: "DC" }], true, "Central Atlantic")).toBe("1 other Central Atlantic state and DC");
    expect(countPlaces([{ code: "DE" }, { code: "MD" }], false)).toBe("2 states");
    expect(countPlaces([{ code: "DC" }], true)).toBe("DC");
    expect(countPlaces([], true)).toBe("");
  });
});

describe("state meta description", () => {
  it("reads the way the plan wrote it for Ohio", () => {
    expect(stateDescription(by("OH"), S)).toBe(
      "Diesel in Ohio averaged $6.250 a gallon on Sep 14, up 30.4¢. That's the DOE Midwest average Ohio shares with 14 other states.",
    );
  });

  it("counts DC apart in the Central Atlantic", () => {
    expect(stateDescription(by("MD"), S)).toMatch(/That's the DOE Central Atlantic average Maryland shares with 4 other states and DC\.$/);
    expect(stateDescription(by("DC"), S)).toMatch(/^Diesel in DC averaged \$6\.312 .* That's the DOE Central Atlantic average DC shares with 5 states\.$/);
  });

  it("gets every region's count right", () => {
    const expected: Record<string, string> = {
      CT: "5 other states", FL: "5 other states", TX: "5 other states", CO: "4 other states", IA: "14 other states",
    };
    for (const [code, count] of Object.entries(expected)) expect(stateDescription(by(code), S)).toContain(`shares with ${count}.`);
  });

  it("names the West Coast outside California plainly", () => {
    expect(stateDescription(by("AZ"), S)).toMatch(
      /That's the DOE average for the West Coast outside California, which Arizona shares with 3 other states\.$/,
    );
  });

  it("says California stands alone", () => {
    expect(stateDescription(by("CA"), S)).toBe(
      "Diesel in California averaged $8.039 a gallon on Sep 14, up 27.5¢. That's the DOE weekly price for California, the one state EIA prices on its own.",
    );
  });

  it("gives Alaska and Hawaii no number", () => {
    const ak = stateDescription(by("AK"), S);
    expect(ak).toBe("EIA doesn't survey diesel prices in Alaska, so there's no DOE weekly number. See the closest region EIA surveys and Alaska's diesel tax.");
    expect(stateDescription(by("HI"), S)).toMatch(/^EIA doesn't survey diesel prices in Hawaii/);
  });

  it("handles a flat week", () => {
    const flat = site({ flat: "R20" });
    expect(stateDescription(flat.byCode.get("OH")!, flat)).toMatch(/on Sep 14, unchanged from the week before\. /);
  });

  it("never uses dashes as punctuation", () => {
    for (const s of S.states) expect(stateDescription(s, S)).not.toMatch(/[–—]| - /);
  });
});

describe("state page sentences", () => {
  // sourceSentence, samePriceLead and vsUsSentence went with the road sign:
  // the paper terminal's plate, SAME PRICE head and U.S. line say it instead

  it("heads the same price table with who shares the number", () => {
    expect(samePriceMeta(by("OH"), S)).toBe("15 states read $6.250 this week");
    expect(samePriceMeta(by("MD"), S)).toBe("5 states and DC read $6.312 this week");
    expect(samePriceMeta(by("DC"), S)).toBe("5 states and DC read $6.312 this week");
    expect(samePriceMeta(by("WA"), S)).toBe("4 states read $6.566 this week");
    expect(samePriceMeta(by("CA"), S)).toBeNull();
    expect(samePriceMeta(by("AK"), S)).toBeNull();
    expect(samePriceCaption(by("OH"))).toBe("One EIA price covers the whole Midwest region. The state tax on top of it is different in each one.");
    expect(samePriceCaption(by("WA"))).toMatch(/^One EIA price covers the whole West Coast outside California region\./);
  });

  it("gives Alaska and Hawaii the nearest number EIA prints", () => {
    const west = move(7.25, 0.263);
    expect(noSurveyNote(by("AK"), west)).toBe(
      "EIA doesn't survey diesel in Alaska, so there is no weekly number for it. The nearest region EIA does survey is the West Coast, which read $7.250 this week, +26.3¢ on the week.",
    );
    expect(noSurveyNote(by("HI"), move(7.25, -0.05))).toMatch(/Hawaii.*\$7\.250 this week, −5\.0¢ on the week\.$/);
    expect(noSurveyNote(by("HI"), move(7.25, null))).toMatch(/read \$7\.250 this week\.$/);
    expect(noSurveyNote(by("AK"), null)).toBe(
      "EIA doesn't survey diesel in Alaska, so there is no weekly number for it. The nearest region EIA does survey is the West Coast.",
    );
  });
});

describe("home meta description", () => {
  // The home page builds its meta the same way: homeMeta counts the places
  // with a price, missingNote says why the rest are missing.
  const meta = (x: SiteData) =>
    homeMeta({
      price: x.national.move?.price ?? null,
      change: x.national.move?.change ?? null,
      daily: false,
      priced: x.states.filter((s) => s.primary).map((s) => s.code),
      regions: 8,
    }) + missingNote(x);

  it("never claims Alaska and Hawaii in EIA mode", () => {
    expect(missingNote(S)).toBe(" EIA doesn't survey Alaska or Hawaii.");
    expect(meta(S)).toBe(
      "U.S. diesel is $6.285 a gallon, up 31.8¢ this week. See the DOE weekly price for the 8 regions that cover 48 states and DC. EIA doesn't survey Alaska or Hawaii.",
    );
    expect(meta(S).length).toBeLessThanOrEqual(160);
  });

  it("says all 50 states and DC when every one has a price", () => {
    const all = site();
    for (const s of all.states) if (!s.primary) (s as { primary: Move | null }).primary = move(6, 0.1);
    expect(missingNote(all)).toBe("");
    expect(meta(all)).toMatch(/cover all 50 states and DC\.$/);
  });

  it("stays general when a whole region is missing", () => {
    const gap = site({ priced: (c) => !["OH", "IN", "IA", "KS"].includes(c) });
    expect(meta(gap)).toMatch(/cover 44 states and DC\. Some states have no price right now\.$/);
  });

  it("names a surveyed state with no price as missing, not unsurveyed", () => {
    const one = site({ priced: (c) => c !== "OH" });
    expect(missingNote(one)).toBe(" There's no price for Alaska, Hawaii or Ohio right now.");
  });
});

describe("the percent on a move", () => {
  it("comes from the raw numbers, rounded once", () => {
    // U.S., week of Aug 17, 2026: +0.197 on $5.257 is +3.7474%. The stored
    // change_pct is 3.75, and rounding that again printed +3.8%.
    const us: Move = { price: 5.454, prev: 5.257, change: 0.197, change_pct: 3.75, direction: "up" };
    expect(pctOf(us)).toBeCloseTo(3.7474, 4);
    expect(formatMove(us.change!, pctOf(us))).toBe("+19.7¢ +3.7%");
    // West Coast outside California, week of Mar 16, 2026: +5.3459%.
    const wc: Move = { price: 5.0506, prev: 4.7943, change: 0.2563, change_pct: 5.35, direction: "up" };
    expect(formatMove(wc.change!, pctOf(wc))).toBe("+25.6¢ +5.3%");
    // a fall: −0.021 on $6.072 is −0.3458%, not −0.4%
    const va: Move = { price: 6.051, prev: 6.072, change: -0.021, change_pct: -0.35, direction: "down" };
    expect(formatMove(va.change!, pctOf(va))).toBe("−2.1¢ −0.3%");
  });

  it("falls back to the stored percent with no previous price", () => {
    expect(pctOf({ price: 6.25, prev: null, change: 0.3, change_pct: 5.1, direction: "up" })).toBe(5.1);
    expect(pctOf({ price: 6.25, prev: null, change: null, change_pct: null, direction: null })).toBeNull();
  });
});

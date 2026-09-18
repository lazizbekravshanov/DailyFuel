import { describe, expect, it } from "vitest";
import statesFile from "../data/states.json";
import type { BenchmarkKey, Move } from "./data.ts";
import type { SiteData, StateView } from "./site.ts";
import {
  countPlaces, homeDescription, regionMates, samePriceLead, sourceSentence, stateDescription, vsUsSentence,
} from "./copy.ts";

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
  it("counts the region with DC apart", () => {
    expect(sourceSentence(by("OH"), S)).toMatch(/Midwest region, which covers 15 states\.$/);
    expect(sourceSentence(by("PA"), S)).toMatch(/Central Atlantic region, which covers 5 states and DC\.$/);
  });

  it("collapses identical peers into one line", () => {
    expect(samePriceLead(by("OH"), regionMates(by("OH"), S))).toBe("Same price in 14 other Midwest states:");
    expect(samePriceLead(by("MD"), regionMates(by("MD"), S))).toBe("Same price in 4 other Central Atlantic states and DC:");
    expect(samePriceLead(by("DC"), regionMates(by("DC"), S))).toBe("Same price in 5 Central Atlantic states:");
    expect(samePriceLead(by("WA"), regionMates(by("WA"), S))).toBe("Same price in 3 other West Coast states outside California:");
  });

  it("compares with the U.S. average from the numbers", () => {
    expect(vsUsSentence(by("OH"), S)).toBe("That's 3.5¢ below the U.S. average.");
    expect(vsUsSentence(by("CA"), S)).toBe("That's 175.4¢ above the U.S. average.");
    expect(vsUsSentence(by("AK"), S)).toBeNull();
    const same = site({ us: move(6.25, 0.3) });
    expect(vsUsSentence(same.byCode.get("OH")!, same)).toBe("That's the same as the U.S. average.");
    expect(vsUsSentence(by("OH"), site({ us: null }))).toBeNull();
  });
});

describe("home meta description", () => {
  it("never claims Alaska and Hawaii in EIA mode", () => {
    expect(homeDescription(S)).toBe(
      "U.S. diesel is $6.285 a gallon, up 31.8¢ this week. See the weekly price and change for 48 states and DC. EIA doesn't survey Alaska or Hawaii.",
    );
  });

  it("says all 50 states and DC when every one has a price", () => {
    const all = site();
    for (const s of all.states) if (!s.primary) (s as { primary: Move | null }).primary = move(6, 0.1);
    expect(homeDescription(all)).toMatch(/for all 50 states and DC\.$/);
  });

  it("stays general when a whole region is missing", () => {
    const gap = site({ priced: (c) => !["OH", "IN", "IA", "KS"].includes(c) });
    expect(homeDescription(gap)).toMatch(/for 44 states and DC\. Some states have no price right now\.$/);
  });
});

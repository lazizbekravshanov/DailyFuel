import { describe, expect, it } from "vitest";
import statesFile from "../data/states.json";
import type { BenchmarkKey, Move } from "./data.ts";
import type { SiteData, StateView } from "./site.ts";
import { eiaPlate, NO_SURVEY_PLATE, regionAverage, regionPlate, yourStateData } from "./yourstate.ts";

// islandJson is gone: the strip's data rides on the Find your state links as
// attributes now, so there is no JSON island to make safe.

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
  R30: [6.027, 0.004],
  R40: [6.066, 0.212],
  SCA: [8.039, 0.275],
  R5XCA: [6.566, 0.252],
};

function move(price: number, change: number | null): Move {
  return { price, prev: change === null ? null : price - change, change, change_pct: null, direction: null };
}

function site(mode: "eia_only" | "aaa+eia" = "eia_only", opts: { priced?: (code: string) => boolean; gap?: number } = {}): SiteData {
  const aaa = mode === "aaa+eia";
  const states = statesFile.states.map((info) => {
    const series = info.eia_series as BenchmarkKey | null;
    const priced = aaa || (series !== null && (opts.priced ? opts.priced(info.code) : true));
    const [price, change] = series ? PRICE[series] : [6.5, 0.1];
    return {
      ...info,
      eia_series: series,
      regionName: series ? REGION[series] : null,
      cadence: aaa ? "daily" : "weekly",
      primary: priced ? move(price, change) : null,
    } as unknown as StateView;
  });
  return {
    mode,
    latest: {
      eia: { period: "2026-09-14", prev_period: "2026-09-07" },
      aaa: aaa ? { as_of: "2026-09-17", prev_as_of: opts.gap ? "2026-09-15" : "2026-09-16", gap_days: opts.gap ?? 1 } : null,
    },
    states,
    byCode: new Map(states.map((s) => [s.code, s])),
  } as unknown as SiteData;
}

const at = (sd: SiteData, code: string) => sd.byCode.get(code)!;

describe("the plate under the price", () => {
  const sd = site();

  it("names the region and how many share its price", () => {
    expect(regionPlate(at(sd, "OH"), sd)).toBe("EIA Midwest average, 15 states");
    expect(regionPlate(at(sd, "FL"), sd)).toBe("EIA Lower Atlantic average, 6 states");
    expect(regionPlate(at(sd, "CO"), sd)).toBe("EIA Rocky Mountain average, 5 states");
  });

  it("counts DC apart from the states in the Central Atlantic", () => {
    expect(regionPlate(at(sd, "NY"), sd)).toBe("EIA Central Atlantic average, 5 states and DC");
    expect(regionPlate(at(sd, "DC"), sd)).toBe("EIA Central Atlantic average, 5 states and DC");
  });

  it("says the West Coast outside California plainly", () => {
    expect(regionPlate(at(sd, "WA"), sd)).toBe("EIA West Coast average outside California, 4 states");
  });

  it("gives California its own, and says why Alaska and Hawaii have none, so every state's row carries one like the mockup", () => {
    // these three read null before: the strip printed no plate for them,
    // while the state page and the card printed "EIA California average"
    expect(regionPlate(at(sd, "CA"), sd)).toBe("EIA California average");
    expect(regionPlate(at(sd, "AK"), sd)).toBe(NO_SURVEY_PLATE);
    expect(regionPlate(at(sd, "HI"), sd)).toBe("EIA doesn't survey this state");
  });

  it("goes away once AAA's per state prices are the source", () => {
    const aaa = site("aaa+eia");
    for (const s of aaa.states) expect(regionPlate(s, aaa)).toBeNull();
  });

  it("never sits under a missing price", () => {
    const blank = site("eia_only", { priced: (c) => c !== "OH" });
    expect(regionPlate(at(blank, "OH"), blank)).toBeNull();
  });

  it("never uses a dash", () => {
    for (const s of sd.states) expect(regionPlate(s, sd) ?? "").not.toMatch(/[–—]| - /);
  });

  it("uses the same words the state page and the share cards use, in any mode", () => {
    const aaa = site("aaa+eia");
    for (const s of sd.states) {
      if (s.eia_series) expect(eiaPlate(s, sd)).toBe(regionPlate(s, sd));
    }
    expect(regionAverage(at(aaa, "WA"), aaa)).toBe("EIA West Coast average outside California, 4 states");
    expect(eiaPlate(at(aaa, "WA"), aaa)).toBe("EIA West Coast average outside California, 4 states");
    expect(regionAverage(at(aaa, "CA"), aaa)).toBeNull();
    expect(eiaPlate(at(aaa, "CA"), aaa)).toBe("EIA California average");
    expect(regionAverage(at(aaa, "AK"), aaa)).toBeNull();
    expect(eiaPlate(at(aaa, "AK"), aaa)).toBeNull();
  });
});

describe("your state data for the home page strip", () => {
  it("lists all 51 in states.json order, printed the way the page prints money", () => {
    const d = yourStateData(site());
    expect(d).toHaveLength(51);
    expect(d.map((s) => s.code)).toEqual(statesFile.states.map((s) => s.code));
    expect(d.find((s) => s.code === "OH")).toEqual({
      code: "OH", name: "Ohio", price: "$6.250", move: "+30.4¢ +5.1%", ink: "up", plate: "EIA Midwest average, 15 states",
    });
    expect(d.find((s) => s.code === "FL")).toEqual(expect.objectContaining({ price: "$6.096", move: "−2.1¢ −0.3%", ink: "down" }));
  });

  it("gives Alaska and Hawaii no number to borrow, in the words their page and the mockup use", () => {
    const d = yourStateData(site());
    for (const code of ["AK", "HI"]) {
      expect(d.find((s) => s.code === code)).toEqual(expect.objectContaining({ price: "No EIA price", move: "", ink: "muted", plate: "EIA doesn't survey this state" }));
    }
    expect(d.find((s) => s.code === "CA")).toEqual(expect.objectContaining({ price: "$8.039", plate: "EIA California average" }));
  });

  it("follows the bins for the ink, so a tiny change prints but stays muted", () => {
    const d = yourStateData(site());
    expect(d.find((s) => s.code === "TX")).toEqual(expect.objectContaining({ move: "+0.4¢ +0.1%", ink: "muted" }));
  });

  it("prints the price with no move when there is nothing to compare with", () => {
    const sd = site();
    at(sd, "OH").primary = move(6.25, null);
    expect(yourStateData(sd).find((s) => s.code === "OH")).toEqual(expect.objectContaining({ price: "$6.250", move: "", ink: "muted" }));
  });

  it("names AAA on the plate once its daily prices are the source, in place of the region", () => {
    // The region plate goes with AAA on (the state page's rule); the strip
    // still needs to say whose number it is, so every priced state gets AAA.
    const d = yourStateData(site("aaa+eia"));
    expect(d.every((s) => s.plate === "AAA daily average")).toBe(true);
    expect(d.find((s) => s.code === "AK")!.price).toBe("$6.500");
  });
});

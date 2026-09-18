import { describe, expect, it } from "vitest";
import statesFile from "../data/states.json";
import type { BenchmarkKey, Move } from "./data.ts";
import type { SiteData, StateView } from "./site.ts";
import { islandJson, regionPlate, yourStateData } from "./yourstate.ts";

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

describe("region plate under the state sign", () => {
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

  it("skips California, which EIA prices on its own, and Alaska and Hawaii, which it doesn't survey", () => {
    expect(regionPlate(at(sd, "CA"), sd)).toBeNull();
    expect(regionPlate(at(sd, "AK"), sd)).toBeNull();
    expect(regionPlate(at(sd, "HI"), sd)).toBeNull();
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
});

describe("your state data for the home page", () => {
  it("lists all 51 in states.json order with the fields the script reads", () => {
    const d = yourStateData(site());
    expect(d.states).toHaveLength(51);
    expect(d.states.map((s) => s.code)).toEqual(statesFile.states.map((s) => s.code));
    expect(d.when).toBe("this week");
    expect(d.none).toBe("No weekly price");
    const oh = d.states.find((s) => s.code === "OH")!;
    expect(oh).toEqual({ code: "OH", name: "Ohio", price: 6.25, change: 0.304, direction: "up", plate: "EIA Midwest average, 15 states" });
  });

  it("gives Alaska and Hawaii no number to borrow", () => {
    const d = yourStateData(site());
    for (const code of ["AK", "HI"]) {
      expect(d.states.find((s) => s.code === code)).toEqual(expect.objectContaining({ price: null, change: null, direction: null, plate: null }));
    }
  });

  it("follows the map bins for direction, so a tiny change is about the same", () => {
    const d = yourStateData(site());
    expect(d.states.find((s) => s.code === "TX")!.direction).toBe("flat");
    expect(d.states.find((s) => s.code === "FL")!.direction).toBe("down");
  });

  it("says since yesterday, or since the last price day, when AAA is on", () => {
    expect(yourStateData(site("aaa+eia")).when).toBe("since yesterday");
    expect(yourStateData(site("aaa+eia", { gap: 2 })).when).toBe("since Sep 15");
    expect(yourStateData(site("aaa+eia")).states.every((s) => s.plate === null)).toBe(true);
  });

  it("is safe to put inside a script element", () => {
    const d = yourStateData(site());
    d.states[0].name = "</script><script>alert(1)</script>";
    const json = islandJson(d);
    expect(json).not.toContain("<");
    expect(JSON.parse(json).states[0].name).toBe("</script><script>alert(1)</script>");
  });
});

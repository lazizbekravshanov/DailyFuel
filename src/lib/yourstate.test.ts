import { describe, expect, it } from "vitest";
import statesFile from "../data/states.json";
import type { BenchmarkKey, Move } from "./data.ts";
import type { SiteData, StateView } from "./site.ts";
import { eiaPlate, NO_SURVEY_PLATE, regionAverage, regionPlate, yourStateJson } from "./yourstate.ts";

// The home page's your state answer is one JSON block again (yourStateJson),
// printed into a <script type="application/json">; YourState.astro escapes
// every "<" in it, and the cases below check the strings it carries.

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
    expect(regionPlate(at(sd, "OH"), sd)).toBe("Midwest average, same in 15 states");
    expect(regionPlate(at(sd, "FL"), sd)).toBe("Lower Atlantic average, same in 6 states");
    expect(regionPlate(at(sd, "CO"), sd)).toBe("Rocky Mountain average, same in 5 states");
  });

  it("counts DC apart from the states in the Central Atlantic", () => {
    expect(regionPlate(at(sd, "NY"), sd)).toBe("Central Atlantic average, same in 5 states and DC");
    expect(regionPlate(at(sd, "DC"), sd)).toBe("Central Atlantic average, same in 5 states and DC");
  });

  it("says the West Coast outside California plainly", () => {
    expect(regionPlate(at(sd, "WA"), sd)).toBe("West Coast average outside California, same in 4 states");
  });

  it("gives California its own, and says why Alaska and Hawaii have none, so every state carries one", () => {
    expect(regionPlate(at(sd, "CA"), sd)).toBe("California's own average");
    expect(regionPlate(at(sd, "AK"), sd)).toBe(NO_SURVEY_PLATE);
    expect(regionPlate(at(sd, "HI"), sd)).toBe("No weekly survey here");
  });

  it("always says it is an average, never a price measured in the state", () => {
    for (const s of sd.states) {
      const plate = regionPlate(s, sd)!;
      if (s.eia_series === null) expect(plate).toBe(NO_SURVEY_PLATE);
      else expect(plate).toMatch(/ average\b/);
    }
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
    for (const s of sd.states) expect(regionPlate(s, sd) ?? "").not.toMatch(/[\u2013\u2014]| - /);
  });

  it("uses the same words the state page and the share cards use, in any mode", () => {
    const aaa = site("aaa+eia");
    for (const s of sd.states) {
      if (s.eia_series) expect(eiaPlate(s, sd)).toBe(regionPlate(s, sd));
    }
    expect(regionAverage(at(aaa, "WA"), aaa)).toBe("West Coast average outside California, same in 4 states");
    expect(eiaPlate(at(aaa, "WA"), aaa)).toBe("West Coast average outside California, same in 4 states");
    expect(regionAverage(at(aaa, "CA"), aaa)).toBeNull();
    expect(eiaPlate(at(aaa, "CA"), aaa)).toBe("California's own average");
    expect(regionAverage(at(aaa, "AK"), aaa)).toBeNull();
    expect(eiaPlate(at(aaa, "AK"), aaa)).toBeNull();
  });
});

describe("your state data for the home page answer (yourStateJson)", () => {
  const line = (j: ReturnType<typeof yourStateJson>, code: string) => j.l[j.s[code][1]];

  it("names all 51 in states.json order, each with the key of the line it reads", () => {
    const j = yourStateJson(site());
    expect(Object.keys(j.s)).toEqual(statesFile.states.map((s) => s.code));
    expect(j.s.OH).toEqual(["Ohio", "R20"]);
    expect(j.s.CA).toEqual(["California", "SCA"]);
    expect(j.s.DC).toEqual(["District of Columbia", "R1Y"]);
    for (const [code, [, key]] of Object.entries(j.s)) expect(j.l, code).toHaveProperty([key]);
  });

  it("prints each region's line once, since its states share it, the way the page prints money", () => {
    const j = yourStateJson(site());
    expect(Object.keys(j.l).sort()).toEqual(["", "R1X", "R1Y", "R1Z", "R20", "R30", "R40", "R5XCA", "SCA"]);
    expect(line(j, "OH")).toEqual(["$6.250", "Up 30.4¢", "from $5.946 last week.", "up", "Midwest average, same in 15 states"]);
    expect(line(j, "FL")).toEqual(["$6.096", "Down 2.1¢", "from $6.117 last week.", "down", "Lower Atlantic average, same in 6 states"]);
    expect(line(j, "IN")).toBe(line(j, "OH"));
  });

  it("gives Alaska and Hawaii no number to borrow, and says why", () => {
    const j = yourStateJson(site());
    for (const code of ["AK", "HI"]) {
      expect(j.s[code][1]).toBe("");
      expect(line(j, code)).toEqual(["", "No weekly price", "", "muted", "The weekly survey does not cover this state."]);
    }
    expect(line(j, "CA")).toEqual(expect.arrayContaining(["$8.039", "California's own average"]));
  });

  it("follows the bins for the ink, so a tiny change prints but stays muted", () => {
    const j = yourStateJson(site());
    expect(line(j, "TX").slice(1, 4)).toEqual(["Up 0.4¢", "from $6.023 last week.", "muted"]);
  });

  it("says No change, muted, when the change rounds to nothing", () => {
    const sd = site();
    for (const s of sd.states) if (s.eia_series === "R20") s.primary = move(6.25, 0.0004);
    expect(line(yourStateJson(sd), "OH").slice(0, 4)).toEqual(["$6.250", "No change", "from last week.", "muted"]);
  });

  it("prints the price with no move when there is nothing to compare with", () => {
    const sd = site();
    for (const s of sd.states) if (s.eia_series === "R20") s.primary = move(6.25, null);
    expect(line(yourStateJson(sd), "OH").slice(0, 4)).toEqual(["$6.250", "", "", "muted"]);
  });

  it("colours only a real change: up is red, down is blue, everything else muted", () => {
    const j = yourStateJson(site());
    for (const l of Object.values(j.l)) {
      expect(["up", "down", "muted"]).toContain(l[3]);
      if (l[3] === "up") expect(l[1]).toMatch(/^Up [\d$]/);
      if (l[3] === "down") expect(l[1]).toMatch(/^Down [\d$]/);
    }
  });

  it("never uses a dash, an arrow or a glyph", () => {
    for (const mode of ["eia_only", "aaa+eia"] as const) {
      const text = JSON.stringify(yourStateJson(site(mode)));
      expect(text).not.toMatch(/[\u2013\u2014]| - /);
      expect(text).not.toMatch(/[\u2190-\u21ff\u2039\u203a\u25b2-\u25bf\u2713\u2714]/);
    }
  });

  it("names AAA on the plate once its daily prices are the source, in place of the region", () => {
    // The region plate goes with AAA on (the state page's rule); the answer
    // still needs to say whose number it is, so every priced state gets AAA.
    const j = yourStateJson(site("aaa+eia"));
    expect(Object.values(j.l).every((l) => l[4] === "AAA daily average")).toBe(true);
    expect(j.s.OH[1]).toBe("OH");
    expect(line(j, "AK")[0]).toBe("$6.500");
    expect(line(j, "OH")[2]).toBe("from $5.946 yesterday.");
  });
});

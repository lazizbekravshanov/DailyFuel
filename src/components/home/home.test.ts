import { describe, expect, it } from "vitest";
import { byChange, coverage, homeMeta, keyLine, memberCount, regionNote, withNote } from "./home.ts";

const c = (...changes: number[]) => changes.map((change) => ({ change }));

describe("keyLine above the map key", () => {
  it("gives the range when every region rose", () => {
    expect(keyLine(c(0.212, 0.261, 0.491, 0.304, 0.273, 0.261, 0.275, 0.252), "region", "weekly")).toBe(
      "All 8 regions rose, 21.2¢ to 49.1¢.",
    );
  });

  it("gives one number when they all moved the same", () => {
    expect(keyLine(c(-0.05, -0.05), "region", "weekly")).toBe("All 2 regions fell 5.0¢.");
  });

  it("counts a mixed week, with about the same following the map bins", () => {
    // 0.9¢ is about the same on the weekly map, 1.0¢ is a rise
    expect(keyLine(c(0.3, 0.01, -0.02, 0.009, -0.004), "region", "weekly")).toBe(
      "2 regions rose, 1 fell and 2 were about the same.",
    );
    expect(keyLine(c(0.3, -0.2), "state", "daily")).toBe("1 state rose and 1 fell.");
  });

  it("says when nothing moved, and returns null with nothing to count", () => {
    expect(keyLine(c(0, 0.004), "region", "weekly")).toBe("All 2 regions were about the same.");
    expect(keyLine([], "region", "weekly")).toBeNull();
  });

  it("never uses a dash", () => {
    for (const l of [keyLine(c(0.1, -0.1, 0), "region", "weekly"), keyLine(c(0.1, 0.2), "state", "daily")]) {
      expect(l).not.toMatch(/[-–—]/);
    }
  });
});

describe("region note in the map tooltip", () => {
  it("names the region and how many share its price", () => {
    expect(regionNote("Midwest", ["IL", "IN", "IA", "KS", "KY", "MI", "MN", "MO", "NE", "ND", "OH", "OK", "SD", "TN", "WI"])).toBe(
      "Midwest price, shared by 15 states",
    );
    expect(regionNote("Central Atlantic", ["DE", "DC", "MD", "NJ", "NY", "PA"])).toBe(
      "Central Atlantic price, shared by 5 states and DC",
    );
    expect(regionNote("California", ["CA"])).toBe("EIA's California price");
  });

  it("counts members", () => {
    expect(memberCount(["DC"])).toBe("DC");
    expect(memberCount(["OR"])).toBe("1 state");
  });

  it("swaps the note at the end of a label and leaves other labels alone", () => {
    expect(withNote("Ohio, $6.250 per gallon, up 30.4 cents. Midwest region price.", "Midwest region price", "Midwest price, shared by 15 states")).toBe(
      "Ohio, $6.250 per gallon, up 30.4 cents. Midwest price, shared by 15 states.",
    );
    expect(withNote("Alaska. EIA doesn't survey diesel prices in Alaska.", "", "x")).toBe(
      "Alaska. EIA doesn't survey diesel prices in Alaska.",
    );
    expect(withNote("Ohio, no note here.", "Midwest region price", "x")).toBe("Ohio, no note here.");
  });
});

describe("move list order", () => {
  it("puts the biggest rise first and the biggest drop last, ties by name", () => {
    const sorted = byChange([
      { name: "B", change: 0.1 },
      { name: "A", change: 0.1 },
      { name: "C", change: -0.3 },
      { name: "D", change: 0.49 },
      { name: "E", change: 0 },
    ]);
    expect(sorted.map((s) => s.name)).toEqual(["D", "A", "B", "E", "C"]);
  });
});

describe("home meta description", () => {
  const surveyed = [
    "AL", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA",
    "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD",
    "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
  ];

  it("counts only the places with a price", () => {
    expect(surveyed).toHaveLength(49);
    expect(coverage(surveyed)).toBe("48 states and DC");
    expect(coverage([...surveyed, "AK", "HI"])).toBe("all 50 states and DC");
  });

  it("never claims all 50 states while Alaska and Hawaii have no weekly price", () => {
    const d = homeMeta({ price: 6.285, change: 0.318, daily: false, priced: surveyed });
    expect(d).toBe("U.S. diesel is $6.285 a gallon, up 31.8¢ this week. See the DOE weekly price and change for 48 states and DC.");
    expect(d).not.toMatch(/all 50/);
    expect(d).not.toMatch(/[–—]| - /);
  });

  it("reads right for a flat week, a daily page and no national price", () => {
    expect(homeMeta({ price: 6.285, change: 0, daily: false, priced: surveyed })).toBe(
      "U.S. diesel is $6.285 a gallon, unchanged this week. See the DOE weekly price and change for 48 states and DC.",
    );
    expect(homeMeta({ price: 6.1, change: -0.021, daily: true, priced: [...surveyed, "AK", "HI"] })).toBe(
      "U.S. diesel is $6.100 a gallon, down 2.1¢ since yesterday. See today's price and change for all 50 states and DC.",
    );
    expect(homeMeta({ price: null, change: null, daily: false, priced: surveyed })).toBe(
      "See the DOE weekly price and change for 48 states and DC.",
    );
  });
});

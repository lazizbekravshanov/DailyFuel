import { describe, expect, it } from "vitest";
import {
  biggestNote, coverage, fromLine, homeMeta, homeTitle, keyLine, leaders, memberCount, movers, recordLine, sharedNote,
} from "./home.ts";

// regionNote, withNote, byChange and topWithTies went with the map and the
// move list: the paper terminal has neither, so nothing calls them.

const c = (...changes: number[]) => changes.map((change) => ({ change }));
const NO_DASH = /[–—]| - /;

describe("keyLine beside the REGIONS head", () => {
  it("gives the range when every region rose", () => {
    expect(keyLine(c(0.212, 0.261, 0.491, 0.304, 0.273, 0.261, 0.275, 0.252), "region", "weekly")).toBe(
      "All 8 regions rose, 21.2¢ to 49.1¢.",
    );
  });

  it("gives one number when they all moved the same", () => {
    expect(keyLine(c(-0.05, -0.05), "region", "weekly")).toBe("All 2 regions fell 5.0¢.");
  });

  it("counts a mixed week, with about the same following the bins", () => {
    // 0.9¢ is about the same in a weekly number, 1.0¢ is a rise
    expect(keyLine(c(0.3, 0.01, -0.02, 0.009, -0.004), "region", "weekly")).toBe(
      "2 regions rose, 1 fell and 2 were about the same.",
    );
    expect(keyLine(c(0.3, -0.2), "state", "daily")).toBe("1 state rose and 1 fell.");
  });

  it("says when nothing moved, and returns null with nothing to count", () => {
    expect(keyLine(c(0, 0.004), "region", "weekly")).toBe("All 2 regions were about the same.");
    expect(keyLine([], "region", "weekly")).toBeNull();
  });

  it("counts DC apart from the states", () => {
    const s = (code: string, change: number) => ({ code, change });
    expect(keyLine([s("OH", 0.3), s("DC", 0.018), s("PA", -0.2), s("NY", 0.004)], "state", "weekly")).toBe(
      "1 state and DC rose, 1 fell and 1 was about the same.",
    );
    expect(keyLine([s("OH", 0.3), s("PA", -0.2), s("DC", -0.1)], "state", "daily")).toBe("1 state rose and 1 state and DC fell.");
    expect(keyLine([s("OH", 0.3), s("DC", 0.001)], "state", "daily")).toBe("1 state rose and DC was about the same.");
    expect(keyLine([s("OH", 0.3), s("PA", 0.2), s("DC", 0.1)], "state", "daily")).toBe("All 2 states and DC rose, 10.0¢ to 30.0¢.");
    // regions have no codes and count as before
    expect(keyLine(c(0.3, -0.2), "region", "weekly")).toBe("1 region rose and 1 fell.");
  });

  it("never uses a dash", () => {
    for (const l of [keyLine(c(0.1, -0.1, 0), "region", "weekly"), keyLine(c(0.1, 0.2), "state", "daily")]) {
      expect(l).not.toMatch(/[-–—]/);
    }
  });
});

describe("movers", () => {
  const m = (name: string, change: number) => ({ name, change });

  it("leaves out a move the bins call about the same", () => {
    // 0.8¢ is about the same in a weekly number, so it's not the biggest drop
    const items = [m("California", -0.008), m("Midwest", 0.2), m("Gulf Coast", 0.009)];
    expect(movers(items, "down", "weekly")).toEqual([]);
    expect(movers(items, "up", "weekly").map((i) => i.name)).toEqual(["Midwest"]);
    expect(movers([m("Ohio", 0.005)], "up", "daily").map((i) => i.name)).toEqual(["Ohio"]);
  });

  it("names everyone tied for the top", () => {
    const falls = movers([m("Rocky Mountain", -0.061), m("Midwest", -0.061), m("Gulf Coast", -0.02)], "down", "weekly");
    expect(falls.map((i) => i.name)).toEqual(["Midwest", "Rocky Mountain", "Gulf Coast"]);
    expect(leaders(falls).map((i) => i.name)).toEqual(["Midwest", "Rocky Mountain"]);
    expect(leaders([])).toEqual([]);
  });
});

describe("the BIGGEST RISE note beside the board", () => {
  const m = (name: string, change: number) => ({ name, change });
  const week = [
    m("New England", 0.212), m("Central Atlantic", 0.261), m("Lower Atlantic", 0.491), m("Midwest", 0.304),
    m("Gulf Coast", 0.273), m("Rocky Mountain", 0.261), m("California", 0.275), m("West Coast outside California", 0.252),
  ];

  it("names the biggest and, when all rose, the smallest", () => {
    expect(biggestNote(week, "weekly")).toEqual({ head: "Biggest rise.", text: "Lower Atlantic, +49.1¢. Smallest, New England, +21.2¢." });
  });

  it("names both ends of a mixed week and drops the smallest", () => {
    const mixed = [m("Midwest", 0.304), m("California", -0.025), m("Gulf Coast", 0.005), m("New England", 0.1)];
    expect(biggestNote(mixed, "weekly")).toEqual({ head: "Biggest rise.", text: "Midwest, +30.4¢. Biggest fall. California, −2.5¢." });
    const fell = [m("Midwest", -0.304), m("California", -0.025)];
    expect(biggestNote(fell, "weekly")).toEqual({ head: "Biggest fall.", text: "Midwest, −30.4¢. Smallest, California, −2.5¢." });
  });

  it("names ties together and counts more than three", () => {
    const tied = [m("B", 0.3), m("A", 0.3), m("C", 0.1)];
    expect(biggestNote(tied, "weekly")!.text).toBe("A and B, +30.0¢. Smallest, C, +10.0¢.");
    const many = [m("A", 0.3), m("B", 0.3), m("C", 0.3), m("D", 0.3), m("E", 0.1)];
    expect(biggestNote(many, "weekly")!.text).toBe("4 tied, +30.0¢. Smallest, E, +10.0¢.");
  });

  it("says nothing when every move is about the same, or when all tie", () => {
    expect(biggestNote([m("A", 0.004), m("B", -0.009)], "weekly")).toBeNull();
    expect(biggestNote([m("A", 0.3), m("B", 0.3)], "weekly")).toEqual({ head: "Biggest rise.", text: "A and B, +30.0¢." });
    expect(biggestNote([m("A", 0.3)], "weekly")).toEqual({ head: "Biggest rise.", text: "A, +30.0¢." });
  });
});

describe("the sentence under the headline price", () => {
  it("says where the price came from", () => {
    expect(fromLine(0.318, 5.967, "the week of Sep 7")).toBe("Up from $5.967 the week of Sep 7.");
    expect(fromLine(-0.021, 6.117, "yesterday")).toBe("Down from $6.117 yesterday.");
    expect(fromLine(0.0004, 6.285, "the week of Sep 7")).toBe("Unchanged from $6.285 the week of Sep 7.");
  });

  it("says how high it is, with the regions in the same breath when they agree", () => {
    const all = Array<"record">(8).fill("record");
    expect(recordLine("record", all)).toBe(
      "Highest U.S. price in our records, which start June 2022, and every region is at its own high too.",
    );
    expect(recordLine("record", ["record", "record", null, "52week", "record", "record", "record", "record"])).toBe(
      "Highest U.S. price in our records, which start June 2022. 6 of 8 regions are at their own high too.",
    );
    expect(recordLine("record", [null, null])).toBe("Highest U.S. price in our records, which start June 2022.");
    expect(recordLine("52week", all)).toBe(
      "Highest U.S. price in 52 weeks. Every region is at its highest in our records, which start June 2022.",
    );
    expect(recordLine(null, ["record", null, null])).toBe("1 of 3 regions are at their highest in our records, which start June 2022.");
    expect(recordLine(null, [null, null])).toBeNull();
    expect(recordLine(null, [])).toBeNull();
  });

  it("never uses a dash", () => {
    for (const s of [fromLine(0.3, 6, "yesterday"), recordLine("record", ["record"]), recordLine("52week", [null])]) {
      expect(s).not.toMatch(NO_DASH);
    }
  });
});

describe("the ONE PRICE, MANY STATES note", () => {
  const midwest = { name: "Midwest", codes: ["IL", "IN", "IA", "KS", "KY", "MI", "MN", "MO", "NE", "ND", "OH", "OK", "SD", "TN", "WI"], price: 6.25 };

  it("uses the biggest region's real count and price", () => {
    expect(sharedNote(midwest, false)).toBe("EIA surveys regions, not every state, so all 15 Midwest states read $6.250 this week.");
    expect(sharedNote({ name: "Central Atlantic", codes: ["DE", "DC", "MD", "NJ", "NY", "PA"], price: 6.312 }, false)).toBe(
      "EIA surveys regions, not every state, so all 5 Central Atlantic states and DC read $6.312 this week.",
    );
  });

  it("says whose daily price the table has once AAA is on", () => {
    expect(sharedNote(midwest, true)).toBe(
      "EIA surveys regions, not every state, so its weekly Midwest number covers 15 states. The daily price for each state in the table below is AAA's.",
    );
  });

  it("counts members", () => {
    expect(memberCount(["DC"])).toBe("DC");
    expect(memberCount(["OR"])).toBe("1 state");
    expect(memberCount(["DE", "DC", "MD"])).toBe("2 states and DC");
  });
});

describe("the title", () => {
  it("carries the U.S. number and which way it went", () => {
    expect(homeTitle(6.285, 0.318)).toBe("DailyFuel: U.S. diesel $6.285 a gallon, up 31.8¢");
    expect(homeTitle(6.285, -0.021)).toBe("DailyFuel: U.S. diesel $6.285 a gallon, down 2.1¢");
    expect(homeTitle(6.285, 0)).toBe("DailyFuel: U.S. diesel $6.285 a gallon, unchanged");
    expect(homeTitle(6.285, null)).toBe("DailyFuel: U.S. diesel $6.285 a gallon");
    expect(homeTitle(null, null)).toBe("DailyFuel: diesel prices in every state");
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
    expect(d).not.toMatch(NO_DASH);
  });

  it("says DOE prices regions, not states, while EIA is the source", () => {
    const d = homeMeta({ price: 6.285, change: 0.318, daily: false, priced: surveyed, regions: 8 });
    expect(d).toBe("U.S. diesel is $6.285 a gallon, up 31.8¢ this week. See the DOE weekly price for the 8 regions that cover 48 states and DC.");
    expect(homeMeta({ price: null, change: null, daily: false, priced: surveyed, regions: 8 })).toBe(
      "See the DOE weekly price for the 8 regions that cover 48 states and DC.",
    );
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

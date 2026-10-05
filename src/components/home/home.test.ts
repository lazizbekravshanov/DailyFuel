import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import {
  biggestNote, coverage, fromLine, homeMeta, homeTitle, keyLine, leaders, memberCount, movers, recordLine, recordNote, sharedNote,
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

describe("the board's Record high note", () => {
  const r = (name: string, kind: "record" | "52week" | null) => ({ name, kind });
  const tail = "in our records, which start June 2022.";

  it("names one region, two or three, then counts", () => {
    expect(recordNote([r("Rocky Mountain", "record"), r("Midwest", null)])).toBe(`Rocky Mountain is at its highest price ${tail}`);
    expect(recordNote([r("Rocky Mountain", "record"), r("Midwest", "record"), r("Gulf Coast", "52week")])).toBe(
      `Rocky Mountain and Midwest are at their highest prices ${tail}`,
    );
    expect(recordNote([r("A", "record"), r("B", "record"), r("C", "record"), r("D", null)])).toBe(
      `A, B and C are at their highest prices ${tail}`,
    );
    const eight = ["A", "B", "C", "D", "E", "F", "G", "H"].map((n, i) => r(n, i < 6 ? "record" : null));
    expect(recordNote(eight)).toBe(`6 of the 8 regions are at their highest prices ${tail}`);
  });

  it("says every region when they all are, and nothing when none is", () => {
    expect(recordNote([r("A", "record"), r("B", "record")])).toBe(`Every region is at its highest price ${tail}`);
    // a 52 week high is not a record
    expect(recordNote([r("A", "52week"), r("B", null)])).toBeNull();
    expect(recordNote([])).toBeNull();
  });

  it("never uses a dash", () => {
    for (const n of [1, 2, 4, 8]) {
      const s = recordNote(Array.from({ length: 8 }, (_, i) => r(`R${i}`, i < n ? "record" : null)));
      expect(s).not.toMatch(NO_DASH);
    }
  });
});

describe("the ONE PRICE, MANY STATES note", () => {
  const midwest = { name: "Midwest", codes: ["IL", "IN", "IA", "KS", "KY", "MI", "MN", "MO", "NE", "ND", "OH", "OK", "SD", "TN", "WI"], price: 6.25 };

  it("uses the biggest region's real count and price, and says the price is the region's", () => {
    expect(sharedNote(midwest, false)).toBe(
      "All 15 Midwest states show the same price, $6.250, because the survey covers regions, not single states.",
    );
    expect(sharedNote({ name: "Central Atlantic", codes: ["DE", "DC", "MD", "NJ", "NY", "PA"], price: 6.312 }, false)).toBe(
      "All 5 Central Atlantic states and DC show the same price, $6.312, because the survey covers regions, not single states.",
    );
    // never a dash, and never a price that reads as measured in one state
    for (const d of [false, true]) {
      const s = sharedNote(midwest, d);
      expect(s).not.toMatch(NO_DASH);
      expect(s).toMatch(/regions, not (single|every) state/);
    }
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

// The phone layout on the built home page. These read a build that already
// exists, never make one: DAILYFUEL_BUILT_DIR names it, else the build
// src/lib/built.test.ts leaves in tmp/dist-test. With neither they skip.
// What a phone shows is decided by the order of the blocks and by the CSS
// the page carries, so that is what they check: your saved state answers
// first, the U.S. average follows it, and the region board keeps its change
// column in view with nothing to scroll sideways. The page's budgets are
// checked in src/lib/built.test.ts.
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BUILT = process.env.DAILYFUEL_BUILT_DIR ? resolve(ROOT, process.env.DAILYFUEL_BUILT_DIR) : resolve(ROOT, "tmp/dist-test");
const HAS_BUILD = existsSync(resolve(BUILT, "index.html"));

describe.skipIf(!HAS_BUILD)("the built home page on a phone", () => {
  const html = HAS_BUILD ? readFileSync(resolve(BUILT, "index.html"), "utf8") : "";
  const { document } = parseHTML(html);
  const $ = (sel: string) => document.querySelector(sel) as unknown as HTMLElement;
  const $$ = (sel: string) => Array.from(document.querySelectorAll(sel)) as unknown as HTMLElement[];
  const css = $$("style").map((s) => s.textContent).join("\n");
  /** The rules inside every @media (max-width: 479px) block, flattened. */
  const phone = (() => {
    let out = "";
    const re = /@media \(max-width: ?479px\)\{/g;
    for (let m = re.exec(css); m; m = re.exec(css)) {
      let depth = 1, i = re.lastIndex;
      for (; i < css.length && depth; i++) depth += css[i] === "{" ? 1 : css[i] === "}" ? -1 : 0;
      out += css.slice(re.lastIndex, i - 1) + "\n";
    }
    return out;
  })();
  const sign = /^(\+|−|Up |Down )[\d$]/;

  it("puts your state first in main, with the U.S. block right after it", () => {
    const main = $("main");
    const ys = main.firstElementChild as HTMLElement;
    expect(ys.matches("section.ys[data-ys]")).toBe(true);
    // the CSS keys the smaller U.S. block on ".ys[data-ys-state] + .hero", so it must be the very next block
    const hero = ys.nextElementSibling as HTMLElement;
    expect(hero.classList.contains("hero")).toBe(true);
    expect(hero.querySelector("h1")!.textContent!.trim()).toBe("U.S. diesel average");
    expect(css).toMatch(/\.ys:not\(\[data-ys-state\]\) \.ans\{display:none\}/);
    expect(phone).toMatch(/\.ys\[data-ys-state\]\+\.hero \.big\{font-size:1\.5rem\}/);
  });

  it("answers with the saved state's own line, and Alaska with no price at all", () => {
    const data = JSON.parse($("#ys-data").textContent!) as { s: Record<string, [string, string]>; l: Record<string, string[]> };
    expect(Object.keys(data.s)).toHaveLength(51);
    const oh = data.l[data.s.OH[1]];
    expect(data.s.OH[0]).toBe("Ohio");
    expect(oh[0]).toMatch(/^\$\d\.\d{3}$/);
    // only a change wears colour, and it says its direction in words
    expect(oh[1]).toMatch(/^(Up|Down) [\d$]|^No change$/);
    if (oh[3] === "up") expect(oh[1]).toMatch(/^Up /);
    if (oh[3] === "down") expect(oh[1]).toMatch(/^Down /);
    if (/^No change$/.test(oh[1])) expect(oh[3]).toBe("muted");
    // a regional average, said as one, never as Ohio's own measured price
    expect(oh[4]).toMatch(/^Midwest average, same in \d+ states$/);
    for (const code of ["AK", "HI"]) {
      expect(data.s[code][1]).toBe("");
      expect(data.l[""]).toEqual(["", "No weekly price", "", "muted", "The weekly survey does not cover this state."]);
    }
    for (const line of Object.values(data.l)) for (const t of line) {
      expect(t).not.toMatch(NO_DASH);
      expect(t).not.toMatch(/[▲▼←→↑↓]/);
    }
  });

  it("shows the region board's change on a phone with nothing to scroll sideways", () => {
    const board = $("section.board");
    const heads = Array.from(board.querySelectorAll("thead th")).map((t) => t.textContent);
    // the first three columns stay on a phone, and change is one of them
    expect(heads.slice(0, 3)).toEqual(["Region", "Price $", "Change ¢"]);
    expect(phone).toContain(".board table{min-width:0!important}");
    expect(phone).toMatch(/\.board th:nth-child\(n\+4\),\.board td:nth-child\(n\+4\)[^{]*\{display:none\}/);
    expect(phone).toMatch(/\.board tr\.us[,{]/);
    expect(phone).toMatch(/\.board tr\.mr\{display:table-row\}/);
    // every coloured change starts with its sign; a change too small to call is grey
    for (const td of Array.from(board.querySelectorAll("tbody td.up, tbody td.down"))) expect(td.textContent).toMatch(sign);
  });

  it("lists each region's states under it as code links, A to Z, and none under the U.S.", () => {
    const rows = $$("section.board tbody tr");
    const us = rows.find((r) => r.classList.contains("us"))!;
    expect(us.nextElementSibling!.classList.contains("mr")).toBe(false);
    const regions = rows.filter((r) => r.classList.contains("hm"));
    expect(regions).toHaveLength(8);
    const seen: string[] = [];
    for (const r of regions) {
      const mr = r.nextElementSibling as HTMLElement;
      expect(mr.classList.contains("mr")).toBe(true);
      const codes = Array.from(mr.querySelectorAll("a")).map((a) => a.textContent!);
      expect(codes.length).toBeGreaterThan(0);
      expect(codes).toEqual([...codes].sort());
      for (const a of Array.from(mr.querySelectorAll("a"))) expect(a.getAttribute("href")).toBe(`/state/${a.textContent!.toLowerCase()}/`);
      seen.push(...codes);
    }
    // 48 states and DC, each once; Alaska and Hawaii have no region
    expect(new Set(seen).size).toBe(49);
    expect(seen).toHaveLength(49);
    expect(seen).not.toContain("AK");
    expect(seen).not.toContain("HI");
    const ns = $("section.board p.ns");
    expect(ns.textContent).toBe("No weekly survey. Alaska and Hawaii have no weekly price.");
  });
});

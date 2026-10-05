import { describe, expect, it } from "vitest";
import statesFile from "../data/states.json";
import type { BenchmarkKey, Move } from "./data.ts";
import type { SiteData, StateView } from "./site.ts";
import {
  countPlaces, missingNote, noSurveyNote, pctOf, samePriceCaption, samePriceMeta, stateDescription,
} from "./copy.ts";
import { homeMeta } from "../components/home/home.ts";
import { changeWords, diffWords, formatMove } from "./format.ts";
import { NEIGHBORS } from "./neighbors.ts";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseHTML } from "linkedom";

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

  it("says who shares the number, counting DC apart", () => {
    expect(samePriceMeta(by("OH"), S)).toBe("Ohio and 14 other states show $6.250 this week");
    expect(samePriceMeta(by("MD"), S)).toBe("Maryland and 4 other states and DC show $6.312 this week");
    // said from DC, the five are states, not "other" states
    expect(samePriceMeta(by("DC"), S)).toBe("DC and 5 states show $6.312 this week");
    expect(samePriceMeta(by("WA"), S)).toBe("Washington and 3 other states show $6.566 this week");
    expect(samePriceMeta(by("CA"), S)).toBeNull();
    expect(samePriceMeta(by("AK"), S)).toBeNull();
  });

  it("says tax is already in the shared price, never on top of it", () => {
    expect(samePriceCaption(by("OH"))).toBe(
      "These states all share one Midwest average. Tax is already in that price. Each state taxes diesel differently, so real pump prices still differ from state to state.",
    );
    expect(samePriceCaption(by("WA"))).toMatch(/^These states all share one West Coast outside California average\. Tax is already in that price\./);
    for (const s of S.states) {
      if (!s.eia_series) continue;
      expect(samePriceCaption(s)).not.toMatch(/on top/);
      expect(samePriceCaption(s)).not.toMatch(/[‒-―]| - /);
    }
  });

  it("gives Alaska and Hawaii no price of their own, and the West Coast only as a rough guide", () => {
    const west = move(7.25, 0.263);
    expect(noSurveyNote(by("AK"), west)).toBe(
      "The government's weekly survey does not cover Alaska, so we have no Alaska price. For a rough guide only, the whole West Coast, California included, averaged $7.250 this week, up 26.3¢ from last week.",
    );
    expect(noSurveyNote(by("HI"), move(7.25, -0.099))).toBe(
      "The government's weekly survey does not cover Hawaii, so we have no Hawaii price. For a rough guide only, the whole West Coast, California included, averaged $7.250 this week, down 9.9¢ from last week.",
    );
    // a move that rounds to 0.0¢ is no change, in words, with no sign
    expect(noSurveyNote(by("HI"), move(7.25, 0.0004))).toMatch(/averaged \$7\.250 this week, no change from last week\.$/);
    expect(noSurveyNote(by("HI"), move(7.25, null))).toMatch(/averaged \$7\.250 this week\.$/);
    expect(noSurveyNote(by("AK"), null)).toBe(
      "The government's weekly survey does not cover Alaska, so we have no Alaska price. The nearest region it does cover is the West Coast.",
    );
    for (const w of [west, move(7.25, -0.05), move(7.25, 0), move(7.25, null), null]) {
      for (const code of ["AK", "HI"]) {
        const t = noSurveyNote(by(code), w);
        // the move is said in words, not a sign or an arrow, and never with a dash
        expect(t).not.toMatch(/[+−]\d|[▲▼↑↓←→]/);
        expect(t).not.toMatch(/[‒-―]| - /);
        // the state's own price is never claimed: the only number is the West Coast's
        expect(t).not.toMatch(new RegExp(`${by(code).name} (price|average) (is|was|averaged) \\$`));
      }
    }
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

// No arrows, no signs that carry the direction alone, no dashes as punctuation.
const MARKS = /[▲▼△▽↑↓←→‹›✓]/;
const DASH = /[‒-―]| - /;

describe("a change in words", () => {
  it("says the direction as a word, cents under a dollar and dollars from a dollar up", () => {
    expect(changeWords(-0.154)).toBe("Down 15.4¢");
    expect(changeWords(0.067)).toBe("Up 6.7¢");
    expect(changeWords(2.795)).toBe("Up $2.795");
    expect(changeWords(-1)).toBe("Down $1.000");
    expect(changeWords(0)).toBe("No change");
    // rounds to 0.0¢, so it is no change, not "Down 0.0¢"
    expect(changeWords(-0.0004)).toBe("No change");
  });

  it("compares two places without calling it a change", () => {
    expect(diffWords(5.953, 6.526)).toBe("57.3¢ less");
    expect(diffWords(6.531, 6.526)).toBe("0.5¢ more");
    expect(diffWords(6.526, 6.526)).toBe("Same price");
    expect(diffWords(8.064, 6.526)).toBe("$1.538 more");
    for (const t of [diffWords(5.953, 6.526), diffWords(6.531, 6.526)]) expect(t).not.toMatch(/^(Up|Down)\b/);
  });

  it("uses no sign, arrow or dash", () => {
    for (const c of [-2.5, -0.154, -0.0004, 0, 0.0004, 0.067, 0.999, 1, 2.795]) {
      for (const t of [changeWords(c), diffWords(6.5 + c, 6.5)]) {
        expect(t).not.toMatch(/[+−]/);
        expect(t).not.toMatch(MARKS);
        expect(t).not.toMatch(DASH);
      }
    }
  });
});

describe("next door states", () => {
  const codes = new Set(S.states.map((s) => s.code));

  it("has every site state, and only site states", () => {
    expect(new Set(Object.keys(NEIGHBORS))).toEqual(codes);
    for (const list of Object.values(NEIGHBORS)) for (const c of list) expect(codes.has(c)).toBe(true);
  });

  it("agrees both ways, with no state its own neighbour and none twice", () => {
    for (const [code, list] of Object.entries(NEIGHBORS)) {
      expect(list).not.toContain(code);
      expect(new Set(list).size).toBe(list.length);
      for (const n of list) expect(NEIGHBORS[n]).toContain(code);
    }
  });

  it("borders a sample of states correctly, rivers in, corners and lakes out", () => {
    expect(NEIGHBORS.OH).toEqual(["IN", "KY", "MI", "PA", "WV"]);
    expect(NEIGHBORS.KY).toEqual(["IL", "IN", "MO", "OH", "TN", "VA", "WV"]);
    expect(NEIGHBORS.DC).toEqual(["MD", "VA"]);
    expect(NEIGHBORS.TN).toHaveLength(8);
    expect(NEIGHBORS.MO).toHaveLength(8);
    expect(NEIGHBORS.ME).toEqual(["NH"]);
    // the Four Corners only touch at a point
    expect(NEIGHBORS.AZ).not.toContain("CO");
    expect(NEIGHBORS.UT).not.toContain("NM");
    // Michigan's lake shores with Illinois and Minnesota are not borders
    expect(NEIGHBORS.MI).toEqual(["IN", "OH", "WI"]);
    // Alaska and Hawaii border no state
    expect(NEIGHBORS.AK).toEqual([]);
    expect(NEIGHBORS.HI).toEqual([]);
  });

  // The built state pages, when DAILYFUEL_BUILT_DIR names one: the list is
  // lowest first, this state in its place, the U.S. average last, and no
  // colour, since a neighbour's price is not a change over time.
  const dir = process.env.DAILYFUEL_BUILT_DIR;
  const built = dir && existsSync(resolve(dir, "state/oh/index.html")) ? resolve(dir) : null;
  it.skipIf(!built)("lists them lowest first on each built state page", () => {
    const mills = (t: string) => Math.round(Number(t.replace("$", "")) * 1000);
    for (const code of ["OH", "KY", "DC", "TN", "CA", "WA", "ME"]) {
      const { document } = parseHTML(readFileSync(resolve(built!, `state/${code.toLowerCase()}/index.html`), "utf8"));
      const rows = Array.from(document.querySelectorAll(".nd-l li"));
      const us = rows.pop()!;
      expect(us.className).toBe("us");
      expect(us.querySelector("a")!.getAttribute("href")).toBe("/");
      const me = rows.filter((r) => r.className === "me");
      expect(me).toHaveLength(1);
      expect(me[0].querySelector(".v")!.textContent).toBe("This state");
      const hrefs = rows.filter((r) => r.className !== "me").map((r) => r.querySelector("a")!.getAttribute("href"));
      expect(new Set(hrefs)).toEqual(new Set(NEIGHBORS[code].map((n) => `/state/${n.toLowerCase()}/`)));
      const prices = rows.map((r) => mills(r.querySelector("b")!.textContent!));
      expect(prices).toEqual([...prices].sort((a, b) => a - b));
      // among ties this state comes first
      const mine = mills(me[0].querySelector("b")!.textContent!);
      expect(prices.indexOf(mine)).toBe(rows.indexOf(me[0]));
      for (const r of rows) {
        if (r === me[0]) continue;
        expect(r.querySelector(".v")!.textContent).toBe(diffWords(mills(r.querySelector("b")!.textContent!) / 1000, mine / 1000));
      }
      const list = document.querySelector(".nd-l")!;
      expect(list.querySelector(".up, .down")).toBeNull();
      expect(list.textContent).not.toMatch(MARKS);
      expect(list.textContent).not.toMatch(DASH);
      // and it says these are regional averages, not pump prices
      expect(document.querySelector(".nd .cap")!.textContent).toMatch(/^Each price is the weekly average for that state's region, not a pump price\./);
    }
    for (const code of ["AK", "HI"]) {
      const { document } = parseHTML(readFileSync(resolve(built!, `state/${code.toLowerCase()}/index.html`), "utf8"));
      expect(document.querySelector(".nd")).toBeNull();
    }
  });
});

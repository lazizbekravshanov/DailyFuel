import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadRawData, type TaxFile } from "./data.ts";
import {
  formatCpg, inSentence, newestRate, ordinal, quoteCpg, rankLabel, sinceLabel, spokenCpg,
  taxViews, taxVintage, toMils,
} from "./tax.ts";

function file(
  states: Record<string, number | null>,
  notes: Record<string, string> = {},
  extra: { effective?: Record<string, string | null>; out_of_date?: string[] } = {},
): TaxFile {
  const effective = extra.effective ??
    Object.fromEntries(Object.entries(states).map(([code, v]) => [code, v === null ? null : "2024-01-01"]));
  return {
    schema: "dailyfuel/state-diesel-tax/1",
    source: "FHWA Highway Statistics, table MF-121T",
    source_url: "https://www.fhwa.dot.gov/policyinformation/statistics/2024/xls/mf121t.xlsx",
    reporting_period: "2024",
    published: "2025-10-16",
    fetched_at: "2026-09-17T12:17:03Z",
    federal_cpg: 24.4,
    states,
    effective,
    out_of_date: extra.out_of_date ?? [],
    notes,
    scope: "This counts state taxes charged by the gallon. Sales taxes, local fuel taxes and some other state taxes on fuel aren't in it, so what you pay can be more.",
  };
}

describe("cents a gallon", () => {
  it("keeps one decimal on whole cents", () => {
    expect(formatCpg(30)).toBe("30.0¢");
    expect(formatCpg(8)).toBe("8.0¢");
    expect(formatCpg(74.1)).toBe("74.1¢");
  });

  it("shows hundredths where FHWA has them instead of rounding them off", () => {
    expect(formatCpg(46.85)).toBe("46.85¢");
    expect(formatCpg(23.55)).toBe("23.55¢");
    expect(formatCpg(29.75)).toBe("29.75¢");
    expect(formatCpg(32.299)).toBe("32.299¢");
    expect(formatCpg(74.099999999999994)).toBe("74.1¢");
  });

  it("drops the unit in a table cell, where the head says TAX ¢", () => {
    expect(quoteCpg(30)).toBe("30.0");
    expect(quoteCpg(46.85)).toBe("46.85");
    expect(quoteCpg(74.1)).toBe("74.1");
  });

  it("counts in thousandths of a cent so sums are exact", () => {
    expect(toMils(46.85)).toBe(46850);
    expect(toMils(24.4)).toBe(24400);
    expect(toMils(0.1) + toMils(0.2)).toBe(300);
  });

  it("says it out loud without a pointless tenth", () => {
    expect(spokenCpg(30)).toBe("30 cents a gallon");
    expect(spokenCpg(46.85)).toBe("46.85 cents a gallon");
    expect(spokenCpg(74.1)).toBe("74.1 cents a gallon");
  });
});

describe("ordinals", () => {
  it("handles the teens and the ones", () => {
    expect([1, 2, 3, 4, 5, 11, 12, 13, 21, 22, 23, 50, 51, 101, 111].map(ordinal)).toEqual([
      "1st", "2nd", "3rd", "4th", "5th", "11th", "12th", "13th", "21st", "22nd", "23rd",
      "50th", "51st", "101st", "111th",
    ]);
  });
});

describe("tax views", () => {
  const tax = file({ PA: 74.1, IN: 59, OH: 47, AL: 30, AZ: 26, AK: 8 });
  const views = taxViews(tax);

  it("adds the federal rate exactly", () => {
    expect(views.get("AL")!.total).toBe(54.4);
    expect(views.get("AK")!.total).toBe(32.4);
    expect(formatCpg(views.get("PA")!.total!)).toBe("98.5¢");
  });

  it("never loses a cent to float addition", () => {
    const odd = taxViews(file({ MD: 46.85, GA: 36.2 }));
    expect(odd.get("MD")!.total).toBe(71.25);
    expect(formatCpg(odd.get("MD")!.total!)).toBe("71.25¢");
    expect(odd.get("GA")!.total).toBe(60.6);
  });

  it("ranks the highest rate first", () => {
    expect(views.get("PA")!.rank).toBe(1);
    expect(views.get("AK")!.rank).toBe(6);
    expect(views.get("PA")!.ranked).toBe(6);
  });

  it("gives tied rates the same rank and skips the next one", () => {
    const tied = taxViews(file({ A1: 50, A2: 40, A3: 40, A4: 30 }));
    expect([tied.get("A1")!.rank, tied.get("A2")!.rank, tied.get("A3")!.rank, tied.get("A4")!.rank])
      .toEqual([1, 2, 2, 4]);
  });

  it("ties on the value, not on the float spelling", () => {
    const tied = taxViews(file({ A1: 30, A2: 30.0, A3: 29.999 }));
    expect(tied.get("A1")!.rank).toBe(1);
    expect(tied.get("A2")!.rank).toBe(1);
    expect(tied.get("A3")!.rank).toBe(3);
  });

  it("leaves a state with no published rate out of the ranking", () => {
    const some = taxViews(file({ PA: 74.1, DC: null, AK: 8 }));
    expect(some.get("DC")).toMatchObject({ state: null, total: null, rank: null, ranked: 2 });
    expect(some.get("AK")!.rank).toBe(2);
  });

  it("carries the note for the states that have one", () => {
    const noted = taxViews(file({ AZ: 26, OH: 47 }, { AZ: "Arizona's rate here is the truck rate." }));
    expect(noted.get("AZ")!.note).toBe("Arizona's rate here is the truck rate.");
    expect(noted.get("OH")!.note).toBeNull();
  });

  it("carries when each rate took effect", () => {
    const dated = taxViews(file({ UT: 31, KY: 23.4, DC: null }, {}, {
      effective: { UT: "2021-01-01", KY: "2024-10-01", DC: null },
    }));
    expect(dated.get("KY")!.since).toBe("2024-10-01");
    expect(sinceLabel(dated.get("KY")!)).toBe("Since October 2024");
    expect(sinceLabel(dated.get("DC")!)).toBeNull();
  });

  it("leaves an out of date rate out of the total and the ranking", () => {
    // FHWA's Utah row is 31 cents from 2021. Ranked, it would sit above Ohio's
    // 30 and push Ohio down a place with a wrong number.
    const views = taxViews(file({ PA: 74.1, UT: 31, OH: 30, AK: 8 }, { UT: "out of date" }, { out_of_date: ["UT"] }));
    expect(views.get("UT")).toMatchObject({ state: 31, total: null, rank: null, outOfDate: true, ranked: 3 });
    expect(views.get("OH")!.rank).toBe(2);
    expect(views.get("OH")!.total).toBe(54.4);
    expect(views.get("PA")!.outOfDate).toBe(false);
  });
});

describe("labels", () => {
  it("says where a state ranks", () => {
    const views = taxViews(file({ PA: 74.1, IN: 59, OH: 47, AL: 30, AZ: 26, AK: 8 }));
    expect(rankLabel(views.get("IN")!)).toBe("2nd highest");
    expect(rankLabel(views.get("OH")!)).toBe("3rd highest");
  });

  it("counts from the low end when that's nearer, and names the ends", () => {
    const views = taxViews(file({ PA: 74.1, IN: 59, OH: 47, AL: 30, AZ: 26, AK: 8 }));
    expect(rankLabel(views.get("PA")!)).toBe("Highest");
    expect(rankLabel(views.get("AZ")!)).toBe("2nd lowest");
    expect(rankLabel(views.get("AK")!)).toBe("Lowest");
  });

  it("shares the low end on a tie", () => {
    const views = taxViews(file({ A1: 50, A2: 40, A3: 8, A4: 8 }));
    expect(rankLabel(views.get("A3")!)).toBe("Lowest");
    expect(rankLabel(views.get("A4")!)).toBe("Lowest");
  });

  it("has no rank line for a state with no rate", () => {
    const views = taxViews(file({ PA: 74.1, DC: null }));
    expect(rankLabel(views.get("DC")!)).toBeNull();
  });

  // spokenRank and rankedNote went with the road sign's tax panel: the paper
  // terminal's RANK box says "of 49 with a current rate" itself

  it("gives DC its article in a sentence and leaves states alone", () => {
    expect(inSentence("District of Columbia")).toBe("the District of Columbia");
    expect(inSentence("Ohio")).toBe("Ohio");
  });

  it("dates the figures by the newest rate in them, not the day FHWA published", () => {
    const tax = file({ UT: 31, KY: 23.4, DC: null }, {}, {
      effective: { UT: "2021-01-01", KY: "2024-10-01", DC: null },
    });
    expect(newestRate(tax)).toBe("2024-10-01");
    expect(taxVintage(tax)).toBe(
      "From FHWA's 2024 table. The newest rate in it took effect in October 2024, and many states change their " +
      "rate every year, so it may be different now.");
    expect(taxVintage(tax)).not.toContain("2025");
  });
});

describe("the tax file on disk", () => {
  // Copies of data/ with one thing changed, so the loader's checks run against
  // the real file shape. Nothing here writes inside the repo.
  const made: string[] = [];
  function copyOfData(edit?: (doc: Record<string, any>) => void, remove = false): string {
    const dir = mkdtempSync(join(tmpdir(), "dailyfuel-tax-"));
    made.push(dir);
    cpSync("data", dir, { recursive: true });
    const path = join(dir, "taxes", "state_diesel_tax.json");
    if (remove) rmSync(path);
    else if (edit) {
      const doc = JSON.parse(readFileSync(path, "utf8"));
      edit(doc);
      writeFileSync(path, JSON.stringify(doc));
    }
    return dir;
  }
  afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("loads the committed FHWA file", () => {
    const { tax } = loadRawData("data");
    expect(tax).not.toBeNull();
    expect(Object.keys(tax!.states)).toHaveLength(51);
    expect(tax!.federal_cpg).toBe(24.4);
    expect(tax!.states.PA).toBe(74.1);
    expect(tax!.states.DC).toBeNull();
    expect(tax!.scope.length).toBeGreaterThan(0);
    expect(tax!.out_of_date).toEqual(["MN", "UT"]);
    expect(tax!.effective.MN).toBe("2012-07-01");
    expect(tax!.effective.UT).toBe("2021-01-01");
  });

  it("ranks the real file without the stale Utah and Minnesota rates", () => {
    const views = taxViews(loadRawData("data").tax!);
    expect(views.get("UT")!.rank).toBeNull();
    expect(views.get("MN")!.rank).toBeNull();
    expect(views.get("PA")!.ranked).toBe(48);
    expect(rankLabel(views.get("PA")!)).toBe("Highest");
    expect(rankLabel(views.get("AK")!)).toBe("Lowest");
  });

  it("keeps tax out of the price snapshot", () => {
    const { latest } = loadRawData("data");
    for (const row of latest.states) expect(Object.keys(row)).not.toContain("tax");
  });

  it("builds without it", () => {
    expect(loadRawData(copyOfData(undefined, true)).tax).toBeNull();
  });

  it("refuses a rate left in dollars", () => {
    // FHWA's sheet has Massachusetts as 0.24. The file must hold 24.
    expect(() => loadRawData(copyOfData((d) => { d.states.MA = 0.24; }))).toThrow(/state_diesel_tax\.json/);
  });

  it("refuses a file missing a state", () => {
    expect(() => loadRawData(copyOfData((d) => { delete d.states.OH; }))).toThrow(/state_diesel_tax\.json/);
  });

  it("refuses an out of date state with no note saying why", () => {
    expect(() => loadRawData(copyOfData((d) => { delete d.notes.UT; }))).toThrow(/UT out of date without a note/);
  });

  it("refuses a rate with no effective date", () => {
    expect(() => loadRawData(copyOfData((d) => { d.effective.OH = null; }))).toThrow(/OH with a rate and an effective date/);
  });

  it("refuses a file without the line about what it counts", () => {
    expect(() => loadRawData(copyOfData((d) => { delete d.scope; }))).toThrow(/scope/);
  });
});

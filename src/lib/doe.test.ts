import { describe, expect, it } from "vitest";
import { peakKind } from "./stats.ts";
import { allRegionsSentence, peakSentence, DOE_LINE } from "./doe.ts";

const s = (vals: number[]) =>
  vals.map((v, i) => ({ date: new Date(Date.UTC(2025, 0, 6 + i * 7)).toISOString().slice(0, 10), value: v }));

describe("peakKind", () => {
  it("calls a strict new high a record", () => expect(peakKind(s([5, 6, 5.5, 6.1]))).toBe("record"));
  it("never counts a tie as a new high", () => expect(peakKind(s([5, 6.1, 5.5, 6.1]))).toBeNull());
  it("finds a 52 week high that is not a record", () => {
    const vals = [9, ...Array.from({ length: 60 }, (_, i) => 5 + (i === 59 ? 1 : 0))];
    expect(peakKind(s(vals))).toBe("52week");
  });
  it("ignores null weeks", () => {
    const pts = s([5, 6, 7]);
    pts.splice(1, 0, { date: "2025-01-10", value: null as unknown as number });
    expect(peakKind(pts)).toBe("record");
  });
  it("needs two points", () => expect(peakKind(s([5]))).toBeNull());
});

describe("wording", () => {
  it("names the series and the start of our records", () =>
    expect(peakSentence("record", "Midwest")).toBe("Highest Midwest price in our records, which start June 2022."));
  it("says nothing when there is no peak", () => expect(peakSentence(null, "Midwest")).toBeNull());
  // the peak tag test went with peakTag: the old cards and charts were the only readers
  it("summarizes the regions", () => {
    expect(allRegionsSentence(["record", "record"])).toMatch(/^Every region/);
    expect(allRegionsSentence(["record", null])).toMatch(/^1 of 2 regions/);
    expect(allRegionsSentence([null, "52week"])).toBeNull();
  });
  it("never uses dashes as punctuation", () => {
    for (const t of [DOE_LINE, peakSentence("record", "U.S.")!]) expect(t).not.toMatch(/[–—]| - /);
  });
});

import { describe, expect, it } from "vitest";
import { binFor, directionFor, moveClass } from "./bins.ts";

// The legend tests (legendItems, legendTicks) are gone with the map: the paper
// terminal has no key to label. The bins themselves stay, since they decide
// what counts as a rise, a fall and about the same everywhere on the page.

describe("weekly bins (cents): under 1, 1 to 5, 5 to 15, 15 or more", () => {
  const cases: [number, string][] = [
    [0, "flat"],
    [0.004, "flat"],
    [0.005, "flat"], // half a cent is penny noise in a weekly number
    [0.009, "flat"],
    [0.0094, "flat"], // shows as 0.9¢
    [0.0095, "up-1"], // shows as 1.0¢, so it is not about the same
    [0.01, "up-1"],
    [0.049, "up-1"],
    [0.0494, "up-1"],
    [0.0495, "up-2"], // shows as 5.0¢
    [0.05, "up-2"],
    [0.149, "up-2"],
    [0.15, "up-3"],
    [1.2, "up-3"],
    [-0.004, "flat"],
    [-0.005, "flat"],
    [-0.0094, "flat"],
    [-0.0095, "down-1"],
    [-0.01, "down-1"],
    [-0.049, "down-1"],
    [-0.05, "down-2"],
    [-0.149, "down-2"],
    [-0.15, "down-3"],
  ];
  for (const [change, bin] of cases) {
    it(`${change} -> ${bin}`, () => expect(binFor(change, "weekly")).toBe(bin));
  }
});

describe("daily bins (cents): under 0.2, 0.2 to 2, 2 to 6, 6 or more", () => {
  const cases: [number, string][] = [
    [0, "flat"],
    [0.0014, "flat"],
    [0.0015, "up-1"],
    [0.002, "up-1"],
    [0.0194, "up-1"],
    [0.02, "up-2"],
    [0.0594, "up-2"],
    [0.0595, "up-3"], // shows as 6.0¢
    [0.06, "up-3"],
    [-0.0019, "down-1"],
    [-0.0014, "flat"],
    [-0.002, "down-1"],
    [-0.02, "down-2"],
    [-0.06, "down-3"],
  ];
  for (const [change, bin] of cases) {
    it(`${change} -> ${bin}`, () => expect(binFor(change, "daily")).toBe(bin));
  }
});

describe("direction", () => {
  it("treats sub threshold changes as about the same", () => {
    expect(directionFor(0.003, "weekly")).toBe("flat");
    expect(directionFor(0.009, "weekly")).toBe("flat");
    expect(directionFor(-0.009, "weekly")).toBe("flat");
    expect(directionFor(0.01, "weekly")).toBe("up");
    expect(directionFor(0.003, "daily")).toBe("up");
    expect(directionFor(-0.3, "daily")).toBe("down");
  });
});

describe("the ink a printed change wears", () => {
  it("is red for a rise and blue for a fall", () => {
    expect(moveClass(0.318, "weekly")).toBe("up");
    expect(moveClass(0.01, "weekly")).toBe("up");
    expect(moveClass(-0.021, "weekly")).toBe("down");
    expect(moveClass(0.002, "daily")).toBe("up");
    expect(moveClass(-0.002, "daily")).toBe("down");
  });

  it("is muted for a weekly move under 1¢, which still prints as +0.3¢", () => {
    expect(moveClass(0.003, "weekly")).toBe("muted");
    expect(moveClass(-0.009, "weekly")).toBe("muted");
    expect(moveClass(0, "weekly")).toBe("muted");
    expect(moveClass(0.0014, "daily")).toBe("muted");
  });

  it("is muted when there is nothing to compare with", () => {
    expect(moveClass(null, "weekly")).toBe("muted");
  });
});

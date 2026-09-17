import { describe, expect, it } from "vitest";
import { binFor, directionFor, legendItems } from "./bins.ts";

describe("weekly bins (cents): under 0.5, 0.5 to 5, 5 to 15, 15 or more", () => {
  const cases: [number, string][] = [
    [0, "flat"],
    [0.004, "flat"],
    [0.0044, "flat"],
    [0.0045, "up-1"], // shows as 0.5¢, so it is not about the same
    [0.005, "up-1"],
    [0.049, "up-1"],
    [0.0494, "up-1"],
    [0.0495, "up-2"], // shows as 5.0¢
    [0.05, "up-2"],
    [0.149, "up-2"],
    [0.15, "up-3"],
    [1.2, "up-3"],
    [-0.004, "flat"],
    [-0.005, "down-1"],
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

describe("direction and legend", () => {
  it("treats sub threshold changes as about the same", () => {
    expect(directionFor(0.003, "weekly")).toBe("flat");
    expect(directionFor(0.003, "daily")).toBe("up");
    expect(directionFor(-0.3, "daily")).toBe("down");
  });

  it("writes ranges with 'to', never a dash", () => {
    const weekly = legendItems("weekly").map((i) => i.label);
    expect(weekly).toEqual([
      "Fell 15¢ or more",
      "Fell 5 to 15¢",
      "Fell 0.5 to 5¢",
      "About the same, under 0.5¢",
      "Rose 0.5 to 5¢",
      "Rose 5 to 15¢",
      "Rose 15¢ or more",
    ]);
    const daily = legendItems("daily").map((i) => i.label);
    expect(daily[3]).toBe("About the same, under 0.2¢");
    expect(daily[6]).toBe("Rose 6¢ or more");
    for (const l of [...weekly, ...daily]) expect(l).not.toMatch(/[–—]| - /);
  });
});

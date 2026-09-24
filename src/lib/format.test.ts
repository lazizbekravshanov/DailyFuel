import { describe, expect, it } from "vitest";
import {
  centsSign,
  changeClass,
  changeTenths,
  changeVerb,
  formatCents,
  formatMove,
  formatPct,
  formatPrice,
  formatQuote,
  formatSignedCents,
  formatTick,
  priceParts,
  signedCents,
  signedPct,
  spokenChange,
  spokenPrice,
  toMills,
} from "./format.ts";

describe("money on the paper terminal", () => {
  it("prints a price as $6.285 in a heading and 6.285 in a table", () => {
    expect(formatPrice(6.285)).toBe("$6.285");
    expect(formatQuote(6.285)).toBe("6.285");
    expect(formatQuote(5)).toBe("5.000");
    expect(formatQuote(12.001)).toBe("12.001");
    expect(formatQuote(6.5595)).toBe("6.560");
  });

  it("prints a change as +31.8¢ +5.3%, the sign carrying the direction", () => {
    expect(formatMove(0.318, 5.33)).toBe("+31.8¢ +5.3%");
    expect(formatMove(-0.16, -2.17)).toBe("−16.0¢ −2.2%");
    expect(formatMove(0, 0)).toBe("0.0¢ 0.0%");
    expect(formatMove(0.012, null)).toBe("+1.2¢");
    // a move too small for the percent to show a sign still says which way it went
    expect(formatMove(0.001, 0.016)).toBe("+0.1¢ 0.0%");
    expect(formatMove(-0.001, -0.016)).toBe("−0.1¢ 0.0%");
  });

  it("gives a table cell the signed number alone, the unit being in the column head", () => {
    expect(signedCents(0.318)).toBe("+31.8");
    expect(signedCents(-0.042)).toBe("−4.2");
    expect(signedCents(0.0003)).toBe("0.0");
    expect(signedCents(-0.5213)).toBe("−52.1");
    expect(signedPct(5.33)).toBe("+5.3");
    expect(signedPct(-0.05)).toBe("−0.1");
    expect(signedPct(0.04)).toBe("0.0");
    expect(signedPct(12.25)).toBe("+12.3");
  });

  it("names the class a change wears, and none for no move", () => {
    expect(changeClass(0.318)).toBe("up");
    expect(changeClass(-0.001)).toBe("down");
    expect(changeClass(0.0004)).toBe("");
    expect(changeClass(-0.0004)).toBe("");
    expect(changeClass(0)).toBe("");
    expect(changeClass(null)).toBe("");
  });

  it("agrees with itself: the cell, the heading and the class come from one rounding", () => {
    for (const change of [0.318, -0.16, 0.0125, -0.0125, 0.0004, 0.001, 3.2]) {
      const cents = signedCents(change);
      expect(formatSignedCents(change)).toBe(`${cents}¢`);
      expect(formatMove(change, null)).toBe(`${cents}¢`);
      const cls = changeClass(change);
      expect(cls === "" ? "0.0" : cls === "up" ? "+" : "−").toBe(cls === "" ? cents : cents.charAt(0));
    }
  });
});

describe("price parts, kept for the parts of the old look not yet redrawn", () => {
  it("splits $6.285 into $6.28 and a raised 5", () => {
    expect(priceParts(6.285)).toEqual({ main: "$6.28", tenth: "5", plain: "$6.285" });
  });

  it("rounds AAA four decimal prices half up to the tenth of a cent", () => {
    expect(priceParts(6.5597).plain).toBe("$6.560");
    expect(priceParts(6.5595).plain).toBe("$6.560");
    expect(priceParts(6.5594).plain).toBe("$6.559");
    expect(priceParts(3.9995)).toEqual({ main: "$4.00", tenth: "0", plain: "$4.000" });
  });

  it("keeps zeros where they belong", () => {
    expect(priceParts(5).plain).toBe("$5.000");
    expect(priceParts(5.05)).toEqual({ main: "$5.05", tenth: "0", plain: "$5.050" });
    expect(priceParts(12.001)).toEqual({ main: "$12.00", tenth: "1", plain: "$12.001" });
  });

  it("survives float noise", () => {
    expect(toMills(0.1 + 0.2 + 5.985)).toBe(6285);
    expect(formatPrice(1.005)).toBe("$1.005");
    expect(formatPrice(4.4445)).toBe("$4.445");
  });

  it("reads well out loud", () => {
    expect(spokenPrice(6.285)).toBe("$6.285 per gallon");
  });

  it("rejects negative prices", () => {
    expect(() => priceParts(-1)).toThrow(RangeError);
  });
});

describe("change formatting", () => {
  // the "31.8¢ (+5.3%)" tests went with formatChange and pctHasSign: the
  // arrow that carried the sign is gone, and every change prints with formatMove

  it("rounds four decimal changes half away from zero", () => {
    expect(changeTenths(0.0123)).toBe(12);
    expect(changeTenths(0.0125)).toBe(13);
    expect(changeTenths(-0.0125)).toBe(-13);
    expect(changeTenths(0.0004)).toBe(0);
    expect(changeTenths(-0.0004)).toBe(0);
    expect(formatCents(-0.5213)).toBe("52.1¢");
  });

  it("signs cents and percents with a real minus sign", () => {
    expect(formatSignedCents(0.318)).toBe("+31.8¢");
    expect(formatSignedCents(-0.042)).toBe("−4.2¢");
    expect(formatSignedCents(0.0003)).toBe("0.0¢");
    expect(centsSign(0.318)).toBe("+");
    expect(centsSign(-0.042)).toBe("−");
    expect(centsSign(-0.0004)).toBe("");
    expect(formatPct(5.33)).toBe("+5.3%");
    expect(formatPct(-0.05)).toBe("−0.1%");
    expect(formatPct(0.04)).toBe("0.0%");
    expect(formatPct(12.25)).toBe("+12.3%");
  });

  it("rounds a percent once, straight to tenths", () => {
    // Percents computed in TypeScript arrive at full precision, not quantized to
    // hundredths the way the pipeline's change_pct is. Rounding twice moved these.
    expect(formatPct(11.848512173128945)).toBe("+11.8%");
    expect(formatPct(-3.2451)).toBe("−3.2%");
    expect(formatPct(9.7451)).toBe("+9.7%");
  });

  it("still rounds an exact tie away from zero", () => {
    expect(formatPct((-6025 / 50000) * 100)).toBe("−12.1%");
    expect(formatPct((-14382 / 22560) * 100)).toBe("−63.8%");
    expect(formatPct((9867 / 34320) * 100)).toBe("+28.8%");
  });

  it("says the change in words", () => {
    expect(spokenChange(0.318)).toBe("up 31.8 cents");
    expect(spokenChange(-0.12)).toBe("down 12.0 cents");
    expect(spokenChange(0.0002)).toBe("no change");
    expect(changeVerb(0.318)).toBe("rose 31.8¢");
    expect(changeVerb(-0.042)).toBe("fell 4.2¢");
    expect(changeVerb(0)).toBe("held steady");
  });

  it("formats axis ticks to the cent", () => {
    expect(formatTick(6)).toBe("$6.00");
    expect(formatTick(5.5)).toBe("$5.50");
    expect(formatTick(3.25)).toBe("$3.25");
  });
});

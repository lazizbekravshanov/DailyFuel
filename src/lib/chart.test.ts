import { describe, expect, it } from "vitest";
import { buildChart, chartLabel, readoutX, sharedDollarDomain, sparseMonths, spokenMove, windowStart, yLabels } from "./chart.ts";
import { addDays } from "./dates.ts";
import type { Point } from "./stats.ts";

function weekly(start: string, values: (number | null)[]): Point[] {
  return values.map((value, i) => ({ date: addDays(start, 7 * i), value }));
}

describe("sharedDollarDomain", () => {
  it("covers the data on half dollars and labels $4, $6, $8", () => {
    const d = sharedDollarDomain([
      [{ date: "2026-01-12", value: 3.365 }],
      [{ date: "2026-09-14", value: 8.039 }],
    ]);
    expect(d.lo).toBe(3);
    expect(d.hi).toBe(8.5);
    expect(d.ticks).toEqual([4, 6, 8]);
  });

  it("uses a finer step for a narrow range, still three labels at most", () => {
    const d = sharedDollarDomain([[{ date: "2026-01-12", value: 3.6 }, { date: "2026-01-19", value: 4.4 }]]);
    expect(d.lo).toBe(3.5);
    expect(d.hi).toBe(4.5);
    expect(d.ticks).toEqual([4, 4.5]);
  });

  it("keeps a flat series off the frame", () => {
    const d = sharedDollarDomain([[{ date: "2026-01-12", value: 4 }]]);
    expect(d.hi).toBeGreaterThan(d.lo);
  });

  it("never labels the bottom edge", () => {
    const d = sharedDollarDomain([[{ date: "2026-01-12", value: 4.1 }, { date: "2026-01-19", value: 5.9 }]]);
    expect(d.ticks).not.toContain(d.lo);
  });
});

describe("sparseMonths", () => {
  it("names the first, middle and last month in a 52 week window", () => {
    expect(sparseMonths(windowStart("2026-09-14", 364), "2026-09-14")).toEqual(["2025-10-01", "2026-03-01", "2026-09-01"]);
  });

  it("counts a window that starts on the 1st", () => {
    expect(sparseMonths("2026-01-01", "2026-03-15")).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
  });

  it("returns what there is for a short window", () => {
    expect(sparseMonths("2026-08-20", "2026-09-14")).toEqual(["2026-09-01"]);
  });
});

describe("buildChart for small multiples", () => {
  const history = weekly("2025-06-02", Array.from({ length: 67 }, (_, i) => 3.5 + i * 0.03));
  const to = history[history.length - 1].date; // 2026-09-07
  const from = windowStart(to, 364);
  const domain = sharedDollarDomain([history.filter((p) => p.date >= from)]);
  const m = buildChart([{ id: "R20", label: "Midwest", kind: "primary", points: history }], {
    from,
    to,
    yDomain: domain,
    heightPx: 132,
    xTicks: "sparse",
    wholeDollarTicks: true,
  });

  it("labels round dollars and rules the bottom edge too", () => {
    expect(m.yTicks.map((t) => t.label)).toEqual(domain.ticks!.map((v) => `$${v}`));
    expect(m.grid[0]).toBe(domain.lo);
    expect(m.grid.slice(1)).toEqual(domain.ticks);
  });

  it("puts three month names at their month starts, reading from the start", () => {
    expect(m.xTicks.map((t) => t.label)).toEqual(["Oct", "Mar", "Sep"]);
    expect(m.xTicks.every((t) => t.anchor === "start")).toBe(true);
    expect(m.xTicks[0].pos).toBeLessThan(m.xTicks[1].pos);
  });

  it("draws only the window, and keeps the week before it for the first change", () => {
    // the window opens on a Tuesday, so the first weekly point is the Monday after
    expect(from).toBe("2025-09-09");
    expect(m.paths[0].points[0].date).toBe("2025-09-15");
    expect(m.hover.dates[0]).toBe("2025-09-15");
    expect(m.hover.prev).toEqual(["2025-09-08", history.find((p) => p.date === "2025-09-08")!.value]);
  });

  it("ends at the right edge", () => {
    expect(m.ends[0].x).toBe(100);
    expect(m.hover.x[m.hover.x.length - 1]).toBe(100);
  });
});

describe("buildChart for the state chart", () => {
  const pts = weekly("2025-09-22", Array.from({ length: 52 }, (_, i) => 3.7 + (i % 10) * 0.1));
  const to = pts[pts.length - 1].date;
  const m = buildChart([{ id: "eia", label: "EIA weekly, Midwest", kind: "primary", points: pts }], {
    from: pts[0].date,
    to,
    heightPx: 300,
    xTicks: "months",
    maxYTicks: 6,
  });

  it("keeps $x.xx tick labels on a nice domain", () => {
    expect(m.yTicks[0].label).toMatch(/^\$\d\.\d\d$/);
    expect(m.yTicks[0].pos).toBe(100);
    expect(m.yTicks[m.yTicks.length - 1].pos).toBe(0);
    expect(m.grid).toEqual(m.yTicks.map((t) => t.value));
  });

  it("keeps month ticks off the edges, every other one minor", () => {
    for (const t of m.xTicks) {
      expect(t.pos).toBeGreaterThanOrEqual(3);
      expect(t.pos).toBeLessThanOrEqual(97);
    }
    expect(m.xTicks.filter((t) => t.minor).length).toBeGreaterThan(0);
  });

  it("thins every other major tick for the narrowest phones, keeping the year", () => {
    const majors = m.xTicks.filter((t) => !t.minor);
    const kept = majors.filter((t) => !t.thin).map((t) => t.label);
    // Oct 2025 to Sep 2026: every other month is major, and half of those stay at 320px
    expect(kept).toContain("2026");
    expect(kept.length).toBeGreaterThanOrEqual(2);
    expect(kept.length).toBeLessThan(majors.length);
    // the ones that stay are 4 months apart, so their labels never touch
    const days = majors.filter((t) => !t.thin).map((t) => t.value);
    for (let k = 1; k < days.length; k++) expect(days[k] - days[k - 1]).toBeGreaterThanOrEqual(118);
    expect(m.xTicks.filter((t) => t.minor).every((t) => !t.thin)).toBe(true);
  });

  it("leaves a short chart's few month names alone", () => {
    const days: Point[] = Array.from({ length: 90 }, (_, i) => ({ date: addDays("2026-06-20", i), value: 6 + (i % 7) * 0.01 }));
    const short = buildChart([{ id: "aaa", label: "AAA daily", kind: "primary", points: days }], {
      from: days[0].date, to: days[89].date, heightPx: 300, xTicks: "months",
    });
    expect(short.xTicks.map((t) => t.label)).toEqual(["Jul", "Aug", "Sep"]);
    expect(short.xTicks.some((t) => t.thin)).toBe(false);
  });

  it("has no earlier week when the points start at the window", () => {
    expect(m.hover.prev).toBeNull();
  });
});

describe("buildChart with a step benchmark", () => {
  const daily: Point[] = Array.from({ length: 10 }, (_, i) => ({ date: addDays("2026-09-05", i), value: 6 + i * 0.01 }));
  const eia = weekly("2026-08-31", [5.9, 6.0]);
  const m = buildChart(
    [
      { id: "aaa", label: "AAA daily", kind: "primary", points: daily },
      { id: "eia", label: "EIA weekly", kind: "bench", points: eia, step: true },
    ],
    { from: "2026-09-05", to: "2026-09-14", heightPx: 300, xTicks: "months" },
  );

  it("carries the week in effect into the window and holds it to the right edge", () => {
    const b = m.paths[1];
    expect(b.step).toBe(true);
    expect(b.points[0]).toEqual({ date: "2026-09-05", value: 5.9 });
    expect(b.points[b.points.length - 1]).toEqual({ date: "2026-09-14", value: 6.0 });
  });

  it("hovers on the daily dates with the weekly value in effect", () => {
    expect(m.hover.dates).toHaveLength(10);
    expect(m.hover.series[1].values[0]).toBe(5.9);
    expect(m.hover.series[1].values[9]).toBe(6.0);
  });
});

describe("the state chart on the paper terminal", () => {
  // 52 weeks ending Sep 21, 2026, rising into a record
  const pts = weekly("2025-09-29", Array.from({ length: 52 }, (_, i) => 3.7 + i * 0.05));
  const to = pts[pts.length - 1].date;
  const m = buildChart([{ id: "eia", label: "EIA weekly, Midwest", kind: "primary", points: pts }], {
    from: pts[0].date,
    to,
    heightPx: 220,
    xTicks: "quarters",
    maxYTicks: 6,
  });

  it("names the quarter months, January by its name and not the year", () => {
    expect(m.xTicks.map((t) => t.label)).toEqual(["Oct", "Jan", "Apr", "Jul"]);
    expect(m.xTicks.some((t) => t.minor || t.thin)).toBe(false);
    for (const t of m.xTicks) expect(t.pos).toBeLessThanOrEqual(97);
    // Oct 1 is two days into this window, so its name reads from the left edge
    expect(m.xTicks[0].pos).toBeLessThan(3);
    expect(m.xTicks[0].anchor).toBe("start");
    expect(m.xTicks.slice(1).every((t) => t.anchor === "middle" && t.pos >= 3)).toBe(true);
  });

  it("lets the readout script land the crosshair where Plot drew the point", () => {
    m.hover.dates.forEach((d, i) => expect(readoutX(m.from, m.to, d)).toBeCloseTo(m.hover.x[i], 1));
    expect(readoutX("2026-01-05", "2026-01-05", "2026-01-05")).toBe(0);
  });

  it("drops the axis label the newest price's tag would cover", () => {
    const end = m.ends[0];
    const kept = yLabels(m);
    expect(kept.length).toBeLessThan(m.yTicks.length);
    for (const t of kept) expect(Math.abs(t.pos - end.y)).toBeGreaterThan(12.5);
    expect(yLabels(m, 0)).toEqual(m.yTicks);
  });
});

describe("spokenMove", () => {
  it("says cents under a dollar and dollars from there", () => {
    expect(spokenMove(0.304)).toBe("up 30.4 cents");
    expect(spokenMove(-0.12)).toBe("down 12.0 cents");
    expect(spokenMove(2.538)).toBe("up $2.54");
    expect(spokenMove(-1)).toBe("down $1.00");
    expect(spokenMove(0)).toBe("no change");
  });
});

describe("chartLabel", () => {
  it("gives now, the move over the year, and the high and low", () => {
    const pts = weekly("2025-09-15", [3.711, 3.365, null, 6.25]);
    pts[3].date = "2026-09-14";
    pts[1].date = "2026-01-12";
    expect(chartLabel({ name: "Midwest weekly diesel price, last 52 weeks", points: pts, weekly: true, tableNote: "Every week is in the table below." })).toBe(
      "Midwest weekly diesel price, last 52 weeks. Now $6.250, up $2.54 from a year ago. " +
        "High $6.250, week of Sep 14, 2026. Low $3.365, week of Jan 12, 2026. Every week is in the table below.",
    );
  });

  it("says a year ago only for a true 52 weeks", () => {
    // a 52 week window opens 363 days back, so its first Monday is 51 weeks back
    const pts = weekly("2025-09-22", Array.from({ length: 52 }, (_, i) => (i === 51 ? 6.25 : 3.73)));
    expect(chartLabel({ name: "Midwest, last 52 weeks", points: pts, weekly: true })).toMatch(
      /^Midwest, last 52 weeks\. Now \$6\.250, up \$2\.52 since the week of Sep 22, 2025\. /,
    );
  });

  it("names the start when the stretch isn't a year", () => {
    const pts = weekly("2022-06-13", [5.8, 5.5, 6.1]);
    expect(chartLabel({ name: "U.S.", points: pts, weekly: true })).toBe(
      "U.S. Now $6.100, up 30.0 cents since the week of Jun 13, 2022. High $6.100, week of Jun 27, 2022. Low $5.500, week of Jun 20, 2022.",
    );
  });

  it("dates daily points plainly", () => {
    const pts: Point[] = [
      { date: "2026-09-01", value: 6 },
      { date: "2026-09-02", value: 6 },
    ];
    expect(chartLabel({ name: "Ohio", points: pts, weekly: false })).toBe(
      "Ohio. Now $6.000, the same as Sep 1, 2026. High $6.000, Sep 2, 2026. Low $6.000, Sep 2, 2026.",
    );
  });

  it("copes with no prices", () => {
    expect(chartLabel({ name: "Alaska", points: [], weekly: true })).toBe("Alaska. No prices yet.");
  });
});

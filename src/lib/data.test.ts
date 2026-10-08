// The build check here and the data job's check before commit
// (build_problems in scripts/dailyfuel/health.py) have to agree on a week where
// EIA left one region's cell blank. If the job let through a week this file
// refuses, Vercel would keep the old deploy while the job looked green. Both
// read the same folders under tests/fixtures/blank_cell/, made by
// tests/fixtures/build_blank_cell.py; the pytest half is in
// tests/test_store_health_fixtures.py.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadRawData } from "./data.ts";

const repo = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

describe("a week where EIA left a region blank", () => {
  it("refuses a blank Rocky Mountain cell in the newest week, as the data job does", () => {
    expect(() => loadRawData(repo("tests/fixtures/blank_cell/newest"))).toThrow(
      "CO has no EIA price for 2026-10-05, but EIA surveys it as part of R40",
    );
  });

  it("takes a blank cell in the week before, as the data job does", () => {
    const { latest } = loadRawData(repo("tests/fixtures/blank_cell/older"));
    const colorado = latest.states.find((s) => s.code === "CO");
    expect(latest.eia?.period).toBe("2026-10-05");
    expect(colorado?.eia?.price).toBeTypeOf("number");
    expect(colorado?.eia?.prev).toBeNull();
  });

  it("takes the committed data, as the data job does", () => {
    expect(() => loadRawData(repo("data"))).not.toThrow();
  });
});

// The trip route finder (src/scripts/route.ts) on a toy network and on the
// real freight roads the map ships, joins included.
import { describe, expect, it } from "vitest";
import { distMi } from "../components/map/geo.ts";
import { loadMapData, roadsPayload } from "../lib/mapdata.ts";
import { decodeLines } from "./map.ts";
import { route } from "./route.ts";

type LL = [number, number];
const miles = (p: LL[]) => p.slice(1).reduce((m, q, i) => m + distMi(p[i][0], p[i][1], q[0], q[1]), 0);

describe("the trip route", () => {
  it("takes the shorter of two ways, from the town to the road and back to the town", () => {
    const lines: LL[][] = [
      [[40, -90], [40, -89], [40, -88]],
      [[40, -90], [41, -89], [40, -88]],
    ];
    const p = route([40.1, -90.1], [40.1, -87.9], lines)!;
    expect(p[0]).toEqual([40.1, -90.1]);
    expect(p[p.length - 1]).toEqual([40.1, -87.9]);
    expect(p.slice(1, -1)).toEqual([[40, -90], [40, -89], [40, -88]]);
  });

  it("gives up when the nearest roads don't connect", () => {
    expect(route([40, -90], [40, -80], [[[40, -90], [40, -89]], [[40, -81], [40, -80]]])).toBeNull();
  });

  it("follows the freight highways for real trips, at about the miles a driver would drive", () => {
    const pay = roadsPayload(loadMapData().roads, 2);
    const net = [...decodeLines(pay.i, pay.p), ...decodeLines(pay.o, pay.p), ...pay.r.flatMap((r) => decodeLines(r[2], pay.p)), ...decodeLines(pay.j, pay.p)];
    for (const [a, b, lo, hi] of [
      [[41.88, -87.63], [39.1, -84.51], 260, 330], // Chicago to Cincinnati, about 295 by road
      [[34.05, -118.24], [33.45, -112.07], 350, 420], // Los Angeles to Phoenix, about 370
      [[40.71, -74.0], [42.36, -71.06], 200, 250], // New York to Boston, about 215
    ] as [LL, LL, number, number][]) {
      const p = route(a, b, net)!;
      expect(p, `${a} to ${b}`).not.toBeNull();
      const m = miles(p);
      expect(m, `${a} to ${b}`).toBeGreaterThan(lo);
      expect(m, `${a} to ${b}`).toBeLessThan(hi);
      // longer than the straight line, as a road is
      expect(m).toBeGreaterThan(distMi(a[0], a[1], b[0], b[1]));
    }
  });
});

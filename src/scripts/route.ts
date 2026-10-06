// The trip's route along the freight highways, loaded by the map only when a
// trip is asked for: served as /map/route.js by src/pages/map/route.js.ts.

import { distMi } from "../components/map/geo.ts";

type LL = [number, number];

/**
 * The shortest way from a to b along the freight highways, as [lat, lon]
 * points from a to b, or null when the roads nearest the two don't connect.
 * The lines are the map's freight roads plus the joins that make them one
 * graph (see roadJoins in src/lib/mapdata.ts); each end steps from its town
 * to the nearest point on them.
 */
export function route(a: LL, b: LL, lines: LL[][]): LL[] | null {
  const adj = new Map<string, [string, number][]>(),
    at = new Map<string, LL>(),
    link = (u: string, v: string, d: number) =>
      (adj.get(u) || adj.set(u, []).get(u)!).push([v, d]);
  for (const l of lines)
    for (let i = 1; i < l.length; i++) {
      const p = l[i - 1],
        q = l[i],
        u = p + "",
        v = q + "",
        d = distMi(p[0], p[1], q[0], q[1]);
      at.set(u, p).set(v, q);
      link(u, v, d);
      link(v, u, d);
    }
  let s = "",
    t = "",
    ds = 1e9,
    dt = 1e9;
  for (const [n, q] of at) {
    const x = distMi(a[0], a[1], q[0], q[1]),
      y = distMi(b[0], b[1], q[0], q[1]);
    if (x < ds) ((ds = x), (s = n));
    if (y < dt) ((dt = y), (t = n));
  }
  // Dijkstra on a binary heap of [miles, node]
  const dist = new Map([[s, 0]]),
    prev = new Map<string, string>(),
    h: [number, string][] = [[0, s]];
  while (h.length) {
    const top = h[0],
      e = h.pop()!;
    if (h.length) {
      let i = 0;
      for (let c = 1; c < h.length; i = c, c = 2 * c + 1) {
        if (c + 1 < h.length && h[c + 1][0] < h[c][0]) c++;
        if (h[c][0] >= e[0]) break;
        h[i] = h[c];
      }
      h[i] = e;
    }
    const [d, u] = top;
    if (u == t) break;
    if (d > dist.get(u)!) continue;
    for (const [v, w] of adj.get(u) || []) {
      const nd = d + w;
      if (nd < (dist.get(v) ?? 1e9)) {
        dist.set(v, nd);
        prev.set(v, u);
        let i = h.push([nd, v]) - 1;
        for (let p; i && h[(p = (i - 1) >> 1)][0] > nd; i = p)
          [h[i], h[p]] = [h[p], h[i]];
      }
    }
  }
  if (!dist.has(t)) return null;
  const path: LL[] = [b];
  for (let n: string | undefined = t; n; n = prev.get(n)) path.push(at.get(n)!);
  return path.concat([a]).reverse();
}

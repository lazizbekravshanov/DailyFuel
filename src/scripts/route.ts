// The trip's route along the freight highways, part of the trip module the
// map loads only when a trip is asked for (src/scripts/trip.ts).

import { distMi } from "../components/map/geo.ts";

type LL = [number, number];

/** The fewest nodes a piece of the network needs for a town to step onto it: Hawaii's smallest island has 10. */
const FEW = 10;

interface Graph {
  /** each node's point, and its neighbours and the miles to each, flat: [node, miles, node, miles, ...] */
  pts: LL[];
  adj: number[][];
  /** the size of each node's piece of the network */
  size: Int32Array;
  few: number;
}
const built = new WeakMap<LL[][], Graph>();

/**
 * The lines as a graph, built once for each set of lines: a trip after the
 * first only searches it. The map builds it a step ahead of the search, so
 * neither holds the page up for long. Nodes are numbered and kept in plain
 * arrays, which is quicker to build and leaves less to collect than a key
 * for each point.
 */
export function graph(lines: LL[][]): Graph {
  const had = built.get(lines);
  if (had) return had;
  const id = new Map<number, number>(),
    pts: LL[] = [],
    adj: number[][] = [],
    node = (p: LL) => {
      // one node for each point to four places, which the lines are well inside
      const k = Math.round(p[0] * 1e4) * 1e7 + Math.round(p[1] * 1e4);
      let i = id.get(k);
      if (i === undefined) {
        id.set(k, (i = pts.length));
        pts.push(p);
        adj.push([]);
      }
      return i;
    };
  for (const l of lines)
    for (let i = 1; i < l.length; i++) {
      const p = l[i - 1],
        q = l[i],
        u = node(p),
        v = node(q),
        d = distMi(p[0], p[1], q[0], q[1]);
      adj[u].push(v, d);
      adj[v].push(u, d);
    }
  // a town steps only onto a piece of FEW nodes or more, never a scrap the build couldn't bridge
  const n = pts.length,
    size = new Int32Array(n),
    q = new Int32Array(n);
  let big = 0;
  for (let k = 0; k < n; k++)
    if (!size[k]) {
      let e = 0;
      q[e++] = k;
      size[k] = -1;
      for (let i = 0; i < e; i++) {
        const A = adj[q[i]];
        for (let j = 0; j < A.length; j += 2) if (!size[A[j]]) (size[A[j]] = -1), (q[e++] = A[j]);
      }
      for (let i = 0; i < e; i++) size[q[i]] = e;
      big = Math.max(big, e);
    }
  const g = { pts, adj, size, few: Math.min(FEW, big) };
  built.set(lines, g);
  return g;
}

/**
 * The shortest way from a to b along the freight highways, as [lat, lon]
 * points from a to b, or null when the roads nearest the two don't connect.
 * The lines are the map's freight roads plus the joins that make them one
 * graph (see roadJoins in src/lib/mapdata.ts); each end steps from its town
 * to the nearest point on them that isn't on a scrap of a few points.
 */
export function route(a: LL, b: LL, lines: LL[][]): LL[] | null {
  const { pts, adj, size, few } = graph(lines),
    n = pts.length;
  let s = -1,
    t = -1,
    ds = 1e9,
    dt = 1e9;
  for (let k = 0; k < n; k++) {
    if (size[k] < few) continue;
    const q = pts[k],
      x = distMi(a[0], a[1], q[0], q[1]),
      y = distMi(b[0], b[1], q[0], q[1]);
    if (x < ds) ((ds = x), (s = k));
    if (y < dt) ((dt = y), (t = k));
  }
  if (s < 0) return null;
  // Dijkstra on a binary heap of nodes, their miles alongside
  const dist = new Float64Array(n).fill(Infinity),
    prev = new Int32Array(n).fill(-1),
    hd = [0],
    hn = [s];
  dist[s] = 0;
  while (hn.length) {
    const d = hd[0],
      u = hn[0],
      ld = hd.pop()!,
      lu = hn.pop()!;
    if (hn.length) {
      let i = 0;
      for (let c = 1; c < hn.length; i = c, c = 2 * c + 1) {
        if (c + 1 < hn.length && hd[c + 1] < hd[c]) c++;
        if (hd[c] >= ld) break;
        hd[i] = hd[c];
        hn[i] = hn[c];
      }
      hd[i] = ld;
      hn[i] = lu;
    }
    if (u == t) break;
    if (d > dist[u]) continue;
    const A = adj[u];
    for (let j = 0; j < A.length; j += 2) {
      const v = A[j],
        nd = d + A[j + 1];
      if (nd < dist[v]) {
        dist[v] = nd;
        prev[v] = u;
        let i = hn.length;
        for (let p; i && hd[(p = (i - 1) >> 1)] > nd; i = p) (hd[i] = hd[p]), (hn[i] = hn[p]);
        hd[i] = nd;
        hn[i] = v;
      }
    }
  }
  if (dist[t] == Infinity) return null;
  const path: LL[] = [b];
  for (let k = t; k >= 0; k = prev[k]) path.push(pts[k]);
  return path.concat([a]).reverse();
}

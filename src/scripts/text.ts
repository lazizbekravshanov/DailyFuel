// The two text helpers the map's script and its trip module share.

export const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (ch) => (ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : "&quot;"));

export const fmt = (n: number): string => n.toLocaleString("en-US");

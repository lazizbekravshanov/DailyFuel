// The text helpers the map's script and its trip module share.

export const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (ch) => (ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : "&quot;"));

export const fmt = (n: number): string => n.toLocaleString("en-US");

/** A name that opens its stop on the map: the map's list and the trip's rows. No form holds either, so it is a plain button. */
export const lk = (i: number, n: string): string => `<button class="lk" data-i="${i}">${esc(n)}</button>`;

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CARD_FONT,
  CARD_HEIGHT,
  CARD_INK,
  CARD_WIDTH,
  FONT_FILES,
  cardAlt,
  cardDate,
  cardFor,
  cardKeyFor,
  cardKeys,
  cardMeta,
  cardPath,
  cardSvg,
  escapeXml,
  renderCard,
  type Card,
  type Measure,
} from "./og.ts";
import type { Move } from "./data.ts";
import type { SiteData, StateView } from "./site.ts";

const REGION: Record<string, string> = { R20: "Midwest", R1Y: "Central Atlantic", SCA: "California", R5XCA: "West Coast outside California" };

function move(price: number, prev: number | null): Move {
  if (prev === null) return { price, prev: null, change: null, change_pct: null, direction: null };
  const change = Math.round((price - prev) * 1000) / 1000;
  return { price, prev, change, change_pct: Math.round((change / prev) * 10000) / 100, direction: change > 0 ? "up" : change < 0 ? "down" : "flat" };
}

function state(code: string, name: string, series: string | null, m: Move | null, daily = false): StateView {
  return {
    code,
    name,
    slug: code.toLowerCase(),
    href: `/state/${code.toLowerCase()}/`,
    eia_series: series,
    regionName: series ? REGION[series] : null,
    cadence: daily ? "daily" : "weekly",
    primary: m,
  } as unknown as StateView;
}

function fakeSite(opts: { aaa?: boolean; period?: string; prev?: string } = {}): SiteData {
  const aaa = opts.aaa ?? false;
  const period = opts.period ?? "2026-09-14";
  const prev = opts.prev ?? "2026-09-07";
  const states = [
    state("AK", "Alaska", null, aaa ? move(6.9, 6.85) : null, aaa),
    state("CA", "California", "SCA", move(7.1, 7.0), aaa),
    state("DC", "District of Columbia", "R1Y", move(6.3, 6.2), aaa),
    state("IN", "Indiana", "R20", move(6.25, 5.946), aaa),
    state("OH", "Ohio", "R20", move(6.25, 5.946), aaa),
    state("PA", "Pennsylvania", "R1Y", move(6.3, 6.2), aaa),
    state("OR", "Oregon", "R5XCA", move(6.57, 6.31), aaa),
    state("WA", "Washington", "R5XCA", move(6.57, 6.31), aaa),
  ];
  const us = move(6.285, 5.967);
  return {
    mode: aaa ? "aaa+eia" : "eia_only",
    latest: {
      eia: { period, prev_period: prev, release_date: "2026-09-15", next_release_date: "2026-09-22", us },
      aaa: aaa ? { as_of: "2026-09-17", prev_as_of: "2026-09-16", gap_days: 1, national: move(6.4, 6.39) } : null,
    },
    states,
    byCode: new Map(states.map((s) => [s.code, s])),
    national: aaa
      ? { cadence: "daily", move: move(6.4, 6.39), date: "2026-09-17", prevDate: "2026-09-16" }
      : { cadence: "weekly", move: us, date: period, prevDate: prev },
  } as unknown as SiteData;
}

// A stand in for resvg: every character is 60 units wide at 100px, like a monospace face.
const fakeMeasure: Measure = (s) => ({ left: 0, right: s.length * 60 });

const DASHES = /[‒–—―]| - /;

function cardText(c: Card): string[] {
  return [c.head, c.legend, c.kicker, c.noPrice, c.change ?? "", c.dateLine, c.compareLine ?? "", c.label, cardAlt(c)];
}

/** Every <text> element's fill and words. */
function texts(svg: string): { fill: string; words: string }[] {
  return [...svg.matchAll(/<text [^>]*fill="([^"]+)"[^>]*>([^<]*)<\/text>/g)].map((m) => ({ fill: m[1], words: m[2] }));
}

describe("share card URLs", () => {
  const site = fakeSite();

  it("dates every card with the EIA survey week, and the paper drawing is b", () => {
    expect(cardDate(site)).toBe("2026-09-14");
    expect(cardPath("oh", "2026-09-14")).toBe("/og/oh-2026-09-14-b.png");
  });

  it("uses AAA's day when AAA leads", () => {
    expect(cardDate(fakeSite({ aaa: true }))).toBe("2026-09-17");
  });

  it("draws the U.S. card and one per state", () => {
    expect(cardKeys(site)).toEqual(["us", "ak", "ca", "dc", "in", "oh", "pa", "or", "wa"]);
  });

  it("gives a state page its own card and everything else the U.S. card", () => {
    expect(cardKeyFor("/state/oh/", site)).toBe("oh");
    expect(cardKeyFor("/state/oh", site)).toBe("oh");
    expect(cardKeyFor("/", site)).toBe("us");
    expect(cardKeyFor("/about/", site)).toBe("us");
    expect(cardKeyFor("/404", site)).toBe("us");
    expect(cardKeyFor("/state/zz/", site)).toBe("us");
  });

  it("builds an absolute image URL and alt text for the page head", () => {
    const meta = cardMeta(site, "/state/oh/", "https://dailydiesel.vercel.app/");
    expect(meta.url).toBe("https://dailydiesel.vercel.app/og/oh-2026-09-14-b.png");
    expect(meta.alt).toContain("Ohio");
  });
});

describe("what a card says", () => {
  const site = fakeSite();

  it("prints the price, change, week and region for a state", () => {
    const c = cardFor(site, "oh");
    expect(c.shield).toBe("OH");
    expect(c.head).toBe("Ohio");
    expect(c.legend).toBe("Ohio diesel average");
    expect(c.kicker).toBe("U.S. on-highway diesel · EIA weekly");
    expect(c.price).toBe("$6.250");
    expect(c.direction).toBe("up");
    expect(c.change).toBe("+30.4¢ +5.1%");
    expect(c.dateLine).toBe("Week of Sep 14, 2026");
    expect(c.compareLine).toBe("Since the week of Sep 7");
    expect(c.label).toBe("EIA Midwest average, 2 states");
  });

  it("signs a fall with a real minus and calls a move of exactly nothing flat", () => {
    const down = fakeSite();
    down.byCode.get("OH")!.primary = move(5.946, 6.25);
    const c = cardFor(down, "oh");
    expect(c.direction).toBe("down");
    expect(c.change).toBe("−30.4¢ −4.9%");
    const same = fakeSite();
    same.byCode.get("OH")!.primary = move(6.25, 6.25);
    expect(cardFor(same, "oh").direction).toBe("flat");
    expect(cardFor(same, "oh").change).toBe("0.0¢ 0.0%");
  });

  it("counts DC apart from the states", () => {
    expect(cardFor(site, "dc").label).toBe("EIA Central Atlantic average, 1 state and DC");
    expect(cardFor(site, "pa").label).toBe("EIA Central Atlantic average, 1 state and DC");
  });

  it("says the West Coast outside California in the plate's words", () => {
    expect(cardFor(site, "wa").label).toBe("EIA West Coast average outside California, 2 states");
  });

  it("names California as its own price", () => {
    expect(cardFor(site, "ca").label).toBe("EIA California average");
  });

  it("says so when EIA doesn't survey a state", () => {
    const c = cardFor(site, "ak");
    expect(c.price).toBeNull();
    expect(c.change).toBeNull();
    expect(c.head).toBe("Alaska");
    expect(c.legend).toBe("Diesel in Alaska");
    expect(c.noPrice).toBe("No EIA price");
    // no survey week under "No EIA price", the same line as the page
    expect(c.dateLine).toBe("Not in EIA's weekly survey");
    expect(c.compareLine).toBeNull();
    expect(c.label).toBe("EIA doesn't survey diesel prices in Alaska");
    expect(cardAlt(c)).toBe("Diesel in Alaska: no EIA price. EIA doesn't survey diesel prices in Alaska.");
  });

  it("names the U.S. number the way drivers do", () => {
    const c = cardFor(site, "us");
    expect(c.shield).toBeNull();
    expect(c.head).toBe("U.S. diesel average");
    expect(c.legend).toBe("U.S. diesel average");
    expect(c.change).toBe("+31.8¢ +5.3%");
    expect(c.label).toBe("DOE weekly average, published by EIA");
  });

  it("reads the whole card as one sentence for the alt text", () => {
    expect(cardAlt(cardFor(site, "oh"))).toBe(
      "Ohio diesel average: $6.250 a gallon, up 30.4 cents since the week of Sep 7. Week of Sep 14, 2026. EIA Midwest average, 2 states.",
    );
  });

  it("puts the year on a comparison week from last year", () => {
    const c = cardFor(fakeSite({ period: "2026-01-05", prev: "2025-12-29" }), "oh");
    expect(c.dateLine).toBe("Week of Jan 5, 2026");
    expect(c.compareLine).toBe("Since the week of Dec 29, 2025");
  });

  it("switches to AAA's daily wording in AAA mode", () => {
    const aaa = fakeSite({ aaa: true });
    const c = cardFor(aaa, "oh");
    expect(c.kicker).toBe("U.S. on-highway diesel · AAA daily, EIA weekly");
    expect(c.dateLine).toBe("Price as of Sep 17, 2026");
    expect(c.compareLine).toBe("Since yesterday");
    expect(c.label).toBe("AAA daily average, data by OPIS");
    expect(cardFor(aaa, "us").label).toBe("AAA daily U.S. average, data by OPIS");
    // Alaska has an AAA price even though EIA skips it
    expect(cardFor(aaa, "ak").price).toBe("$6.900");
  });

  it("names a skipped AAA day for states but not for AAA's own national change", () => {
    const aaa = fakeSite({ aaa: true });
    aaa.latest.aaa!.prev_as_of = "2026-09-15";
    aaa.latest.aaa!.gap_days = 2;
    expect(cardFor(aaa, "oh").compareLine).toBe("Since Sep 15");
    expect(cardFor(aaa, "us").compareLine).toBe("Since yesterday");
  });

  it("never uses a dash as punctuation", () => {
    for (const s of [fakeSite(), fakeSite({ aaa: true })]) {
      for (const key of cardKeys(s)) {
        for (const t of cardText(cardFor(s, key))) expect(t).not.toMatch(DASHES);
      }
    }
  });
});

describe("drawing a card", () => {
  const site = fakeSite();

  it("escapes text for XML", () => {
    expect(escapeXml(`A & B <C> "D" 'E'`)).toBe("A &amp; B &lt;C&gt; &quot;D&quot; &apos;E&apos;");
  });

  it("lays out a 1200 by 630 white card with the wordmark, head, price, change, week and source", () => {
    const svg = cardSvg(cardFor(site, "oh"), fakeMeasure);
    expect(svg).toContain(`width="${CARD_WIDTH}" height="${CARD_HEIGHT}"`);
    expect(svg).toContain(`width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${CARD_INK.bg}"`);
    expect(svg).toContain(">DAILYFUEL</text>");
    expect(svg).toContain(">OH</text>");
    expect(svg).toContain(">OHIO</text>");
    expect(svg).toContain(">$6.250</text>");
    expect(svg).toContain(">+30.4¢ +5.1%</text>");
    expect(svg).toContain(">Week of Sep 14, 2026 · since the week of Sep 7</text>");
    expect(svg).toContain(">EIA Midwest average, 2 states</text>");
    expect(svg).toContain(">dailydiesel.vercel.app</text>");
    expect(svg).not.toMatch(/NaN|undefined/);
  });

  it("sets everything in the one monospace face, one weight plus bold", () => {
    const svg = cardSvg(cardFor(site, "oh"), fakeMeasure);
    const all = texts(svg);
    expect(all.length).toBeGreaterThan(6);
    for (const m of svg.matchAll(/<text [^>]*>/g)) {
      expect(m[0]).toContain(`font-family="${CARD_FONT}"`);
      expect(m[0]).toMatch(/font-weight="(400|700)"/);
    }
    expect(svg).not.toContain("Overpass");
  });

  it("colours only the change: red when diesel rose, blue when it fell, gray for no move, and draws no arrow", () => {
    const up = cardSvg(cardFor(site, "oh"), fakeMeasure);
    expect(texts(up).find((t) => t.words === "+30.4¢ +5.1%")?.fill).toBe(CARD_INK.up);
    for (const t of texts(up)) if (t.words !== "+30.4¢ +5.1%") expect([CARD_INK.ink, CARD_INK.ink2]).toContain(t.fill);
    expect(up).not.toContain("<path");
    expect(up).not.toContain("<circle");
    expect(up).not.toMatch(/[▲▼●↑↓]/);
    const down = cardFor(site, "oh");
    down.direction = "down";
    down.change = "−30.4¢ −4.9%";
    expect(texts(cardSvg(down, fakeMeasure)).find((t) => t.words === "−30.4¢ −4.9%")?.fill).toBe(CARD_INK.down);
    const flat = cardFor(site, "oh");
    flat.direction = "flat";
    flat.change = "0.0¢ 0.0%";
    expect(texts(cardSvg(flat, fakeMeasure)).find((t) => t.words === "0.0¢ 0.0%")?.fill).toBe(CARD_INK.ink2);
  });

  it("puts the change after the price on one baseline, inside the card", () => {
    const svg = cardSvg(cardFor(site, "oh"), fakeMeasure);
    const price = /<text x="([\d.]+)" y="([\d.]+)" [^>]*font-size="([\d.]+)"[^>]*>\$6\.250</.exec(svg)!;
    const change = /<text x="([\d.]+)" y="([\d.]+)" [^>]*font-size="([\d.]+)"[^>]*>\+30\.4¢/.exec(svg)!;
    expect(price[2]).toBe(change[2]);
    const priceEnd = Number(price[1]) + (Number(price[3]) * "$6.250".length * 60) / 100;
    expect(Number(change[1])).toBeGreaterThan(priceEnd);
    expect(Number(change[1]) + (Number(change[3]) * "+30.4¢ +5.1%".length * 60) / 100).toBeLessThanOrEqual(1128.5);
  });

  it("rules the card with a double line under the header and a hairline over the source", () => {
    const svg = cardSvg(cardFor(site, "oh"), fakeMeasure);
    expect(svg.match(new RegExp(`height="2" fill="${CARD_INK.ink}"`, "g"))?.length).toBe(2);
    expect(svg).toContain(`height="2" fill="${CARD_INK.hair}"`);
  });

  it("keeps a long name at full size while it fits, and shrinks one that doesn't", () => {
    const dc = cardSvg(cardFor(site, "dc"), fakeMeasure);
    expect(dc).toMatch(/font-size="40" fill="#111111" letter-spacing="1.6">DISTRICT OF COLUMBIA</);
    const long = cardFor(site, "dc");
    long.head = "District of Columbia and the whole Central Atlantic";
    const svg = cardSvg(long, fakeMeasure);
    const name = long.head.toUpperCase();
    const m = new RegExp(`font-size="([\\d.]+)" fill="#111111" letter-spacing="[\\d.]+">${name}<`).exec(svg);
    expect(m).not.toBeNull();
    const size = Number(m![1]);
    expect(size).toBeLessThan(40);
    const box = /<rect x="73" y="[\d.]+" width="([\d.]+)"/.exec(svg)!;
    // box plus gap plus the tracked name stays inside the 1056px content width
    expect(Number(box[1]) + 20 + (size * name.length * 60) / 100 + (name.length - 1) * size * 0.04).toBeLessThanOrEqual(1056.5);
  });

  it("draws a no price card with no change and no coloured ink", () => {
    const svg = cardSvg(cardFor(site, "ak"), fakeMeasure);
    expect(svg).toContain(">No EIA price</text>");
    expect(svg).toContain(">Not in EIA&apos;s weekly survey</text>");
    expect(svg).not.toContain(CARD_INK.up);
    expect(svg).not.toContain(CARD_INK.down);
  });

  it("renders a real PNG with the Red Hat Mono files", async () => {
    for (const f of FONT_FILES) expect(existsSync(f)).toBe(true);
    expect(readFileSync(FONT_FILES[0].replace(/[^/]+$/, "OFL.txt"), "utf8")).toContain("SIL OPEN FONT LICENSE");
    const png = await renderCard(cardFor(site, "oh"));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.readUInt32BE(16)).toBe(CARD_WIDTH);
    expect(png.readUInt32BE(20)).toBe(CARD_HEIGHT);
  });
});

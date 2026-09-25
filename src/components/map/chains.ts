// The chains the map knows, in one place for the page, the legend, the list
// and the inline script: the name as a driver says it, the letter drawn in
// the dot, and the chain's own locator page, which is
// where a popup sends anyone who wants today's price. Names identify
// locations only; there are no logos and DailyFuel is not affiliated with
// or endorsed by any chain.
//
// Every chain's dot is ink with a paper letter: colour on the site is only
// for a price change, so the letter, the legend and the list tell the
// chains apart.

export interface Chain {
  key: string;
  name: string;
  letter: string;
  locator: string;
}

// Locator pages: the chain's own store finder, or its home page where the
// finder's address could not be checked from here.
const PFJ = "https://locations.pilotflyingj.com/";
const TAP = "https://www.ta-petro.com/location/";
const LOVES = "https://www.loves.com/locations";

export const CHAINS: Chain[] = [
  { key: "loves", name: "Love's", letter: "L", locator: LOVES },
  { key: "pilot", name: "Pilot", letter: "P", locator: PFJ },
  { key: "flyingj", name: "Flying J", letter: "J", locator: PFJ },
  { key: "ta", name: "TA", letter: "T", locator: TAP },
  { key: "petro", name: "Petro", letter: "E", locator: TAP },
  { key: "one9", name: "ONE9", letter: "9", locator: PFJ },
  { key: "roadranger", name: "Road Ranger", letter: "R", locator: "https://www.roadrangerusa.com/" },
];

export const CHAIN_BY_KEY: Record<string, Chain> = Object.fromEntries(CHAINS.map((c) => [c.key, c]));

/** The filter keys that are not chains: the weigh station layer and the truck service layer. */
export const WEIGH_KEY = "w";
export const SERVICE_KEY = "v";

/** Truck service points from the fleet file: the name a row prints, and the chain whose locator lists it, if any. */
export const SERVICES: Record<string, { name: string; chain: string | null }> = {
  ta: { name: "TA truck service", chain: "ta" },
  petro: { name: "Petro truck service", chain: "petro" },
  loves_shop: { name: "Love's shop", chain: "loves" },
  speedco: { name: "Speedco", chain: null },
  lubezone: { name: "LubeZone", chain: null },
  profleet: { name: "ProFleet lube", chain: null },
};

/** Where each point's data comes from, by the one letter key a row carries, printed in its popup. */
export const SOURCES: Record<string, string> = {
  o: "OpenStreetMap, ODbL",
  n: "U.S. DOT NTAD 2019, public domain",
  i: "Iowa DOT, CC BY 4.0",
  f: "DailyFuel, CC BY 4.0",
};

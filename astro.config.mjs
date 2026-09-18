// @ts-check
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

/**
 * The day the prices on the site last changed: EIA's release date, or AAA's
 * day when that's newer. Every page shows the newest numbers, so every URL in
 * the sitemap shares it. Undefined if the data can't be read, and the build's
 * own data check reports that.
 */
function dataLastmod() {
  try {
    const dir = process.env.DAILYFUEL_DATA_DIR ?? "data";
    const latest = JSON.parse(readFileSync(resolve(dir, "latest.json"), "utf8"));
    const days = [latest.eia?.release_date ?? latest.eia?.period, latest.aaa?.as_of].filter(Boolean);
    return days.length ? days.sort().at(-1) : undefined;
  } catch {
    return undefined;
  }
}

const lastmod = dataLastmod();

export default defineConfig({
  site: "https://dailydiesel.vercel.app",
  output: "static",
  trailingSlash: "ignore",
  integrations: [
    sitemap({
      // share card images are not pages
      filter: (page) => !page.includes("/og/"),
      serialize(item) {
        return lastmod ? { ...item, lastmod } : item;
      },
    }),
  ],
  build: {
    inlineStylesheets: "always",
  },
  devToolbar: {
    enabled: false,
  },
});

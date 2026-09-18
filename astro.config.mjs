// @ts-check
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import { SITE_URL } from "./src/lib/url.ts";
import sitemap from "@astrojs/sitemap";
import { transformSync } from "esbuild";

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

const SRC = fileURLToPath(new URL("./src/", import.meta.url));

/**
 * The page scripts are plain files imported with ?raw and inlined with
 * set:html, where nothing minifies them. For the build this returns each one
 * minified, so the comments stay in the source files and out of every page.
 * esbuild comes with Astro. The dev server keeps the readable source.
 * @returns {import("vite").Plugin}
 */
function minifyInlineScripts() {
  return {
    name: "dailyfuel:minify-inline-scripts",
    apply: "build",
    enforce: "pre",
    load(id) {
      const [file, query = ""] = id.split("?");
      if (!new URLSearchParams(query).has("raw") || !file.endsWith(".js") || !file.startsWith(SRC)) return null;
      const { code } = transformSync(readFileSync(file, "utf8"), {
        loader: "js",
        minify: true,
        target: "es2017",
        legalComments: "none",
      });
      return `export default ${JSON.stringify(code.trim())};`;
    },
  };
}

export default defineConfig({
  site: SITE_URL,
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
  vite: {
    plugins: [minifyInlineScripts()],
  },
});

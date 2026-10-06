// /map/route.js: the trip route finder (src/scripts/route.ts) as one small ES
// module, which the map imports the first time a trip is asked for, so the
// map's own inline script and its first load don't carry it.
import type { APIRoute } from "astro";
import { buildSync } from "esbuild";
import { resolve } from "node:path";

export const GET: APIRoute = () => {
  const out = buildSync({
    entryPoints: [resolve(process.cwd(), "src/scripts/route.ts")],
    bundle: true,
    minify: true,
    format: "esm",
    target: "es2020",
    legalComments: "none",
    write: false,
  });
  return new Response(out.outputFiles[0].text, {
    headers: { "Content-Type": "text/javascript" },
  });
};

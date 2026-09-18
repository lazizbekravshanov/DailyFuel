import type { APIRoute } from "astro";
import { SITE_URL } from "../lib/url.ts";

// Built from SITE_URL so a domain change needs no edit here.
export const GET: APIRoute = () =>
  new Response(`User-agent: *\nAllow: /\n\nSitemap: ${new URL("/sitemap-index.xml", SITE_URL).href}\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });

// Share card images, drawn once at build time: /og/us-2026-09-14-a.png and one
// per state. The date in the name changes every week, so chat apps that cache
// previews by URL pick up the new price with the new link.
import type { APIRoute, GetStaticPaths } from "astro";
import { getSite } from "../../lib/site.ts";
import { cardDate, cardFor, cardKeys, cardName, renderCard } from "../../lib/og.ts";

export const getStaticPaths = (() => {
  const site = getSite();
  const date = cardDate(site);
  return cardKeys(site).map((key) => ({ params: { card: cardName(key, date) }, props: { key } }));
}) satisfies GetStaticPaths;

export const GET: APIRoute = async ({ props }) => {
  const png = await renderCard(cardFor(getSite(), props.key as string));
  return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png" } });
};

// Share card images, drawn once at build time: /og/us-2026-09-14-c.png and one
// per state. The date in the name changes every week, so chat apps that cache
// previews by URL pick up the new price with the new link. Each card is also
// written under a name that never changes, /og/us.png, which vercel.json
// serves for a dated name that a later build no longer has, so an old post
// keeps a picture. A card drawn under both names is drawn once.
import type { APIRoute, GetStaticPaths } from "astro";
import { getSite } from "../../lib/site.ts";
import { cardDate, cardFor, cardKeys, cardName, renderCard, stableCards } from "../../lib/og.ts";

export const getStaticPaths = (() => {
  const site = getSite();
  const date = cardDate(site);
  return [
    ...cardKeys(site).map((key) => ({ params: { card: cardName(key, date) }, props: { key } })),
    ...stableCards(site).map(({ name, key }) => ({ params: { card: name }, props: { key } })),
  ];
}) satisfies GetStaticPaths;

const drawn = new Map<string, Promise<Buffer>>();

export const GET: APIRoute = async ({ props }) => {
  const key = props.key as string;
  if (!drawn.has(key)) drawn.set(key, renderCard(cardFor(getSite(), key)));
  const png = await drawn.get(key)!;
  return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png" } });
};

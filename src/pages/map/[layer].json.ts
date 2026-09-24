// The map page's base layers, written once at build time from data/map:
// /map/states.json (the outlines, also the route strip's point in polygon),
// /map/roads.json (the freight network, interstates apart) and
// /map/places.json (the route strip's A and B list). Each is written only
// when its source file is there, and the page's script copes without it.
// Compact on purpose: quantized, delta encoded integer arrays, see
// statesPayload, roadsPayload and placesPayload in src/lib/mapdata.ts.
import type { APIRoute, GetStaticPaths } from "astro";
import { loadMapData, placesPayload, roadsPayload, statesPayload } from "../../lib/mapdata.ts";

export const getStaticPaths = (() => {
  const d = loadMapData();
  return [
    d.present.states && { params: { layer: "states" } },
    d.present.roads && { params: { layer: "roads" } },
    d.present.places && { params: { layer: "places" } },
  ].filter(Boolean) as { params: { layer: string } }[];
}) satisfies GetStaticPaths;

export const GET: APIRoute = ({ params }) => {
  const d = loadMapData();
  const body =
    params.layer === "states" ? statesPayload(d.states) : params.layer === "roads" ? roadsPayload(d.roads) : placesPayload(d.places);
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
};

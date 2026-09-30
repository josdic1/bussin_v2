import type { StyleSpecification } from "maplibre-gl";

/**
 * Light basemap that sits quietly under route colors. The OpenStreetMap
 * volunteer tile server does not allow app traffic, so the default is CARTO's
 * Positron raster tiles. Set VITE_MAP_STYLE_URL to use any MapLibre style
 * (for example a Mapbox or MapTiler style with your own public key), or to
 * "schematic" for a tile-free map drawn from stop coordinates.
 */
const configured = import.meta.env.VITE_MAP_STYLE_URL as string | undefined;

const positron: StyleSpecification = {
  version: 8,
  sources: {
    base: {
      type: "raster",
      tiles: ["a", "b", "c", "d"].map((sub) => `https://${sub}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png`),
      tileSize: 256,
      maxzoom: 19,
      attribution: "&copy; OpenStreetMap contributors &copy; CARTO"
    }
  },
  layers: [{ id: "base", type: "raster", source: "base" }]
};

export const schematicOnly = configured === "schematic";
/** Always a real street map; the route editor needs streets even in schematic mode. */
export const mapStyle: string | StyleSpecification = configured && !schematicOnly ? configured : positron;

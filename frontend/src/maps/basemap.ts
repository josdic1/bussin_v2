import type { StyleSpecification } from "maplibre-gl";

/**
 * Light basemap that sits quietly under route colors. Default is OpenFreeMap's
 * Positron style: free, no API key, no request limits, and it allows app use.
 * Set VITE_MAP_STYLE_URL to use any other MapLibre style (for example a Mapbox
 * or MapTiler style with your own public key), or to "schematic" for a
 * tile-free Dispatch map drawn from stop coordinates.
 */
const configured = import.meta.env.VITE_MAP_STYLE_URL as string | undefined;

const OPENFREEMAP_POSITRON = "https://tiles.openfreemap.org/styles/positron";

export const schematicOnly = configured === "schematic";
/** Always a real street map; the route editor needs streets even in schematic mode. */
export const mapStyle: string | StyleSpecification =
  configured && !schematicOnly ? configured : OPENFREEMAP_POSITRON;

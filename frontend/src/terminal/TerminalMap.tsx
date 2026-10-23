import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import { LngLatBounds, Map as MapLibreMap, setWorkerUrl, type GeoJSONSource, type StyleSpecification } from "maplibre-gl";
import type { StaffTrip } from "@bussin/shared";
import { mapStyle } from "../maps/basemap";

setWorkerUrl(workerUrl);

type Point = { latitude: number; longitude: number };

/* Cab palette: dark, low glare, streets readable at arm's length. */
const C = {
  ground: "#0f1714", land: "#131d19", park: "#13211a", water: "#0b1a24", building: "#18221e",
  minor: "#26332e", major: "#34463e", casing: "#0f1714", border: "#2a3a33", label: "#8aa398", halo: "#0f1714"
};

/** Recolors a light style into the cab palette. Unknown layers fall back to safe dark values. */
function darken(style: StyleSpecification): StyleSpecification {
  const layers = style.layers.map((layer) => {
    const id = layer.id.toLowerCase();
    const l = { ...layer, paint: { ...(layer as { paint?: Record<string, unknown> }).paint } } as typeof layer & { paint: Record<string, unknown> };
    if (l.type === "background") l.paint["background-color"] = C.ground;
    else if (l.type === "fill") {
      delete l.paint["fill-pattern"];
      l.paint["fill-outline-color"] = "rgba(0,0,0,0)";
      l.paint["fill-color"] = id.includes("water") ? C.water : id.includes("building") ? C.building
        : id.includes("park") || id.includes("wood") || id.includes("grass") ? C.park : C.land;
    } else if (l.type === "line") {
      delete l.paint["line-pattern"];
      l.paint["line-color"] = id.includes("water") ? C.water : id.includes("boundary") || id.includes("admin") ? C.border
        : id.includes("casing") ? C.casing
        : /motorway|trunk|primary|secondary|major/.test(id) ? C.major : C.minor;
    } else if (l.type === "symbol") {
      l.paint["text-color"] = C.label;
      l.paint["text-halo-color"] = C.halo;
      l.paint["icon-opacity"] = 0.5;
    }
    return l;
  });
  return { ...style, layers };
}

/** Plain dark ground when the street map can't load; the route and bus still draw. */
const BARE: StyleSpecification = { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": C.ground } }] };

async function loadStyle(): Promise<StyleSpecification> {
  try {
    if (typeof mapStyle !== "string") return darken(mapStyle);
    const response = await fetch(mapStyle);
    if (!response.ok) return BARE;
    return darken(await response.json() as StyleSpecification);
  } catch {
    return BARE;
  }
}

function geo(trip: StaffTrip | null, nextStopId: string | null, bus: Point | null) {
  const stops = trip?.stops ?? [];
  const nextIndex = stops.findIndex((stop) => stop.id === nextStopId);
  const at = (p: Point) => [p.longitude, p.latitude];
  // Done: stops already served, ending at the bus. Ahead: from the bus to the next stop and on.
  const served = nextIndex < 0 ? [] : stops.slice(0, nextIndex);
  const remaining = nextIndex < 0 ? stops : stops.slice(nextIndex);
  const done = [...served.map(at), ...(bus && served.length ? [at(bus)] : [])];
  const ahead = [...(bus && nextIndex >= 0 ? [at(bus)] : []), ...remaining.map(at)];
  return {
    route: { type: "FeatureCollection" as const, features: [
      ...(ahead.length > 1 ? [{ type: "Feature" as const, properties: { part: "ahead" }, geometry: { type: "LineString" as const, coordinates: ahead } }] : []),
      ...(done.length > 1 ? [{ type: "Feature" as const, properties: { part: "done" }, geometry: { type: "LineString" as const, coordinates: done } }] : [])
    ] },
    stops: { type: "FeatureCollection" as const, features: stops.map((stop, index) => ({
      type: "Feature" as const,
      properties: { state: stop.id === nextStopId ? "next" : nextIndex >= 0 && index < nextIndex ? "done" : "later", n: String(stop.position) },
      geometry: { type: "Point" as const, coordinates: at(stop) }
    })) },
    bus: { type: "FeatureCollection" as const, features: bus
      ? [{ type: "Feature" as const, properties: {}, geometry: { type: "Point" as const, coordinates: at(bus) } }] : [] }
  };
}

/**
 * Cab map: the bus, the route between stops and the next stop. Not draggable, so a bump can't
 * scroll it away; the camera keeps the bus and the next stop in view.
 * Lines between stops are straight; road-following route lines are a later step.
 */
export function TerminalMap({ trip, nextStopId, bus }: { trip: StaffTrip | null; nextStopId: string | null; bus: Point | null }) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadStyle().then((style) => {
      if (cancelled || !container.current) return;
      try {
        const instance = new MapLibreMap({
          container: container.current, style, center: [-74.26, 40.745], zoom: 13,
          interactive: false, attributionControl: { compact: true }, fadeDuration: 0
        });
        map.current = instance;
        instance.on("error", () => undefined);
        instance.on("load", () => {
          const empty = { type: "FeatureCollection" as const, features: [] };
          instance.addSource("route", { type: "geojson", data: empty });
          instance.addSource("stops", { type: "geojson", data: empty });
          instance.addSource("bus", { type: "geojson", data: empty });
          instance.addLayer({ id: "route-done-under", type: "line", source: "route", filter: ["==", ["get", "part"], "done"],
            layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#0f1714", "line-width": 9 } });
          instance.addLayer({ id: "route-ahead", type: "line", source: "route", filter: ["==", ["get", "part"], "ahead"],
            layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#e8f5ee", "line-width": 4, "line-dasharray": [0.5, 2], "line-opacity": 0.7 } });
          instance.addLayer({ id: "route-done", type: "line", source: "route", filter: ["==", ["get", "part"], "done"],
            layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#2ec27a", "line-width": 5 } });
          instance.addLayer({ id: "stops", type: "circle", source: "stops", paint: {
            "circle-radius": ["match", ["get", "state"], "next", 12, 8],
            "circle-color": ["match", ["get", "state"], "next", "#ffd257", "done", "#2f4a3e", "#58776a"],
            "circle-stroke-color": "#0f1714", "circle-stroke-width": 3 } });
          instance.addLayer({ id: "bus-halo", type: "circle", source: "bus", paint: { "circle-radius": 22, "circle-color": "#2ec27a", "circle-opacity": 0.22 } });
          instance.addLayer({ id: "bus", type: "circle", source: "bus", paint: {
            "circle-radius": 11, "circle-color": "#3ee08a", "circle-stroke-color": "#0f1714", "circle-stroke-width": 3 } });
          setReady(true);
        });
      } catch {
        setFailed(true);
      }
    });
    return () => { cancelled = true; map.current?.remove(); map.current = null; };
  }, []);

  // Data and camera follow the trip and the latest fix.
  const lastFrame = useRef("");
  useEffect(() => {
    const instance = map.current;
    if (!ready || !instance) return;
    const data = geo(trip, nextStopId, bus);
    (instance.getSource("route") as GeoJSONSource).setData(data.route);
    (instance.getSource("stops") as GeoJSONSource).setData(data.stops);
    (instance.getSource("bus") as GeoJSONSource).setData(data.bus);

    const next = trip?.stops.find((stop) => stop.id === nextStopId) ?? null;
    const points: Point[] = [bus, next].filter((p): p is Point => !!p);
    if (!points.length && trip?.stops.length) points.push(...trip.stops);
    if (!points.length) return;
    // Only move the camera when something meaningful changed, so the map isn't constantly animating.
    const frame = points.map((p) => `${p.latitude.toFixed(4)},${p.longitude.toFixed(4)}`).join("|");
    if (frame === lastFrame.current) return;
    lastFrame.current = frame;
    if (points.length === 1) {
      instance.easeTo({ center: [points[0].longitude, points[0].latitude], zoom: 16, duration: 900 });
    } else {
      const bounds = new LngLatBounds();
      points.forEach((p) => bounds.extend([p.longitude, p.latitude]));
      instance.fitBounds(bounds, { padding: 90, maxZoom: 16.5, duration: 900 });
    }
  }, [ready, trip, nextStopId, bus?.latitude, bus?.longitude]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div className="term-map">
    <div ref={container} className="term-map-canvas" />
    {failed && <p className="term-map-note">Map unavailable on this device. Trip controls still work.</p>}
  </div>;
}

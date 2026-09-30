import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  LngLatBounds,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  setWorkerUrl,
  type GeoJSONSource
} from "maplibre-gl";
import { routeGeometriesResponseSchema, type BoardTrip } from "@bussin/shared";
import { getJson } from "../ops/api";
import { busNumber, gpsFresh } from "../ops/fleetModel";
import { mapStyle, schematicOnly } from "../maps/basemap";

setWorkerUrl(workerUrl);

export type MapProps = {
  trips: BoardTrip[];
  colorForBus: (busId: string) => string;
  selectedTripId: string | null;
  onSelect: (tripId: string) => void;
  now: number;
};

type LngLat = [number, number];

function isDone(trip: BoardTrip, index: number) {
  const stop = trip.stops[index];
  return !!(stop.departedAt || (index === trip.stops.length - 1 && stop.arrivedAt));
}

/** Where to draw the bus: its last GPS fix, when the trip is running. */
function busPoint(trip: BoardTrip): LngLat | null {
  return trip.status === "active" && trip.location
    ? [trip.location.longitude, trip.location.latitude] : null;
}

/**
 * Stored road paths per route, fetched once per route and shared by every map
 * on the page. Routes without a stored path fall back to straight stop lines.
 */
const geometryCache = new Map<string, LngLat[] | null>();
function useRouteGeometries(routeIds: string[]) {
  const [version, setVersion] = useState(0);
  const key = [...new Set(routeIds)].sort().join(",");
  useEffect(() => {
    const missing = key.split(",").filter((id) => id && !geometryCache.has(id));
    if (!missing.length) return;
    const controller = new AbortController();
    missing.forEach((id) => geometryCache.set(id, null));
    getJson(`/api/dispatch/route-geometries?ids=${missing.join(",")}`, routeGeometriesResponseSchema, controller.signal)
      .then((data) => {
        for (const item of data.geometries) geometryCache.set(item.routeId, item.coordinates.map((point) => [point[0], point[1]] as LngLat));
        setVersion((value) => value + 1);
      })
      .catch(() => { if (!controller.signal.aborted) missing.forEach((id) => geometryCache.delete(id)); });
    return () => controller.abort();
  }, [key]);
  return version;
}

function linePath(trip: BoardTrip): LngLat[] {
  return geometryCache.get(trip.routeId) ?? trip.stops.map((stop) => [stop.longitude, stop.latitude]);
}

export function DispatchMap(props: MapProps) {
  const version = useRouteGeometries(props.trips.map((trip) => trip.routeId));
  return schematicOnly ? <SchematicMap {...props} version={version} /> : <LiveMap {...props} version={version} />;
}

type Live = { marker: Marker; element: HTMLButtonElement; from: LngLat; to: LngLat; start: number };

function LiveMap({ trips, colorForBus, selectedTripId, onSelect, now, version }: MapProps & { version: number }) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const buses = useRef(new Map<string, Live>());
  const lastBoundsKey = useRef("");
  const select = useRef(onSelect);
  const frame = useRef(0);
  const [ready, setReady] = useState(false);
  select.current = onSelect;

  useEffect(() => {
    if (!container.current) return;
    const instance = new MapLibreMap({ container: container.current, style: mapStyle, center: [-74.265, 40.752], zoom: 12, attributionControl: { compact: true } });
    instance.addControl(new NavigationControl({ showCompass: false }), "top-right");
    instance.on("load", () => {
      instance.addSource("routes", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      instance.addSource("stops", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      const line = (id: string, planned: boolean) => instance.addLayer({
        id, type: "line", source: "routes", filter: ["==", ["get", "planned"], planned],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["get", "color"], "line-width": ["get", "width"], "line-opacity": ["get", "opacity"],
          ...(planned ? { "line-dasharray": [0.4, 2.4] } : {})
        }
      });
      line("routes-running", false);
      line("routes-planned", true);
      instance.addLayer({
        id: "stops", type: "circle", source: "stops",
        paint: {
          "circle-radius": ["get", "radius"],
          "circle-color": ["case", ["get", "done"], ["get", "color"], "#ffffff"],
          "circle-stroke-color": ["get", "color"],
          "circle-stroke-width": 3,
          "circle-opacity": ["get", "opacity"],
          "circle-stroke-opacity": ["get", "opacity"]
        }
      });
      for (const layer of ["routes-running", "routes-planned", "stops"]) {
        instance.on("click", layer, (event) => {
          const id = event.features?.[0]?.properties?.tripId;
          if (typeof id === "string") select.current(id);
        });
        instance.on("mouseenter", layer, () => { instance.getCanvas().style.cursor = "pointer"; });
        instance.on("mouseleave", layer, () => { instance.getCanvas().style.cursor = ""; });
      }
      setReady(true);
    });
    map.current = instance;
    const live = buses.current;
    return () => {
      cancelAnimationFrame(frame.current);
      live.forEach((bus) => bus.marker.remove());
      live.clear();
      setReady(false);
      map.current = null;
      instance.remove();
    };
  }, []);

  // Lines and stops: one data update per change, no DOM rebuilds.
  useEffect(() => {
    const instance = map.current;
    if (!ready || !instance) return;
    const dim = (trip: BoardTrip) => !!selectedTripId && trip.id !== selectedTripId;
    (instance.getSource("routes") as GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: trips.filter((trip) => trip.stops.length > 1).map((trip) => ({
        type: "Feature",
        properties: {
          tripId: trip.id, color: colorForBus(trip.busId), planned: trip.status === "planned",
          width: trip.id === selectedTripId ? 7 : 4.5, opacity: dim(trip) ? 0.3 : 0.9
        },
        geometry: { type: "LineString", coordinates: linePath(trip) }
      }))
    });
    (instance.getSource("stops") as GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: trips.flatMap((trip) => trip.stops.map((stop, index) => ({
        type: "Feature" as const,
        properties: {
          tripId: trip.id, color: colorForBus(trip.busId), done: isDone(trip, index),
          radius: trip.id === selectedTripId ? 6 : 4.5, opacity: dim(trip) ? 0.35 : 1
        },
        geometry: { type: "Point" as const, coordinates: [stop.longitude, stop.latitude] }
      })))
    });

    const key = trips.map((trip) => trip.id).join("|");
    if (key && key !== lastBoundsKey.current) {
      const bounds = new LngLatBounds();
      for (const trip of trips) {
        linePath(trip).forEach((point) => bounds.extend(point));
        const bus = busPoint(trip);
        if (bus) bounds.extend(bus);
      }
      if (!bounds.isEmpty()) {
        instance.fitBounds(bounds, { padding: 50, maxZoom: 15, duration: 0 });
        lastBoundsKey.current = key;
      }
    }
  }, [trips, colorForBus, selectedTripId, ready, version]);

  // Bus markers persist and glide to each new fix instead of jumping.
  useEffect(() => {
    const instance = map.current;
    if (!ready || !instance) return;
    const live = buses.current;
    const seen = new Set<string>();
    const startAt = performance.now();
    for (const trip of trips) {
      const point = busPoint(trip);
      if (!point) continue;
      seen.add(trip.id);
      let bus = live.get(trip.id);
      if (!bus) {
        const element = document.createElement("button");
        element.type = "button";
        element.addEventListener("click", () => select.current(trip.id));
        bus = { marker: new Marker({ element }).setLngLat(point).addTo(instance), element, from: point, to: point, start: startAt };
        live.set(trip.id, bus);
      } else if (bus.to[0] !== point[0] || bus.to[1] !== point[1]) {
        const at = bus.marker.getLngLat();
        bus.from = [at.lng, at.lat];
        bus.to = point;
        bus.start = startAt;
      }
      const dim = !!selectedTripId && trip.id !== selectedTripId;
      bus.element.className = `map-bus${gpsFresh(trip, now) ? "" : " stale"}${dim ? " dim" : ""}`;
      bus.element.style.setProperty("--c", colorForBus(trip.busId));
      bus.element.textContent = `Bus ${busNumber(trip.busLabel)}`;
      bus.element.setAttribute("aria-label", `${trip.busLabel} location. Select trip.`);
      bus.marker.getElement().style.zIndex = dim ? "1" : "2";
    }
    for (const [id, bus] of live) {
      if (!seen.has(id)) { bus.marker.remove(); live.delete(id); }
    }
    cancelAnimationFrame(frame.current);
    const step = (time: number) => {
      let moving = false;
      for (const bus of live.values()) {
        const t = Math.min(1, (time - bus.start) / 900);
        const eased = 1 - (1 - t) ** 3;
        bus.marker.setLngLat([bus.from[0] + (bus.to[0] - bus.from[0]) * eased, bus.from[1] + (bus.to[1] - bus.from[1]) * eased]);
        if (t < 1) moving = true;
      }
      if (moving) frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
  }, [trips, colorForBus, selectedTripId, ready, now]);

  return <div className="mapfill map-live" ref={container} aria-label="Routes, stops and buses" />;
}

/**
 * Tile-free map: routes drawn from road paths or stop coordinates on a plain
 * canvas. Used when VITE_MAP_STYLE_URL=schematic.
 */
function SchematicMap({ trips, colorForBus, selectedTripId, onSelect, now, version }: MapProps & { version: number }) {
  const layout = useMemo(() => {
    const points = trips.flatMap((trip) => [...linePath(trip), ...(busPoint(trip) ? [busPoint(trip)!] : [])]);
    if (!points.length) return null;
    const lngs = points.map((point) => point[0]);
    const lats = points.map((point) => point[1]);
    const [minX, maxX, minY, maxY] = [Math.min(...lngs), Math.max(...lngs), Math.min(...lats), Math.max(...lats)];
    const scaleX = Math.cos((minY + maxY) / 2 * Math.PI / 180);
    const width = Math.max((maxX - minX) * scaleX, 0.002);
    const height = Math.max(maxY - minY, 0.002);
    const k = Math.min(880 / width, 520 / height);
    const offsetX = (1000 - width * k) / 2;
    const offsetY = (640 - height * k) / 2;
    return (point: LngLat) => [offsetX + (point[0] - minX) * scaleX * k, 640 - (offsetY + (point[1] - minY) * k)] as const;
    // version re-runs the layout once road paths arrive
  }, [trips, version]);

  return <div className="mapfill">
    <svg className="map-svg" viewBox="0 0 1000 640" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Routes, stops and buses">
      <rect width="1000" height="640" fill="#eef1ea" />
      {layout && trips.map((trip) => {
        const color = colorForBus(trip.busId);
        const selected = trip.id === selectedTripId;
        const path = linePath(trip).map(layout);
        const stops = trip.stops.map((stop) => layout([stop.longitude, stop.latitude]));
        const bus = busPoint(trip);
        const busXY = bus ? layout(bus) : null;
        return <g key={trip.id} opacity={selectedTripId && !selected ? 0.3 : 1} style={{ cursor: "pointer" }} onClick={() => onSelect(trip.id)}>
          <title>{`${trip.busLabel} · ${trip.routeName}`}</title>
          <polyline points={path.map((point) => point.join(",")).join(" ")} fill="none" stroke={color}
            strokeWidth={selected ? 8 : 5} strokeLinecap="round" strokeLinejoin="round"
            strokeDasharray={trip.status === "planned" ? "2 12" : undefined} />
          {stops.map((point, index) => <circle key={trip.stops[index].id} cx={point[0]} cy={point[1]} r={selected ? 8 : 6}
            fill={isDone(trip, index) ? color : "#fff"} stroke={color} strokeWidth="3" />)}
          {busXY && <g transform={`translate(${busXY[0].toFixed(1)},${busXY[1].toFixed(1)})`}>
            {gpsFresh(trip, now)
              ? <circle r="26" fill={color} opacity=".18" />
              : <circle r="27" fill="none" stroke="#ad4138" strokeWidth="3" strokeDasharray="5 5" />}
            <rect x="-24" y="-15" width="48" height="30" rx="9" fill="#17211b" stroke="#fff" strokeWidth="3" />
            <text y="5" textAnchor="middle" fontSize="13" fontWeight="800" fill="#fff">{`Bus ${busNumber(trip.busLabel)}`}</text>
          </g>}
        </g>;
      })}
    </svg>
  </div>;
}

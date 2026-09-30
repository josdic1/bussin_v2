import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  LngLatBounds,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  setWorkerUrl,
  type GeoJSONSource,
  type StyleSpecification
} from "maplibre-gl";
import type { BoardTrip } from "@bussin/shared";
import { busNumber, gpsFresh } from "../ops/fleetModel";

setWorkerUrl(workerUrl);

const osmStyle: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors"
    }
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }]
};

const style = import.meta.env.VITE_MAP_STYLE_URL || osmStyle;

export type MapProps = {
  trips: BoardTrip[];
  colorForBus: (busId: string) => string;
  selectedTripId: string | null;
  onSelect: (tripId: string) => void;
  now: number;
};

function isDone(trip: BoardTrip, index: number) {
  const stop = trip.stops[index];
  return !!(stop.departedAt || (index === trip.stops.length - 1 && stop.arrivedAt));
}

/** Where to draw the bus: its last GPS fix, when the trip is running. */
function busPoint(trip: BoardTrip) {
  return trip.status === "active" && trip.location
    ? { lng: trip.location.longitude, lat: trip.location.latitude } : null;
}

export function DispatchMap(props: MapProps) {
  return style ? <LiveMap {...props} /> : <SchematicMap {...props} />;
}

function LiveMap({ trips, colorForBus, selectedTripId, onSelect, now }: MapProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const markers = useRef<Marker[]>([]);
  const lastBoundsKey = useRef("");
  const select = useRef(onSelect);
  const [ready, setReady] = useState(false);
  select.current = onSelect;

  useEffect(() => {
    if (!container.current || !style) return;
    const instance = new MapLibreMap({ container: container.current, style, center: [-74.265, 40.752], zoom: 13 });
    instance.addControl(new NavigationControl({ showCompass: false }), "top-right");
    instance.on("load", () => {
      instance.addSource("routes", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      instance.addLayer({
        id: "routes-running", type: "line", source: "routes", filter: ["!=", ["get", "planned"], true],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ["get", "color"], "line-width": ["get", "width"], "line-opacity": ["get", "opacity"] }
      });
      instance.addLayer({
        id: "routes-planned", type: "line", source: "routes", filter: ["==", ["get", "planned"], true],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ["get", "color"], "line-width": ["get", "width"], "line-opacity": ["get", "opacity"], "line-dasharray": [0.4, 2.4] }
      });
      for (const layer of ["routes-running", "routes-planned"]) {
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
    return () => { setReady(false); map.current = null; instance.remove(); };
  }, []);

  useEffect(() => {
    const instance = map.current;
    if (!ready || !instance) return;
    const source = instance.getSource("routes") as GeoJSONSource | undefined;
    source?.setData({
      type: "FeatureCollection",
      features: trips.filter((trip) => trip.stops.length > 1).map((trip) => ({
        type: "Feature",
        properties: {
          tripId: trip.id,
          color: colorForBus(trip.busId),
          planned: trip.status === "planned",
          width: trip.id === selectedTripId ? 8 : 5,
          opacity: selectedTripId && trip.id !== selectedTripId ? 0.28 : 0.85
        },
        geometry: { type: "LineString", coordinates: trip.stops.map((stop) => [stop.longitude, stop.latitude]) }
      }))
    });

    markers.current.forEach((marker) => marker.remove());
    markers.current = [];
    const bounds = new LngLatBounds();
    for (const trip of trips) {
      const color = colorForBus(trip.busId);
      const dim = !!selectedTripId && trip.id !== selectedTripId;
      trip.stops.forEach((stop, index) => {
        bounds.extend([stop.longitude, stop.latitude]);
        const element = document.createElement("button");
        element.type = "button";
        element.className = `map-stop${isDone(trip, index) ? " done" : ""}${dim ? " dim" : ""}${trip.id === selectedTripId ? " sel" : ""}`;
        element.style.setProperty("--c", color);
        element.title = `${trip.busLabel} · ${stop.position}. ${stop.label}`;
        element.setAttribute("aria-label", `${trip.busLabel}, stop ${stop.position}: ${stop.label}. Select trip.`);
        element.addEventListener("click", () => select.current(trip.id));
        markers.current.push(new Marker({ element }).setLngLat([stop.longitude, stop.latitude]).addTo(instance));
      });
      const point = busPoint(trip);
      if (point) {
        bounds.extend([point.lng, point.lat]);
        const element = document.createElement("button");
        element.type = "button";
        element.className = `map-bus${gpsFresh(trip, now) ? "" : " stale"}${dim ? " dim" : ""}`;
        element.style.setProperty("--c", color);
        element.textContent = busNumber(trip.busLabel);
        element.setAttribute("aria-label", `${trip.busLabel} location. Select trip.`);
        element.addEventListener("click", () => select.current(trip.id));
        markers.current.push(new Marker({ element }).setLngLat([point.lng, point.lat]).addTo(instance));
      }
    }
    const key = trips.map((trip) => trip.id).join("|");
    if (!bounds.isEmpty() && key !== lastBoundsKey.current) {
      instance.fitBounds(bounds, { padding: 50, maxZoom: 15, duration: 0 });
      lastBoundsKey.current = key;
    }
  }, [trips, colorForBus, selectedTripId, ready, now]);

  useEffect(() => () => { markers.current.forEach((marker) => marker.remove()); }, []);

  return <div className="mapfill map-live" ref={container} aria-label="Routes, stops and buses" />;
}

/**
 * Tile-free map: routes drawn from real stop coordinates on a plain canvas.
 * Used when no map style is configured, so Dispatch never loses its map.
 */
function SchematicMap({ trips, colorForBus, selectedTripId, onSelect, now }: MapProps) {
  const layout = useMemo(() => {
    const points = trips.flatMap((trip) => [
      ...trip.stops.map((stop) => [stop.longitude, stop.latitude] as const),
      ...(busPoint(trip) ? [[busPoint(trip)!.lng, busPoint(trip)!.lat] as const] : [])
    ]);
    if (!points.length) return null;
    const lngs = points.map((point) => point[0]);
    const lats = points.map((point) => point[1]);
    const [minX, maxX, minY, maxY] = [Math.min(...lngs), Math.max(...lngs), Math.min(...lats), Math.max(...lats)];
    const lat0 = (minY + maxY) / 2;
    const scaleX = Math.cos(lat0 * Math.PI / 180);
    const width = Math.max((maxX - minX) * scaleX, 0.002);
    const height = Math.max(maxY - minY, 0.002);
    const pad = 60;
    const w = 1000;
    const h = 640;
    const k = Math.min((w - pad * 2) / width, (h - pad * 2) / height);
    const offsetX = (w - width * k) / 2;
    const offsetY = (h - height * k) / 2;
    return (lng: number, lat: number) => [offsetX + (lng - minX) * scaleX * k, h - (offsetY + (lat - minY) * k)] as const;
  }, [trips]);

  return <div className="mapfill">
    <svg className="map-svg" viewBox="0 0 1000 640" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Routes, stops and buses">
      <rect width="1000" height="640" fill="#eef1ea" />
      {[110, 250, 390, 530].map((y) => <line key={`h${y}`} x1="0" y1={y} x2="1000" y2={y + 10} stroke="#fff" strokeWidth="9" />)}
      {[140, 390, 620, 870].map((x) => <line key={`v${x}`} x1={x} y1="0" x2={x + 12} y2="640" stroke="#fff" strokeWidth="9" />)}
      {layout && trips.map((trip) => {
        const color = colorForBus(trip.busId);
        const selected = trip.id === selectedTripId;
        const dim = !!selectedTripId && !selected;
        const path = trip.stops.map((stop) => layout(stop.longitude, stop.latitude));
        const bus = busPoint(trip);
        const busXY = bus ? layout(bus.lng, bus.lat) : null;
        const fresh = gpsFresh(trip, now);
        return <g key={trip.id} opacity={dim ? 0.28 : 1} style={{ cursor: "pointer" }} onClick={() => onSelect(trip.id)}>
          <title>{`${trip.busLabel} · ${trip.routeName}`}</title>
          <polyline points={path.map((point) => point.join(",")).join(" ")} fill="none" stroke={color}
            strokeWidth={selected ? 9 : 5} strokeLinecap="round" strokeLinejoin="round" opacity={0.85}
            strokeDasharray={trip.status === "planned" ? "2 12" : undefined} />
          {path.map((point, index) => <circle key={trip.stops[index].id} cx={point[0]} cy={point[1]} r={selected ? 8 : 6}
            fill={isDone(trip, index) ? color : "#fff"} stroke={color} strokeWidth="3" />)}
          {busXY && <g transform={`translate(${busXY[0].toFixed(1)},${busXY[1].toFixed(1)})`}>
            {fresh
              ? <circle r="24" fill={color} opacity=".18"><animate attributeName="r" values="18;30;18" dur="2.4s" repeatCount="indefinite" /></circle>
              : <circle r="26" fill="none" stroke="#9a3f35" strokeWidth="3" strokeDasharray="5 5" />}
            <circle r="17" fill={color} stroke="#fff" strokeWidth="4" />
            <text y="5" textAnchor="middle" fontSize="15" fontWeight="800" fill="#fff" fontFamily="Arial">{busNumber(trip.busLabel)}</text>
          </g>}
        </g>;
      })}
    </svg>
  </div>;
}

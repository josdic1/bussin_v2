import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import {
  LngLatBounds,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  Popup,
  setWorkerUrl,
  type StyleSpecification
} from "maplibre-gl";
import type { BoardTrip } from "@bussin/shared";

setWorkerUrl(workerUrl);

const localStyle: StyleSpecification = {
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

const style = import.meta.env.VITE_MAP_STYLE_URL ||
  (import.meta.env.DEV ? localStyle : null);

export function DispatchMap({
  trips, colorForBus, onSelect, now
}: {
  trips: BoardTrip[];
  colorForBus: (busId: string) => string;
  onSelect: (tripId: string) => void;
  now: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const markers = useRef<Marker[]>([]);
  const lastBoundsKey = useRef("");
  const select = useRef(onSelect);
  const [ready, setReady] = useState(false);
  select.current = onSelect;

  useEffect(() => {
    if (!container.current || !style) return;
    const instance = new MapLibreMap({
      container: container.current,
      style,
      center: [-74.265, 40.752],
      zoom: 14
    });
    instance.addControl(new NavigationControl(), "top-right");
    instance.on("load", () => setReady(true));
    map.current = instance;
    return () => {
      setReady(false);
      map.current = null;
      instance.remove();
    };
  }, []);

  useEffect(() => {
    markers.current.forEach((marker) => marker.remove());
    markers.current = [];
    if (!ready || !map.current) return;

    const bounds = new LngLatBounds();
    for (const trip of trips) {
      const color = colorForBus(trip.busId);
      for (const stop of trip.stops) {
        const point: [number, number] = [stop.longitude, stop.latitude];
        bounds.extend(point);
        const element = document.createElement("button");
        element.type = "button";
        element.className = "dispatch-map-stop";
        element.style.setProperty("--bus-color", color);
        element.textContent = String(stop.position);
        element.setAttribute("aria-label",
          `${trip.busLabel}, stop ${stop.position}: ${stop.label}. Open trip.`);
        element.addEventListener("click", () => select.current(trip.id));
        markers.current.push(new Marker({ element })
          .setLngLat(point)
          .setPopup(new Popup().setText(`${trip.busLabel} · ${stop.position}. ${stop.label}`))
          .addTo(map.current));
      }
      const location = trip.location;
      if (trip.status === "active" && location &&
          now - Date.parse(location.observedAt) <= 60_000 &&
          now >= Date.parse(location.observedAt) - 60_000) {
        const point: [number, number] = [location.longitude, location.latitude];
        bounds.extend(point);
        const element = document.createElement("button");
        element.type = "button";
        element.className = "dispatch-map-bus";
        element.style.setProperty("--bus-color", color);
        element.textContent = "B";
        element.setAttribute("aria-label", `${trip.busLabel} live location. Open trip.`);
        element.addEventListener("click", () => select.current(trip.id));
        markers.current.push(new Marker({ element })
          .setLngLat(point)
          .setPopup(new Popup().setText(`${trip.busLabel} · live location`))
          .addTo(map.current));
      }
    }
    const boundsKey = trips.map((trip) =>
      `${trip.id}:${trip.stops.map((stop) =>
        `${stop.id}/${stop.latitude}/${stop.longitude}`).join(",")}`
    ).join("|");
    if (!bounds.isEmpty() && boundsKey !== lastBoundsKey.current) {
      map.current.fitBounds(bounds, { padding: 55, maxZoom: 16, duration: 0 });
      lastBoundsKey.current = boundsKey;
    }
    return () => {
      markers.current.forEach((marker) => marker.remove());
      markers.current = [];
    };
  }, [trips, colorForBus, ready, now]);

  if (!style) {
    return <p role="status">Map service is not configured.</p>;
  }
  return <div className="dispatch-map" ref={container} aria-label="Trip stops and live buses" />;
}

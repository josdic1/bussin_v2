import { useEffect, useRef } from "react";
import {
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  Popup,
  type StyleSpecification
} from "maplibre-gl";
import type { Coordinate } from "@bussin/shared";

type Stop = Coordinate & { label: string };

type Props = {
  stops: Stop[];
  onPick: (coordinate: Coordinate) => void;
  onMove: (index: number, coordinate: Coordinate) => void;
};

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

export function StopPickerMap({ stops, onPick, onMove }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const markers = useRef<Marker[]>([]);
  const handlers = useRef({ onPick, onMove });
  handlers.current = { onPick, onMove };

  const style = import.meta.env.VITE_MAP_STYLE_URL ||
    (import.meta.env.DEV ? localStyle : null);

  useEffect(() => {
    if (!container.current || !style) return;

    const instance = new MapLibreMap({
      container: container.current,
      style,
      center: [-74.4, 40.7],
      zoom: 9
    });

    instance.addControl(new NavigationControl(), "top-right");
    instance.on("click", (event) => {
      handlers.current.onPick({
        latitude: event.lngLat.lat,
        longitude: event.lngLat.lng
      });
    });

    map.current = instance;
    return () => {
      map.current = null;
      instance.remove();
    };
  }, [style]);

  useEffect(() => {
    markers.current.forEach((marker) => marker.remove());
    markers.current = [];

    if (!map.current) return;

    stops.forEach((stop, index) => {
      const marker = new Marker({ color: "#17382c", draggable: true })
        .setLngLat([stop.longitude, stop.latitude])
        .setPopup(new Popup().setText(`${index + 1}. ${stop.label}`))
        .addTo(map.current!);

      marker.getElement().setAttribute(
        "aria-label",
        `Move stop ${index + 1}: ${stop.label}`
      );
      marker.on("dragend", () => {
        const position = marker.getLngLat();
        handlers.current.onMove(index, {
          latitude: position.lat,
          longitude: position.lng
        });
      });

      markers.current.push(marker);
    });

    return () => {
      markers.current.forEach((marker) => marker.remove());
      markers.current = [];
    };
  }, [stops]);

  if (!style) {
    return <p role="alert">Map service is not configured.</p>;
  }

  return (
    <div
      ref={container}
      className="stop-picker-map"
      aria-label="Route stop map"
    />
  );
}

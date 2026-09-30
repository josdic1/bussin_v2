import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef } from "react";
import {
  LngLatBounds,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  Popup,
  setWorkerUrl
} from "maplibre-gl";
import type { Coordinate } from "@bussin/shared";
import { mapStyle } from "./basemap";

setWorkerUrl(workerUrl);

type Stop = Coordinate & { label: string };

type Props = {
  stops: Stop[];
  focus: Coordinate | null;
  onFocusMove: (coordinate: Coordinate) => void;
  onPick: (coordinate: Coordinate) => void;
  onMove: (index: number, coordinate: Coordinate) => void;
};

export function StopPickerMap({ stops, focus, onFocusMove, onPick, onMove }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const markers = useRef<Marker[]>([]);
  const handlers = useRef({ onFocusMove, onPick, onMove });
  handlers.current = { onFocusMove, onPick, onMove };

  const fitted = useRef(false);
  const style = mapStyle;

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

    if (!fitted.current && stops.length) {
      fitted.current = true;
      const bounds = new LngLatBounds();
      stops.forEach((stop) => bounds.extend([stop.longitude, stop.latitude]));
      map.current.fitBounds(bounds, { padding: 60, maxZoom: 15, duration: 0 });
    }
    if (!stops.length) fitted.current = false;

    return () => {
      markers.current.forEach((marker) => marker.remove());
      markers.current = [];
    };
  }, [stops]);

  useEffect(() => {
    if (!focus || !map.current) return;

    const position: [number, number] = [focus.longitude, focus.latitude];
    const marker = new Marker({ color: "#a85c36", draggable: true })
      .setLngLat(position)
      .addTo(map.current);

    marker.on("dragend", () => {
      const moved = marker.getLngLat();
      handlers.current.onFocusMove({
        latitude: moved.lat,
        longitude: moved.lng
      });
    });

    map.current.flyTo({ center: position, zoom: 16 });

    return () => { marker.remove(); };
  }, [focus]);

  return (
    <div
      ref={container}
      className="stop-picker-map"
      aria-label="Route stop map"
    />
  );
}

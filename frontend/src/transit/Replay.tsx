import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import { LngLatBounds, Map as MapLibreMap, Marker, setWorkerUrl, type GeoJSONSource } from "maplibre-gl";
import { dispatchGpsAuditResponseSchema, type HistoryTrip } from "@bussin/shared";
import { getJson, message } from "../ops/api";
import { timeWithSeconds } from "../ops/format";
import { mapStyle } from "../maps/basemap";
import { ErrorNote, NoMatch } from "../ops/ui";

setWorkerUrl(workerUrl);

type Point = { at: number; lng: number; lat: number; mph: number | null };

/**
 * Replay a finished trip: the bus's GPS trail on a map, with a slider and a Play button.
 * Stop arrivals sit on the slider as ticks so you can jump to "when did it reach Camp".
 */
export function Replay({ trip, color }: { trip: HistoryTrip; color: string }) {
  const [points, setPoints] = useState<Point[] | null>(null);
  const [error, setError] = useState("");
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const marker = useRef<Marker | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    getJson(`/api/dispatch/trips/${trip.id}/gps-audit`, dispatchGpsAuditResponseSchema, controller.signal)
      .then((data) => {
        const list = data.entries.flatMap((entry) => entry.kind === "sample"
          ? [{ at: Date.parse(entry.observedAt), lng: entry.longitude, lat: entry.latitude, mph: entry.speedMps === null ? null : entry.speedMps * 2.237 }]
          : []).sort((a, b) => a.at - b.at);
        setPoints(list);
        setIndex(0);
      })
      .catch((cause) => { if (!controller.signal.aborted) setError(message(cause, "Could not load the GPS trail.")); });
    return () => controller.abort();
  }, [trip.id]);

  const has = !!points && points.length > 1;
  useEffect(() => {
    if (!has || !container.current || !points) return;
    const instance = new MapLibreMap({
      container: container.current, style: mapStyle, center: [points[0]!.lng, points[0]!.lat], zoom: 13,
      attributionControl: { compact: true }, scrollZoom: false, dragRotate: false, touchPitch: false, keyboard: false
    });
    instance.on("load", () => {
      const coords = points.map((point) => [point.lng, point.lat]);
      instance.addSource("trail", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } } });
      instance.addSource("done", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords.slice(0, 1) } } });
      instance.addLayer({ id: "trail", type: "line", source: "trail", layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#9aa49d", "line-width": 4, "line-opacity": 0.45 } });
      instance.addLayer({ id: "done", type: "line", source: "done", layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": color, "line-width": 5 } });
      const bounds = new LngLatBounds();
      for (const [lng, lat] of coords) bounds.extend([lng!, lat!]);
      instance.fitBounds(bounds, { padding: 36, duration: 0, maxZoom: 16 });
      const dot = document.createElement("div");
      dot.className = "rp-bus";
      dot.style.setProperty("--c", color);
      marker.current = new Marker({ element: dot }).setLngLat(coords[0] as [number, number]).addTo(instance);
      setReady(true);
    });
    map.current = instance;
    return () => { instance.remove(); map.current = null; marker.current = null; setReady(false); };
  }, [has, points, color]);

  // Move the bus and paint the trail behind it.
  useEffect(() => {
    if (!ready || !points || !map.current) return;
    const point = points[index];
    if (!point) return;
    marker.current?.setLngLat([point.lng, point.lat]);
    (map.current.getSource("done") as GeoJSONSource | undefined)?.setData({
      type: "Feature", properties: {},
      geometry: { type: "LineString", coordinates: points.slice(0, index + 1).map((p) => [p.lng, p.lat]) }
    });
  }, [index, ready, points]);

  useEffect(() => {
    if (!playing || !points) return;
    const timer = window.setInterval(() => {
      setIndex((current) => {
        if (current >= points.length - 1) { setPlaying(false); return current; }
        return current + 1;
      });
    }, Math.max(30, Math.min(200, 12_000 / points.length)));
    return () => window.clearInterval(timer);
  }, [playing, points]);

  if (error) return <ErrorNote text={error} />;
  if (!points) return <p className="hint">Loading the GPS trail…</p>;
  if (!has) return <NoMatch>No GPS trail for this trip. The bus phone sent no locations.</NoMatch>;

  const first = points[0]!.at, last = points.at(-1)!.at;
  const point = points[index]!;
  const nearest = (at: number) => {
    let best = 0;
    for (let i = 0; i < points.length; i += 1) if (Math.abs(points[i]!.at - at) < Math.abs(points[best]!.at - at)) best = i;
    return best;
  };
  const ticks = trip.stops.filter((stop) => stop.arrivedAt).map((stop) => ({ stop, at: Date.parse(stop.arrivedAt!) }))
    .filter((tick) => tick.at >= first && tick.at <= last);

  return <div className="rp">
    <div ref={container} className="rp-map" />
    <div className="rp-bar">
      <button type="button" className="btn btn-primary sm" onClick={() => {
        if (index >= points.length - 1) setIndex(0);
        setPlaying(!playing);
      }}>{playing ? "Pause" : index >= points.length - 1 ? "Play again" : "Play"}</button>
      <div className="rp-track">
        <input type="range" min={0} max={points.length - 1} value={index} aria-label="Trip time"
          onChange={(event) => { setPlaying(false); setIndex(Number(event.target.value)); }} />
        {ticks.map(({ stop, at }) => <button key={stop.id} type="button" className="rp-tick" title={`Arrived ${stop.label}`}
          style={{ left: `${((at - first) / Math.max(1, last - first)) * 100}%` }}
          onClick={() => { setPlaying(false); setIndex(nearest(at)); }}>{stop.position}</button>)}
      </div>
      <span className="rp-time"><b>{timeWithSeconds(new Date(point.at).toISOString())}</b>
        {point.mph !== null && <small>{Math.round(point.mph)} mph</small>}</span>
    </div>
  </div>;
}

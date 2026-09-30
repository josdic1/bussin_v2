import { useCallback, useEffect, useRef, useState } from "react";
import {
  boardResponseSchema, busesResponseSchema, dispatchLocationUpdateSchema, dispatchStaffResponseSchema,
  routesResponseSchema, type BoardTrip, type Bus, type Route, type TripStaff
} from "@bussin/shared";
import { getJson, message } from "./api";
import { dayBounds } from "./format";

export type LiveState = "connecting" | "live" | "reconnecting";

/** Ticks every few seconds so ages and lateness stay current between loads. */
export function useNow(intervalMs = 5_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * Runs `load` now and every `intervalMs` while the tab is visible. Hidden tabs
 * skip polls; returning to the tab loads immediately. Aborts on unmount.
 */
export function usePolling(load: (signal: AbortSignal) => Promise<void>, intervalMs: number, deps: unknown[]) {
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    const controller = new AbortController();
    const run = () => { if (document.visibilityState === "visible") void loadRef.current(controller.signal); };
    void loadRef.current(controller.signal);
    const timer = window.setInterval(run, intervalMs);
    document.addEventListener("visibilitychange", run);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", run);
    };
  }, [intervalMs, ...deps]);
}

/**
 * The operations board for one local day: buses, trips (with stops, live
 * location and ETA), and optionally routes and assignable staff. Live GPS
 * arrives over the dispatch event stream; everything else refreshes every 15s.
 */
export function useBoard(day: string, options: { routes?: boolean; staff?: boolean } = {}) {
  const [buses, setBuses] = useState<Bus[]>([]);
  const [trips, setTrips] = useState<BoardTrip[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [staff, setStaff] = useState<TripStaff[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [live, setLive] = useState<LiveState>("connecting");
  const [revision, setRevision] = useState(0);
  const wantRoutes = !!options.routes;
  const wantStaff = !!options.staff;

  const reload = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    const source = new EventSource("/api/dispatch/live");
    source.onopen = () => setLive("live");
    source.onerror = () => setLive("reconnecting");
    const ready = () => setLive("live");
    const location = (event: MessageEvent<string>) => {
      try {
        const update = dispatchLocationUpdateSchema.parse(JSON.parse(event.data));
        setTrips((current) => current.map((trip) =>
          trip.id === update.tripId ? { ...trip, location: update.location } : trip));
      } catch {
        // Malformed live event; the regular refresh remains the fallback.
      }
    };
    source.addEventListener("ready", ready);
    source.addEventListener("location", location as EventListener);
    return () => {
      source.removeEventListener("ready", ready);
      source.removeEventListener("location", location as EventListener);
      source.close();
    };
  }, []);

  usePolling(async (signal) => {
    const query = new URLSearchParams(dayBounds(day));
    try {
      const [busData, boardData, routeData, staffData] = await Promise.all([
        getJson("/api/fleet/buses", busesResponseSchema, signal),
        getJson(`/api/dispatch/board?${query}`, boardResponseSchema, signal),
        wantRoutes ? getJson("/api/routes", routesResponseSchema, signal) : null,
        wantStaff ? getJson("/api/dispatch/staff", dispatchStaffResponseSchema, signal) : null
      ]);
      if (signal.aborted) return;
      setBuses(busData.buses);
      setTrips(boardData.trips);
      if (routeData) setRoutes(routeData.routes);
      if (staffData) setStaff(staffData.staff);
      setError("");
    } catch (cause) {
      if (!signal.aborted) setError(message(cause, "Could not load the board."));
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, 15_000, [day, revision, wantRoutes, wantStaff]);

  return { buses, trips, routes, staff, loading, error, live, reload };
}

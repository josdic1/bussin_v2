import { useCallback, useState } from "react";
import { busesResponseSchema, checkBoardResponseSchema, type CheckTrip } from "@bussin/shared";
import { getJson, message } from "../ops/api";
import { dayBounds, localDate } from "../ops/format";
import { busColors } from "../ops/fleetModel";
import { usePolling } from "../ops/useBoard";

/** Today's Ride Check board. Pass enabled=false to skip it entirely (Driver mode). */
export function useCheckBoard(enabled = true, intervalMs = 8_000) {
  const [trips, setTrips] = useState<CheckTrip[]>([]);
  const [colorOf, setColorOf] = useState<(id: string) => string>(() => () => "#17382c");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [live, setLive] = useState<"live" | "reconnecting">("live");

  usePolling(async (signal) => {
    if (!enabled) return;
    try {
      const [board, buses] = await Promise.all([
        getJson(`/api/check/board?${new URLSearchParams(dayBounds(localDate(new Date())))}`, checkBoardResponseSchema, signal),
        getJson("/api/fleet/buses", busesResponseSchema, signal)
      ]);
      if (signal.aborted) return;
      setTrips(board.trips);
      setColorOf(() => busColors(buses.buses));
      setError("");
      setLive("live");
    } catch (cause) {
      if (signal.aborted) return;
      setError(message(cause, "Could not load Ride Check."));
      setLive("reconnecting");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, intervalMs, [revision, enabled]);

  const reload = useCallback(() => setRevision((value) => value + 1), []);
  return { trips, setTrips, colorOf, loading, error, live, reload };
}

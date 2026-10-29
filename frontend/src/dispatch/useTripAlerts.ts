import { useCallback, useEffect, useState } from "react";
import { tripAlertSchema, tripAlertsResponseSchema, type TripAlert } from "@bussin/shared";
import { dayBounds, localDate } from "../ops/format";
import { getJson, send } from "../ops/api";

/** Today's alerts from the buses (and anything still open), live: the server pushes each new one. */
export function useTripAlerts(enabled: boolean) {
  const [alerts, setAlerts] = useState<TripAlert[]>([]);
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await getJson(`/api/alerts?${new URLSearchParams(dayBounds(localDate(new Date())))}`, tripAlertsResponseSchema, signal);
      setAlerts(data.alerts);
    } catch { /* the board still works; the next push or poll retries */ }
  }, []);

  useEffect(() => {
    if (!enabled) { setAlerts([]); return; }
    const controller = new AbortController();
    void load(controller.signal);
    const source = new EventSource("/api/alerts/live");
    source.addEventListener("alert", () => void load());
    source.addEventListener("ready", () => void load());
    const poll = window.setInterval(() => { if (!document.hidden) void load(); }, 30_000);
    return () => { controller.abort(); source.close(); window.clearInterval(poll); };
  }, [enabled, load]);

  const resolve = useCallback(async (id: string) => {
    const updated = tripAlertSchema.parse(await send("POST", `/api/alerts/${id}/resolve`, undefined, "Could not mark it handled."));
    setAlerts((list) => list.map((alert) => (alert.id === id ? updated : alert)));
  }, []);

  return { alerts, open: alerts.filter((alert) => !alert.resolvedAt), resolve };
}

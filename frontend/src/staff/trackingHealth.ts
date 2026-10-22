/** A receipt is live only when BOTH the accepted sample and its receipt are fresh.
 * Replaying yesterday's queued sample must never make today's tracking green. */
export type TrackingEvidence = {
  now: number; active: boolean; online: boolean; visible: boolean;
  gpsAllowed: boolean; fixAt: number | null; accuracy: number | null;
  acceptedFixAt: number | null; receivedAt: number | null;
  tripCheckedAt: number | null; queued: number; wakeHeld: boolean;
};
export const LIVE_WINDOW_MS = 20_000;
export function ageSeconds(now: number, at: number | null): number | null {
  return at === null ? null : Math.max(0, Math.floor((now - at) / 1000));
}
export function isFresh(now: number, at: number | null, window = LIVE_WINDOW_MS) {
  return at !== null && at <= now + 5_000 && now - at <= window;
}
export function trackingHealth(e: TrackingEvidence): { tone: "good" | "warn" | "bad"; title: string; detail: string } {
  if (!e.visible) return { tone: "bad", title: "Tracking interrupted", detail: "Return to Bussin and keep this screen open." };
  if (!e.online) return { tone: "bad", title: "No internet connection", detail: "Live updates cannot reach Dispatch. Reconnecting automatically." };
  if (!e.gpsAllowed) return { tone: "bad", title: "Location permission is off", detail: "Allow location for Bussin, then retry GPS." };
  if (!isFresh(e.now, e.tripCheckedAt, 45_000)) return { tone: "warn", title: "Checking trip with Dispatch", detail: "Trip status has not been confirmed recently." };
  if (!isFresh(e.now, e.fixAt)) return { tone: "warn", title: "Waiting for fresh GPS", detail: "Keep Bussin open with a clear view of the sky." };
  if (e.accuracy === null || e.accuracy > 35) return { tone: "warn", title: "GPS accuracy is poor", detail: "Waiting for a more precise location." };
  if (!e.active) return { tone: "warn", title: "Ready · tracking not started", detail: "Locations are shared only while a trip is active." };
  if (!isFresh(e.now, e.receivedAt) || !isFresh(e.now, e.acceptedFixAt) || e.queued > 0)
    return { tone: "warn", title: "Location delivery delayed", detail: "Dispatch has not confirmed the latest location. Retrying automatically." };
  if (!e.wakeHeld) return { tone: "warn", title: "Tracking live · keep screen on", detail: "Dispatch received fresh GPS. Screen wake protection is not active." };
  return { tone: "good", title: "Tracking is live", detail: "Dispatch received fresh GPS. Keep Bussin open during the trip." };
}

import { useCallback, useEffect, useRef, useState } from "react";
import {
  GPS_FAR_CODE,
  staffJourneyProgressSchema,
  staffLocationSampleInputSchema,
  staffLocationSampleResponseSchema,
  staffTripResponseSchema,
  tripActionResponseSchema,
  tripActionSchema,
  type StaffJourneyProgress,
  type StaffTrip
} from "@bussin/shared";
import { useAuth } from "../auth/AuthProvider";

/*
 * Tracking engine for the cab terminal (/terminal).
 * This is a straight copy of the logic in staff/StaffTripPage.tsx, kept separate on purpose so the
 * phone driver screen is not touched while the terminal is being proven on real buses.
 * Same endpoints, same GPS queue (same storage key), same trip actions. When the terminal is proven,
 * both screens should share one copy of this code.
 */

async function readError(response: Response, fallback: string): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
    return body.error;
  }
  return fallback;
}

/** Every request gives up after a few seconds so the phone never waits forever on a stuck server. */
function timeoutSignal(ms: number, outer?: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), ms);
  outer?.addEventListener("abort", () => { window.clearTimeout(timer); controller.abort(); });
  return controller.signal;
}
const REQUEST_TIMEOUT_MS = 10_000;

/** No signal, a timeout or a dropped connection: never show the driver raw browser text. */
function isConnectionProblem(cause: unknown): boolean {
  return !navigator.onLine || (cause instanceof Error && (cause.name === "AbortError" || cause.name === "TypeError"));
}
const NO_CONNECTION = "Can't reach Dispatch right now. GPS is saved on the phone and sends when the connection is back.";

export const clock = (value: string | number) => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
export const clockSeconds = (value: number) => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date(value));

export function distanceMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const radians = (value: number) => value * Math.PI / 180;
  const dLat = radians(b.latitude - a.latitude);
  const dLng = radians(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

export function mmss(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export type Fix = { latitude: number; longitude: number; accuracy: number; observedAt: number };
export type GpsState = "starting" | "live" | "stale" | "denied" | "unsupported" | "error";
type Sample = ReturnType<typeof staffLocationSampleInputSchema.parse>;

type WakeLockSentinel = { released: boolean; release(): Promise<void>; addEventListener(type: "release", listener: () => void): void };
type WakeLockNavigator = Navigator & { wakeLock?: { request(type: "screen"): Promise<WakeLockSentinel> } };

export const GPS_STALE_MS = 45_000;
const GPS_WATCHDOG_MS = 8_000;
const GPS_POLL_MS = 6_000;
const UPLOAD_RETRY_MS = 3_000;
// About 15 minutes of fixes: a dead zone never loses an arrival.
const UPLOAD_QUEUE_MAX = 900;
// Staff phones and bus trackers keep separate queues so one device never sends the other's fixes.
const QUEUE_STORAGE_KEYS = { staff: "bussin-gps-queue", device: "bussin-bus-gps-queue", preview: "bussin-preview-gps-queue" } as const;
const QUEUE_KEEP_MS = 15 * 60_000;

/** Unsent fixes live on the phone so closing, crashing or reloading Bussin never loses them. */
function loadSavedQueue(key: string): Sample[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - QUEUE_KEEP_MS;
    return parsed.flatMap((item) => {
      const sample = staffLocationSampleInputSchema.safeParse(item);
      return sample.success && Date.parse(sample.data.observedAt) > cutoff ? [sample.data] : [];
    }).slice(-UPLOAD_QUEUE_MAX);
  } catch {
    return [];
  }
}

function saveQueue(key: string, samples: Sample[]) {
  try {
    if (samples.length) localStorage.setItem(key, JSON.stringify(samples));
    else localStorage.removeItem(key);
  } catch {
    // Storage full or blocked: the in-memory queue still works while the app stays open.
  }
}
const TRIP_FALLBACK_MS = 30_000;
const PRESENCE_MS = 20_000;
export const EARLY_START_WARNING_MS = 10 * 60_000;
export const MANUAL_DEPART_AFTER_MS = 30_000;
// Phone-use safety: big buttons lock while the bus moves (about 7 mph and up)
// and unlock once it slows under about 3 mph. Auto-detect covers stops meanwhile.
const MOVING_LOCK_MPS = 3;
const MOVING_UNLOCK_MPS = 1.3;
// If GPS goes quiet, never leave the buttons locked: they are the fallback.
const MOVING_LOCK_MAX_FIX_AGE_MS = 15_000;

const LIVE_WINDOW_MS = 20_000;

/**
 * staff: a signed-in staff account (/terminal), endpoints under /api/staff.
 * device: the bus tracker phone (/bus), signed in as the bus, endpoints under /api/device.
 *   It can't start or finish a trip; the lead counselor does that.
 * preview: the admin's View as. Reads tripUrl every few seconds and nothing else:
 *   no GPS, no presence, no taps saved. as says which phone it is showing.
 */
export type TerminalMode = { kind: "staff" } | { kind: "device"; onUnpaired: () => void }
  | { kind: "preview"; as: "staff" | "device"; tripUrl: string };
export const PREVIEW_NOTE = "Preview only. Taps here don't save.";
const PREVIEW_POLL_MS = 8_000;

export function useTerminalTrip(mode: TerminalMode = { kind: "staff" }) {
  const { member, tenant, logout } = useAuth();
  const base = mode.kind === "device" ? "/api/device" : "/api/staff";
  const preview = mode.kind === "preview";
  const tripUrl = mode.kind === "preview" ? mode.tripUrl : `${base}/trip`;
  const queueKey = QUEUE_STORAGE_KEYS[mode.kind];
  const unpairedRef = useRef(mode.kind === "device" ? mode.onUnpaired : null);
  unpairedRef.current = mode.kind === "device" ? mode.onUnpaired : null;
  const [trip, setTrip] = useState<StaffTrip | null | undefined>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState<null | "start" | "undo">(null);
  // Arrived was refused because GPS puts the bus elsewhere: the phone asks "I'm here anyway?"
  const [farPrompt, setFarPrompt] = useState<{ stopId: string; message: string } | null>(null);
  const [justCompleted, setJustCompleted] = useState(false);
  const [notice, setNotice] = useState<{ action: "arrived" | "departed"; stopId: string; stopLabel: string } | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 8_000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const [progress, setProgress] = useState<StaffJourneyProgress | null>(null);
  const [fix, setFix] = useState<Fix | null>(null);
  const [gps, setGps] = useState<GpsState>("starting");
  const [online, setOnline] = useState(() => navigator.onLine);
  const [dispatch, setDispatch] = useState<{ state: "idle" | "live" | "queued" | "error"; at: number | null; queued: number; note: string }>(
    { state: "idle", at: null, queued: 0, note: "" });
  const [autoPaused, setAutoPaused] = useState(false);
  const [moving, setMoving] = useState(false);
  const movingRef = useRef(false);
  const autoFailures = useRef(0);
  const [awake, setAwake] = useState<"yes" | "tap" | "unsupported">("tap");
  const [now, setNow] = useState(() => Date.now());

  const tripRef = useRef<StaffTrip | null | undefined>(undefined);
  tripRef.current = trip;
  const fixRef = useRef<Fix | null>(null);
  const lastPosition = useRef<GeolocationPosition | null>(null);
  const watchId = useRef<number | null>(null);
  const pollTimer = useRef<number | null>(null);
  const queue = useRef<Sample[]>(loadSavedQueue(queueKey));
  const flushing = useRef(false);
  const retryTimer = useRef<number | null>(null);
  const lastUpload = useRef(0);
  const lastQueued = useRef<Fix | null>(null);
  const wakeLock = useRef<WakeLockSentinel | null>(null);
  const wakePending = useRef(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  // Every trip read gets a number; only the newest one may update the screen,
  // so a slow older response can never roll the trip back.
  const tripReadSeq = useRef(0);
  const loadTrip = useCallback(async (signal?: AbortSignal) => {
    const seq = ++tripReadSeq.current;
    const response = await fetch(tripUrl, { credentials: "same-origin", signal: timeoutSignal(REQUEST_TIMEOUT_MS, signal) });
    if (response.status === 401 && unpairedRef.current) { unpairedRef.current(); return; }
    if (!response.ok) throw new Error(await readError(response, "Could not load your trip."));
    const data = staffTripResponseSchema.parse(await response.json());
    if (seq !== tripReadSeq.current) return;
    setTrip(data.trip);
    setError("");
  }, [tripUrl]);

  const refresh = useCallback(() => {
    void loadTrip().catch((cause) => {
      setError(isConnectionProblem(cause) ? NO_CONNECTION
        : cause instanceof Error ? cause.message : "Could not refresh your trip.");
    });
  }, [loadTrip]);

  // Trip: server pushes a "trip" event on real changes; a slow poll covers dropped streams.
  useEffect(() => {
    const controller = new AbortController();
    void loadTrip(controller.signal).catch((cause) => {
      if (!controller.signal.aborted) setError(isConnectionProblem(cause) ? NO_CONNECTION
        : cause instanceof Error ? cause.message : "Could not load your trip.");
    });
    if (preview) {
      const poll = window.setInterval(() => { if (document.visibilityState === "visible") refresh(); }, PREVIEW_POLL_MS);
      return () => { controller.abort(); window.clearInterval(poll); };
    }
    const source = new EventSource(`${base}/live`);
    source.addEventListener("ready", refresh);
    source.addEventListener("trip", refresh);
    const fallback = window.setInterval(() => { if (document.visibilityState === "visible") refresh(); }, TRIP_FALLBACK_MS);
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("focus", refresh);
    return () => {
      controller.abort();
      source.close();
      window.clearInterval(fallback);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("focus", refresh);
    };
  }, [loadTrip, refresh, preview]);

  // Presence: GPS uploads already count; this covers the time before a trip starts or when GPS is down.
  useEffect(() => {
    if (preview) return;
    const report = () => {
      if (document.visibilityState !== "visible" || !navigator.onLine) return;
      if (Date.now() - lastUpload.current < PRESENCE_MS - 2_000) return;
      void fetch(`${base}/presence`, { method: "POST", credentials: "same-origin", signal: timeoutSignal(REQUEST_TIMEOUT_MS) }).catch(() => undefined);
    };
    report();
    const timer = window.setInterval(report, PRESENCE_MS);
    document.addEventListener("visibilitychange", report);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", report); };
  }, [base, preview]);

  const flush = useCallback(async () => {
    if (flushing.current) return;
    const queued = () => queue.current.length;
    if (!queued()) return;
    if (!navigator.onLine) {
      setDispatch((current) => ({ ...current, state: "queued", queued: queued(), note: "Offline. Fixes will send when signal returns." }));
      scheduleRetry();
      return;
    }
    flushing.current = true;
    try {
      while (queue.current.length) {
        const sample = queue.current[0];
        const response = await fetch(`${base}/trip/location`, {
          method: "POST", credentials: "same-origin", signal: timeoutSignal(REQUEST_TIMEOUT_MS),
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sample)
        });
        if (response.status === 409) {
          // That trip is over or reassigned: drop only its fixes, keep any for the current trip.
          queue.current = queue.current.filter((item) => item.tripId !== sample.tripId);
          saveQueue(queueKey, queue.current);
          refresh();
          continue;
        }
        if (!response.ok) throw new Error(await readError(response, "Could not send location to Dispatch."));
        const result = staffLocationSampleResponseSchema.parse(await response.json());
        const header = response.headers.get("X-Bussin-Journey-Progress");
        // Remove exactly the fix the server confirmed, even if the queue was trimmed meanwhile.
        queue.current = queue.current.filter((item) => item.clientSampleId !== sample.clientSampleId);
        saveQueue(queueKey, queue.current);
        lastUpload.current = Date.now();
        if (result.accepted) {
          // Three failed automation checks in a row means auto-detect is down: tell the driver.
          if (response.headers.get("X-Bussin-Journey-Error") === "1") autoFailures.current += 1;
          else autoFailures.current = 0;
          setAutoPaused(autoFailures.current >= 3);
          const parsed = header ? staffJourneyProgressSchema.safeParse(JSON.parse(decodeURIComponent(header))) : null;
          setProgress(parsed?.success ? parsed.data : null);
          if (result.journey) {
            setNotice({ action: result.journey.action, stopId: result.journey.stopId, stopLabel: result.journey.stopLabel });
            refresh();
          }
          setDispatch({ state: "live", at: Date.now(), queued: queued(), note: "" });
        } else if (result.reason !== "duplicate") {
          setDispatch((current) => ({ ...current, queued: queued(), note: result.reason === "poor_accuracy"
            ? "Waiting for a more accurate GPS fix."
            : result.reason === "future" ? "Phone clock looks wrong. Check the time settings."
            : result.reason === "bus_phone" ? "The bus phone is sending GPS, so this phone does not need to." : "Skipped an old queued fix." }));
        }
      }
    } catch (cause) {
      setDispatch((current) => ({ ...current, state: navigator.onLine ? "error" : "queued", queued: queued(),
        note: isConnectionProblem(cause)
          ? `Can't reach Dispatch. ${queued()} GPS fixes saved on the phone; they send automatically.`
          : cause instanceof Error ? `${cause.message} Retrying automatically.` : "Upload failed. Retrying automatically." }));
      scheduleRetry();
    } finally {
      flushing.current = false;
    }
  }, [refresh, base]);

  function scheduleRetry() {
    if (retryTimer.current !== null) return;
    retryTimer.current = window.setTimeout(() => { retryTimer.current = null; void flush(); }, UPLOAD_RETRY_MS);
  }

  const accept = useCallback((position: GeolocationPosition) => {
    const next: Fix = {
      latitude: position.coords.latitude, longitude: position.coords.longitude,
      accuracy: position.coords.accuracy, observedAt: position.timestamp || Date.now()
    };
    // Speed from the phone, or worked out from the last fix when the phone gives none.
    const before = fixRef.current;
    let speed: number | null = position.coords.speed !== null && position.coords.speed >= 0 ? position.coords.speed : null;
    if (speed === null && before && next.accuracy <= 35 && before.accuracy <= 35) {
      const seconds = (next.observedAt - before.observedAt) / 1000;
      if (seconds >= 0.5 && seconds <= 15) speed = distanceMeters(before, next) / seconds;
    }
    if (speed !== null) {
      if (!movingRef.current && speed >= MOVING_LOCK_MPS) { movingRef.current = true; setMoving(true); }
      else if (movingRef.current && speed <= MOVING_UNLOCK_MPS) { movingRef.current = false; setMoving(false); }
    }
    fixRef.current = next;
    lastPosition.current = position;
    setFix(next);
    setGps("live");

    const active = tripRef.current;
    if (!active || active.status !== "active" || !wantsGpsRef.current) return;
    const prior = lastQueued.current;
    if (prior && next.observedAt - prior.observedAt < 2_500 && Math.abs(next.latitude - prior.latitude) < 1e-7 &&
      Math.abs(next.longitude - prior.longitude) < 1e-7) return;
    lastQueued.current = next;
    const sample = staffLocationSampleInputSchema.safeParse({
      tripId: active.id,
      clientSampleId: crypto.randomUUID(),
      observedAt: new Date(next.observedAt).toISOString(),
      latitude: next.latitude,
      longitude: next.longitude,
      accuracyM: Math.max(0.1, next.accuracy),
      speedMps: position.coords.speed !== null && position.coords.speed >= 0 ? position.coords.speed : null,
      headingDegrees: position.coords.heading !== null && position.coords.heading >= 0 && position.coords.heading < 360 ? position.coords.heading : null
    });
    if (!sample.success) return;
    queue.current.push(sample.data);
    if (queue.current.length > UPLOAD_QUEUE_MAX) queue.current.splice(0, queue.current.length - UPLOAD_QUEUE_MAX);
    saveQueue(queueKey, queue.current);
    void flush();
  }, [flush]);

  const failed = useCallback((failure: GeolocationPositionError) => {
    if (failure.code === failure.PERMISSION_DENIED) setGps("denied");
    else if (!fixRef.current) setGps("error");
  }, []);

  /** watchPosition is primary; when it goes quiet (a parked bus, iOS) a one-shot read fills the gap so a fix still lands about every 6s. */
  const startGps = useCallback(() => {
    if (!("geolocation" in navigator)) { setGps("unsupported"); return; }
    const options = { enableHighAccuracy: true, maximumAge: 0, timeout: 12_000 };
    if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
    watchId.current = navigator.geolocation.watchPosition(accept, failed, options);
    if (pollTimer.current !== null) window.clearInterval(pollTimer.current);
    pollTimer.current = window.setInterval(() => {
      const last = fixRef.current?.observedAt ?? 0;
      if (Date.now() - last > GPS_POLL_MS - 1_000) navigator.geolocation.getCurrentPosition(accept, failed, options);
    }, GPS_POLL_MS);
  }, [accept, failed]);

  const requestWake = useCallback(async () => {
    const api = (navigator as WakeLockNavigator).wakeLock;
    if (!api) { setAwake("unsupported"); return; }
    if (document.visibilityState !== "visible" || wakePending.current) return;
    if (wakeLock.current && !wakeLock.current.released) { setAwake("yes"); return; }
    wakePending.current = true;
    try {
      const sentinel = await api.request("screen");
      wakeLock.current = sentinel;
      setAwake("yes");
      sentinel.addEventListener("release", () => { if (wakeLock.current === sentinel) wakeLock.current = null; setAwake("tap"); });
    } catch {
      setAwake("tap");
    } finally {
      wakePending.current = false;
    }
  }, []);

  // GPS runs on the bus phone always, and on a staff phone only for the trip's lead while the
  // bus phone is not reporting. Counselors' phones never ask for location.
  const wantsGps = !preview && (mode.kind === "device" || (trip?.crewRole === "lead" && !trip.busPhoneLive));
  const wantsGpsRef = useRef(wantsGps);
  wantsGpsRef.current = wantsGps;
  useEffect(() => {
    if (wantsGps) { startGps(); return; }
    if (watchId.current !== null) { navigator.geolocation.clearWatch(watchId.current); watchId.current = null; }
    if (pollTimer.current !== null) { window.clearInterval(pollTimer.current); pollTimer.current = null; }
  }, [wantsGps, startGps]);

  // Wake lock at once; watchdog restarts a silent GPS watcher; foregrounding restarts both.
  useEffect(() => {
    if (preview) return;
    void requestWake();
    // Fixes saved before the app was closed or reloaded go out as soon as it reopens.
    if (queue.current.length) void flush();
    const watchdog = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const last = fixRef.current?.observedAt ?? 0;
      if (wantsGpsRef.current && last && Date.now() - last > GPS_STALE_MS) { setGps("stale"); startGps(); }
      if (!wakeLock.current) void requestWake();
    }, GPS_WATCHDOG_MS);
    const foreground = () => {
      if (document.visibilityState !== "visible") return;
      if (wantsGpsRef.current) startGps();
      void requestWake();
      void flush();
    };
    const up = () => { setOnline(true); void flush(); };
    const down = () => setOnline(false);
    document.addEventListener("visibilitychange", foreground);
    window.addEventListener("pageshow", foreground);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.clearInterval(watchdog);
      document.removeEventListener("visibilitychange", foreground);
      window.removeEventListener("pageshow", foreground);
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
      if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
      if (pollTimer.current !== null) window.clearInterval(pollTimer.current);
      if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
      void wakeLock.current?.release().catch(() => undefined);
    };
  }, [startGps, requestWake, flush, preview]);

  // The first fix often lands before the trip loads or starts; send it as soon as the trip is running.
  useEffect(() => {
    if (trip?.status !== "active" || !wantsGps) return;
    if (lastPosition.current) accept(lastPosition.current);
    if ("geolocation" in navigator) {
      navigator.geolocation.getCurrentPosition(accept, failed, { enableHighAccuracy: true, maximumAge: 0, timeout: 12_000 });
    }
  }, [trip?.id, trip?.status, accept, failed, wantsGps]);

  async function act(type: "start" | "arrive" | "depart" | "undo_arrival" | "complete", stopId?: string, override = false) {
    if (!trip || pending) return;
    if (preview) { setError(PREVIEW_NOTE); return; }
    setFarPrompt(null);
    const action = tripActionSchema.safeParse({ type, ...(stopId ? { stopId } : {}), ...(override ? { override: true } : {}) });
    if (!action.success) return;
    setPending(true);
    setConfirming(null);
    setNotice(null);
    if (type === "undo_arrival") setProgress(null);
    setError("");
    try {
      const response = await fetch(`${base}/trip/actions`, {
        method: "POST", credentials: "same-origin", signal: timeoutSignal(REQUEST_TIMEOUT_MS),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action.data)
      });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const text = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "Could not update your trip.";
        if (type === "arrive" && stopId && body && typeof body === "object" && "code" in body && body.code === GPS_FAR_CODE) {
          setFarPrompt({ stopId, message: text });
          return;
        }
        throw new Error(text);
      }
      const result = tripActionResponseSchema.parse(await response.json());
      if (result.status === "completed") { tripReadSeq.current += 1; setJustCompleted(true); setTrip(null); } else await loadTrip();
    } catch (cause) {
      // Connection problem: say so plainly. The tap may not have saved, so ask for it again.
      setError(isConnectionProblem(cause) ? "Can't reach Dispatch, so that tap may not have saved. Check signal and tap again."
        : cause instanceof Error ? cause.message : "Could not update your trip. Tap again.");
      if (!isConnectionProblem(cause)) refresh();
    } finally {
      setPending(false);
    }
  }

  async function signOut() {
    if (preview) return;
    if (mode.kind === "device") {
      try {
        const response = await fetch(`${base}/unpair`, { method: "POST", credentials: "same-origin", signal: timeoutSignal(REQUEST_TIMEOUT_MS) });
        if (!response.ok && response.status !== 401) throw new Error();
        mode.onUnpaired();
      } catch { setError("Could not unpair. Check signal and try again."); }
      return;
    }
    try { await logout(); } catch { setError("Could not sign out. Try again."); }
  }

  // ---------- derived (same rules as the phone screen) ----------
  const fixAge = fix ? now - fix.observedAt : Infinity;
  const active = trip?.status === "active";
  const problem = preview ? null : gps === "denied"
    ? { button: "Try again", run: startGps }
    : awake === "tap"
      ? { button: "Keep screen on", run: () => void requestWake() }
      : active && fix && fixAge > GPS_STALE_MS
        ? { button: "Restart GPS", run: startGps }
        : null;
  const locked = moving && !!fix && now - fix.observedAt < MOVING_LOCK_MAX_FIX_AGE_MS;
  const finalStop = trip?.stops.at(-1) ?? null;
  const nextStop = active ? trip!.stops.find((stop) => !stop.departedAt) ?? null : null;
  const nextIndex = nextStop ? trip!.stops.indexOf(nextStop) : -1;
  const readyToComplete = !!(active && finalStop?.arrivedAt && trip!.stops.slice(0, -1).every((stop) => stop.departedAt));
  const confirmingArrival = progress && nextStop && progress.stopId === nextStop.id && progress.phase === "confirming_arrival" ? progress : null;
  const device = mode.kind === "device" || (mode.kind === "preview" && mode.as === "device");
  const status = preview
    ? { tone: "ready" as Tone, title: "Preview", detail: "What this phone shows right now. Nothing is sent or saved." }
    : terminalStatus({ now, online, gps, fixAge, active, dispatch, device });

  return {
    device, preview, wantsGps, member, tenant, trip, error, pending, confirming, setConfirming, justCompleted, notice, setNotice,
    farPrompt, setFarPrompt,
    progress, fix, gps, online, dispatch, autoPaused, awake, now,
    refresh, requestWake, act, signOut,
    fixAge, active, problem, locked, finalStop, nextStop, nextIndex, readyToComplete, confirmingArrival, status
  };
}

export type Tone = "good" | "ready" | "warn" | "bad";

/** One plain sentence for the status strip. Amber or red only when something actually needs attention. */
export function terminalStatus(s: {
  now: number; online: boolean; gps: GpsState; fixAge: number; active: boolean;
  dispatch: { state: "idle" | "live" | "queued" | "error"; at: number | null; queued: number };
  device?: boolean;
}): { tone: Tone; title: string; detail: string } {
  if (!s.online) return { tone: "bad", title: "No internet", detail: "Locations are saved on the tablet and send when it reconnects." };
  if (s.gps === "denied") return { tone: "bad", title: "Location is off", detail: "Allow location for Bussin, then tap Try again." };
  if (s.gps === "unsupported") return { tone: "bad", title: "No GPS on this device", detail: "This tablet can't share the bus location." };
  if (s.fixAge === Infinity) return { tone: s.gps === "error" ? "bad" : "warn", title: s.gps === "error" ? "No GPS signal" : "Finding location", detail: "Keep the tablet where it can see the sky." };
  if (s.fixAge > GPS_STALE_MS) return { tone: "bad", title: "GPS stopped", detail: "Keep Bussin open and on screen." };
  if (!s.active) return { tone: "ready", title: "Ready", detail: s.device ? "Tracking starts when the lead counselor starts the trip." : "Tracking starts when you start the trip." };
  if (s.dispatch.state === "error") return { tone: "warn", title: "Can't reach Dispatch", detail: "Retrying automatically. Locations are saved on the tablet." };
  if (s.dispatch.queued > 0) return { tone: "warn", title: "Catching up", detail: `Sending ${s.dispatch.queued} saved locations.` };
  if (s.dispatch.at !== null && s.now - s.dispatch.at <= LIVE_WINDOW_MS) return { tone: "good", title: "Tracking live", detail: "" };
  return { tone: "warn", title: "Waiting for Dispatch", detail: "Dispatch hasn't confirmed a location yet." };
}

import { useCallback, useEffect, useRef, useState } from "react";
import {
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

const clock = (value: string | number) => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
const clockSeconds = (value: number) => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date(value));

function distanceMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const radians = (value: number) => value * Math.PI / 180;
  const dLat = radians(b.latitude - a.latitude);
  const dLng = radians(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

function distanceText(meters: number) {
  if (meters < 1000) return `${Math.round(meters / 10) * 10} m`;
  return `${(meters / 1609.34).toFixed(1)} mi`;
}

function mmss(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

type Fix = { latitude: number; longitude: number; accuracy: number; observedAt: number };
type GpsState = "starting" | "live" | "stale" | "denied" | "unsupported" | "error";
type Sample = ReturnType<typeof staffLocationSampleInputSchema.parse>;

type WakeLockSentinel = { released: boolean; release(): Promise<void>; addEventListener(type: "release", listener: () => void): void };
type WakeLockNavigator = Navigator & { wakeLock?: { request(type: "screen"): Promise<WakeLockSentinel> } };

const GPS_STALE_MS = 45_000;
const GPS_WATCHDOG_MS = 8_000;
const GPS_POLL_MS = 6_000;
const UPLOAD_RETRY_MS = 3_000;
const UPLOAD_QUEUE_MAX = 20;
const TRIP_FALLBACK_MS = 30_000;
const PRESENCE_MS = 20_000;
const EARLY_START_WARNING_MS = 10 * 60_000;
const MANUAL_DEPART_AFTER_MS = 30_000;

/**
 * The staff phone. GPS and screen wake lock start as soon as the screen opens;
 * fixes upload only while the assigned trip is running. All GPS bookkeeping
 * lives in refs so timers never act on stale React state.
 */
export function StaffTripPage() {
  const { member, tenant, logout } = useAuth();
  const [trip, setTrip] = useState<StaffTrip | null | undefined>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState<null | "start" | "undo">(null);
  const [justCompleted, setJustCompleted] = useState(false);
  const [notice, setNotice] = useState<{ action: "arrived" | "departed"; stopId: string; stopLabel: string } | null>(null);
  const [progress, setProgress] = useState<StaffJourneyProgress | null>(null);
  const [fix, setFix] = useState<Fix | null>(null);
  const [gps, setGps] = useState<GpsState>("starting");
  const [online, setOnline] = useState(() => navigator.onLine);
  const [dispatch, setDispatch] = useState<{ state: "idle" | "live" | "queued" | "error"; at: number | null; queued: number; note: string }>(
    { state: "idle", at: null, queued: 0, note: "" });
  const [awake, setAwake] = useState<"yes" | "tap" | "unsupported">("tap");
  const [now, setNow] = useState(() => Date.now());

  const tripRef = useRef<StaffTrip | null | undefined>(undefined);
  tripRef.current = trip;
  const fixRef = useRef<Fix | null>(null);
  const lastPosition = useRef<GeolocationPosition | null>(null);
  const watchId = useRef<number | null>(null);
  const pollTimer = useRef<number | null>(null);
  const queue = useRef<Sample[]>([]);
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

  const loadTrip = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/staff/trip", { credentials: "same-origin", signal: timeoutSignal(REQUEST_TIMEOUT_MS, signal) });
    if (!response.ok) throw new Error(await readError(response, "Could not load your trip."));
    const data = staffTripResponseSchema.parse(await response.json());
    setTrip(data.trip);
    setError("");
  }, []);

  const refresh = useCallback(() => {
    void loadTrip().catch((cause) => setError(cause instanceof Error ? cause.message : "Could not refresh your trip."));
  }, [loadTrip]);

  // Trip: server pushes a "trip" event on real changes; a slow poll covers dropped streams.
  useEffect(() => {
    const controller = new AbortController();
    void loadTrip(controller.signal).catch((cause) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load your trip.");
    });
    const source = new EventSource("/api/staff/live");
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
  }, [loadTrip, refresh]);

  // Presence: GPS uploads already count; this covers the time before a trip starts or when GPS is down.
  useEffect(() => {
    const report = () => {
      if (document.visibilityState !== "visible" || !navigator.onLine) return;
      if (Date.now() - lastUpload.current < PRESENCE_MS - 2_000) return;
      void fetch("/api/staff/presence", { method: "POST", credentials: "same-origin", signal: timeoutSignal(REQUEST_TIMEOUT_MS) }).catch(() => undefined);
    };
    report();
    const timer = window.setInterval(report, PRESENCE_MS);
    document.addEventListener("visibilitychange", report);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", report); };
  }, []);

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
        const response = await fetch("/api/staff/trip/location", {
          method: "POST", credentials: "same-origin", signal: timeoutSignal(REQUEST_TIMEOUT_MS),
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sample)
        });
        if (response.status === 409) { queue.current = []; refresh(); break; }
        if (!response.ok) throw new Error(await readError(response, "Could not send location to Dispatch."));
        const result = staffLocationSampleResponseSchema.parse(await response.json());
        const header = response.headers.get("X-Bussin-Journey-Progress");
        queue.current.shift();
        lastUpload.current = Date.now();
        if (result.accepted) {
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
            : result.reason === "future" ? "Phone clock looks wrong. Check the time settings." : "Skipped an old queued fix." }));
        }
      }
    } catch (cause) {
      setDispatch((current) => ({ ...current, state: navigator.onLine ? "error" : "queued", queued: queued(),
        note: cause instanceof Error && cause.name !== "AbortError" ? `${cause.message} Retrying.` : "Dispatch did not answer. Retrying." }));
      scheduleRetry();
    } finally {
      flushing.current = false;
    }
  }, [refresh]);

  function scheduleRetry() {
    if (retryTimer.current !== null) return;
    retryTimer.current = window.setTimeout(() => { retryTimer.current = null; void flush(); }, UPLOAD_RETRY_MS);
  }

  const accept = useCallback((position: GeolocationPosition) => {
    const next: Fix = {
      latitude: position.coords.latitude, longitude: position.coords.longitude,
      accuracy: position.coords.accuracy, observedAt: position.timestamp || Date.now()
    };
    fixRef.current = next;
    lastPosition.current = position;
    setFix(next);
    setGps("live");

    const active = tripRef.current;
    if (!active || active.status !== "active") return;
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

  // Start GPS and wake lock at once; watchdog restarts a silent watcher; foregrounding restarts both.
  useEffect(() => {
    startGps();
    void requestWake();
    const watchdog = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const last = fixRef.current?.observedAt ?? 0;
      if (last && Date.now() - last > GPS_STALE_MS) { setGps("stale"); startGps(); }
      if (!wakeLock.current) void requestWake();
    }, GPS_WATCHDOG_MS);
    const foreground = () => {
      if (document.visibilityState !== "visible") return;
      startGps();
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
  }, [startGps, requestWake, flush]);

  // The first fix often lands before the trip loads or starts; send it as soon as the trip is running.
  useEffect(() => {
    if (trip?.status !== "active") return;
    if (lastPosition.current) accept(lastPosition.current);
    if ("geolocation" in navigator) {
      navigator.geolocation.getCurrentPosition(accept, failed, { enableHighAccuracy: true, maximumAge: 0, timeout: 12_000 });
    }
  }, [trip?.id, trip?.status, accept, failed]);

  async function act(type: "start" | "arrive" | "depart" | "undo_arrival" | "complete", stopId?: string) {
    if (!trip || pending) return;
    const action = tripActionSchema.safeParse({ type, ...(stopId ? { stopId } : {}) });
    if (!action.success) return;
    setPending(true);
    setConfirming(null);
    setNotice(null);
    if (type === "undo_arrival") setProgress(null);
    setError("");
    try {
      const response = await fetch("/api/staff/trip/actions", {
        method: "POST", credentials: "same-origin", signal: timeoutSignal(REQUEST_TIMEOUT_MS),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action.data)
      });
      if (!response.ok) throw new Error(await readError(response, "Could not update your trip."));
      const result = tripActionResponseSchema.parse(await response.json());
      if (result.status === "completed") { setJustCompleted(true); setTrip(null); } else await loadTrip();
    } catch (cause) {
      setError(cause instanceof Error && cause.name !== "AbortError" ? cause.message
        : "No answer from Dispatch. Check signal and tap again.");
      refresh();
    } finally {
      setPending(false);
    }
  }

  async function signOut() {
    try { await logout(); } catch { setError("Could not sign out. Try again."); }
  }

  // ---------- derived view ----------
  const fixAge = fix ? now - fix.observedAt : Infinity;
  const gpsView: [string, string, string] = gps === "denied" ? ["bad", "GPS", "Permission off"]
    : gps === "unsupported" ? ["bad", "GPS", "Not supported"]
      : !fix ? [gps === "error" ? "bad" : "warn", "GPS", gps === "error" ? "No signal" : "Finding…"]
        : fixAge > GPS_STALE_MS ? ["bad", "GPS", `No fix ${Math.round(fixAge / 1000)}s`]
          : ["", "GPS", `±${Math.round(fix.accuracy)} m`];
  const screenView: [string, string, string] = awake === "yes" ? ["", "SCREEN", "Staying awake"]
    : awake === "unsupported" ? ["warn", "SCREEN", "Keep it on"] : ["warn", "SCREEN", "Tap to keep on"];
  const active = trip?.status === "active";
  const dispatchView: [string, string, string] = !active ? ["", "DISPATCH", "Connected"]
    : !online ? ["warn", "DISPATCH", `${dispatch.queued} queued`]
      : dispatch.state === "error" ? ["bad", "DISPATCH", "Retrying"]
        : dispatch.at ? ["", "DISPATCH", `Sent ${Math.max(0, Math.round((now - dispatch.at) / 1000))}s ago`]
          : ["warn", "DISPATCH", "Waiting for GPS"];

  const problem = gps === "denied"
    ? { text: "Location is turned off for Bussin. Allow Location for this site in your phone settings, then come back.", button: "Try again", run: startGps }
    : awake === "tap"
      ? { text: "Your screen may lock and pause GPS. Tap to keep it awake during the trip.", button: "Keep screen on", run: () => void requestWake() }
      : active && fix && fixAge > GPS_STALE_MS
        ? { text: "GPS stopped updating. Keep Bussin open and on screen.", button: "Restart GPS", run: startGps }
        : null;

  const finalStop = trip?.stops.at(-1) ?? null;
  const nextStop = active ? trip!.stops.find((stop) => !stop.departedAt) ?? null : null;
  const nextIndex = nextStop ? trip!.stops.indexOf(nextStop) : -1;
  const readyToComplete = !!(active && finalStop?.arrivedAt && trip!.stops.slice(0, -1).every((stop) => stop.departedAt));
  const distance = nextStop && fix ? distanceMeters(fix, nextStop) : null;
  const doneCount = trip ? trip.stops.filter((stop, index) => stop.departedAt || (index === trip.stops.length - 1 && stop.arrivedAt)).length : 0;
  const confirmingArrival = progress && nextStop && progress.stopId === nextStop.id && progress.phase === "confirming_arrival" ? progress : null;

  let hero: React.ReactNode = null;
  let primary: React.ReactNode = null;
  if (trip === undefined) {
    hero = <div className="hero idle"><span className="ov">LOADING</span><h2>Your trip</h2><p>Checking with Dispatch…</p></div>;
  } else if (trip === null) {
    hero = <div className="hero idle"><span className="ov">{justCompleted ? "TRIP COMPLETE" : "NO TRIP YET"}</span>
      <h2>{justCompleted ? "Nice work." : "Nothing assigned"}</h2>
      <p>{justCompleted ? "Dispatch can now assign your next trip. Keep this screen open to get it." : "Dispatch has not assigned you a trip. This screen updates by itself."}</p></div>;
  } else if (trip.status === "planned") {
    const until = Date.parse(trip.departureAt) - now;
    hero = <div className={`hero ${until < -60_000 ? "bad" : "idle"}`}><span className="ov">NEXT TRIP · {trip.busLabel} · {trip.servicePeriod}</span>
      <h2>{trip.routeName}</h2><p>Leaves {clock(trip.departureAt)} · first stop {trip.stops[0]?.label ?? ""}</p>
      <div className="big">{until > 0 ? mmss(until) : `${Math.floor(-until / 60_000)} min`}<small>{until > 0 ? "until departure" : "late"}</small></div></div>;
    primary = confirming === "start"
      ? <div className="pconfirm">Scheduled for {clock(trip.departureAt)}. Start {Math.ceil(until / 60_000)} minutes early?
        <div><button type="button" onClick={() => setConfirming(null)}>Go back</button>
          <button type="button" className="pri" disabled={pending} onClick={() => void act("start")}>Start now</button></div></div>
      : <button type="button" className="bigbtn dark" disabled={pending}
        onClick={() => until > EARLY_START_WARNING_MS ? setConfirming("start") : void act("start")}>{pending ? "Starting…" : "Start trip"}</button>;
  } else if (readyToComplete) {
    hero = <div className="hero"><span className="ov">LAST STOP · {trip.stops.length} OF {trip.stops.length}</span><h2>{finalStop!.label}</h2>
      <div className="big">Arrived<small>{clock(finalStop!.arrivedAt!)}</small></div><p>Everyone off? Finish the trip to free the bus.</p></div>;
    primary = <button type="button" className="bigbtn" disabled={pending} onClick={() => void act("complete")}>{pending ? "Finishing…" : "Finish trip"}</button>;
  } else if (nextStop?.arrivedAt) {
    const dwell = now - Date.parse(nextStop.arrivedAt);
    const departing = progress && progress.stopId === nextStop.id && progress.phase === "confirming_departure" ? progress : null;
    hero = <div className="hero"><span className="ov">AT STOP · {nextIndex + 1} OF {trip.stops.length}</span><h2>{nextStop.label}</h2>
      <div className="big">{mmss(dwell)}<small>at stop</small></div>
      {departing && <><div className="prog"><b style={{ width: `${Math.round(Math.min(1, departing.qualifyingSpanSeconds / departing.requiredSpanSeconds) * 100)}%` }} /></div>
        <div className="pl"><span>Checking departure · {departing.distanceM} m out</span>
          <span>about {Math.max(0, Math.ceil(departing.requiredSpanSeconds - departing.qualifyingSpanSeconds))}s</span></div></>}
      <p>Departure records itself when you drive off.{trip.stops[nextIndex + 1] ? ` Next: ${trip.stops[nextIndex + 1].label}.` : ""}</p></div>;
    primary = confirming === "undo"
      ? <div className="pconfirm">Undo arrival at {nextStop.label}? The original stays in the log as corrected.
        <div><button type="button" onClick={() => setConfirming(null)}>Go back</button>
          <button type="button" className="pri" disabled={pending} onClick={() => void act("undo_arrival", nextStop.id)}>Undo arrival</button></div></div>
      : <>{dwell >= MANUAL_DEPART_AFTER_MS && <button type="button" className="bigbtn out" disabled={pending}
        onClick={() => void act("depart", nextStop.id)}>Leaving now</button>}
        <button type="button" className="textbtn" onClick={() => setConfirming("undo")}>Not here yet? Undo arrival</button></>;
  } else if (nextStop) {
    hero = <div className="hero"><span className="ov">NEXT STOP · {nextIndex + 1} OF {trip.stops.length}</span><h2>{nextStop.label}</h2>
      {confirmingArrival
        ? <><div className="big">{confirmingArrival.distanceM} m<small>checking arrival</small></div>
          <div className="prog"><b style={{ width: `${Math.round(Math.min(1, confirmingArrival.qualifyingSpanSeconds / confirmingArrival.requiredSpanSeconds) * 100)}%` }} /></div>
          <div className="pl"><span>GPS checks {Math.min(confirmingArrival.qualifyingFixes, confirmingArrival.requiredFixes)} of {confirmingArrival.requiredFixes}</span>
            <span>about {Math.max(0, Math.ceil(confirmingArrival.requiredSpanSeconds - confirmingArrival.qualifyingSpanSeconds))}s</span></div></>
        : <div className="big">{distance === null ? "…" : distanceText(distance)}<small>{distance === null ? "waiting for GPS" : "away"}</small></div>}
      <p>{progress?.phase === "rearming" && progress.stopId === nextStop.id
        ? "Arrival was undone. Drive out of the stop area and auto-arrival turns back on."
        : "Arrival records itself when you stop at the pickup."}</p></div>;
    primary = <button type="button" className="bigbtn out" disabled={pending} onClick={() => void act("arrive", nextStop.id)}>
      {pending ? "Saving…" : `Arrived at ${nextStop.label}`}</button>;
  }

  return <main className="field">
    <header className="ftop">
      <div className="wm">BUSSIN<span>{member?.display_name ?? ""}{trip ? ` · ${trip.busLabel}` : ""} · {tenant?.name ?? ""}</span></div>
      <button type="button" onClick={() => void signOut()}>Sign out</button>
    </header>
    <div className="health" aria-label="Phone status">
      {[gpsView, screenView, dispatchView].map(([tone, label, detail]) => <div key={label} className={tone}>
        <i /><span>{label}<small>{detail}</small></span></div>)}
    </div>
    {problem && <div className="fproblem"><p>{problem.text}</p><button type="button" onClick={problem.run}>{problem.button}</button></div>}
    {error && <p className="ferror" role="alert">{error}</p>}
    {notice && <div className="pnote" role="status">
      <span>{notice.action === "arrived" ? "Arrived" : "Left"} {notice.stopLabel} automatically</span>
      <button type="button" onClick={() => setNotice(null)}>OK</button></div>}
    {hero}
    {primary}
    {trip && trip.stops.length > 0 && <>
      <div className="psec"><h3>Route stops</h3><span>{doneCount} of {trip.stops.length} done</span></div>
      <ol className="pstops">{trip.stops.map((stop, index) => {
        const last = index === trip.stops.length - 1;
        const done = !!stop.departedAt || (last && !!stop.arrivedAt);
        const current = nextStop?.id === stop.id;
        return <li key={stop.id} className={done ? "done" : current ? "cur" : ""}>
          <span className="n">{stop.position}</span><span>{stop.label}</span>
          <em>{stop.arrivedAt ? `${stop.arrivalMethod === "automatic" ? "Auto" : "Tapped"} ${clock(stop.arrivedAt)}` : current ? "Next" : ""}</em>
        </li>;
      })}</ol>
    </>}
    <details className="pd"><summary>Details</summary><div>
      {fix ? <>Last fix {clockSeconds(fix.observedAt)} · accuracy &plusmn;{Math.round(fix.accuracy)} m<br />{fix.latitude.toFixed(6)}, {fix.longitude.toFixed(6)}<br /></> : <>No GPS fix yet.<br /></>}
      Upload queue {dispatch.queued}{dispatch.note ? ` · ${dispatch.note}` : ""}<br />
      Journey {progress ? `${progress.phase.replace("_", " ")} · ${progress.stopLabel}` : "idle"}<br />
      Keep Bussin open during the trip. Phones pause GPS for background apps.
    </div></details>
  </main>;
}

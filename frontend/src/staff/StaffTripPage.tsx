import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  staffLocationSampleInputSchema,
  staffLocationSampleResponseSchema,
  staffTripResponseSchema,
  tripActionResponseSchema,
  tripActionSchema,
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

function departureLabel(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function departureTimeLabel(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

type PhoneLocationState =
  | { status: "off" }
  | { status: "requesting" }
  | {
      status: "tracking";
      latitude: number;
      longitude: number;
      accuracy: number;
      observedAt: number;
    }
  | { status: "error"; message: string };

type ScreenWakeLockSentinel = {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void): void;
};

type WakeLockNavigator = Navigator & {
  wakeLock?: {
    request(type: "screen"): Promise<ScreenWakeLockSentinel>;
  };
};

function locationErrorMessage(error: GeolocationPositionError): string {
  if (error.code === error.PERMISSION_DENIED) {
    return "Location permission was denied. Allow Location for Bussin in your browser settings.";
  }
  if (error.code === error.POSITION_UNAVAILABLE) {
    return "Your phone could not determine its location.";
  }
  if (error.code === error.TIMEOUT) {
    return "Location took too long. Try again where the phone has a clearer GPS signal.";
  }
  return "Could not read this phone's location.";
}

function locationTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

const PHONE_LOCATION_STALE_MS = 60_000;
const PHONE_LOCATION_FUTURE_TOLERANCE_MS = 30_000;
const PHONE_LOCATION_INTENT_KEY = "bussin.staff.phone-location-trip";
const EARLY_START_WARNING_MS = 10 * 60_000;

function plannedTripTiming(departureAt: string, now: number) {
  const departure = Date.parse(departureAt);
  if (!Number.isFinite(departure)) return null;
  const lateBy = now - departure;
  if (lateBy >= 60_000) {
    return { kind: "overdue" as const, minutesLate: Math.floor(lateBy / 60_000) };
  }
  if (lateBy >= 0) {
    return { kind: "due" as const, minutesLate: 0 };
  }
  return null;
}

function rememberPhoneLocationIntent(tripId: string): void {
  try {
    window.sessionStorage.setItem(PHONE_LOCATION_INTENT_KEY, tripId);
  } catch {
    // Tracking still works if browser storage is unavailable; it just cannot
    // automatically recover across a page reload.
  }
}

function forgetPhoneLocationIntent(): void {
  try {
    window.sessionStorage.removeItem(PHONE_LOCATION_INTENT_KEY);
  } catch {
    // Nothing else to clean up.
  }
}

function shouldResumePhoneLocation(tripId: string): boolean {
  try {
    return window.sessionStorage.getItem(PHONE_LOCATION_INTENT_KEY) === tripId;
  } catch {
    return false;
  }
}

export function StaffTripPage() {
  const { member, tenant, logout } = useAuth();
  const [trip, setTrip] = useState<StaffTrip | null | undefined>();
  const [error, setError] = useState("");
  const [signOutError, setSignOutError] = useState("");
  const [actionPending, setActionPending] = useState(false);
  const [justCompleted, setJustCompleted] = useState(false);
  const [phoneLocation, setPhoneLocation] = useState<PhoneLocationState>({ status: "off" });
  const [locationUploadError, setLocationUploadError] = useState("");
  const [locationUploadNote, setLocationUploadNote] = useState("");
  const [lastUploadedAt, setLastUploadedAt] = useState<number | null>(null);
  const [locationNow, setLocationNow] = useState(() => Date.now());
  const [tripClockNow, setTripClockNow] = useState(() => Date.now());
  const [online, setOnline] = useState(() => typeof navigator === "undefined" ? true : navigator.onLine);
  const [wakeLockWarning, setWakeLockWarning] = useState("");
  const [wakeLockHeld, setWakeLockHeld] = useState(false);
  const watchIdRef = useRef<number | null>(null);
  const wakeLockRef = useRef<ScreenWakeLockSentinel | null>(null);
  const wakeLockRequestPendingRef = useRef(false);
  const wakeLockIntentionalReleaseRef = useRef(false);

  const loadTrip = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/staff/trip", {
      credentials: "same-origin",
      signal
    });
    if (!response.ok) throw new Error(await readError(response, "Could not load your trip."));
    const data = staffTripResponseSchema.parse(await response.json());
    setTrip(data.trip);
  }, []);

  useEffect(() => {
    const reportPresence = () => {
      if (document.visibilityState !== "visible" || !navigator.onLine) return;
      void fetch("/api/staff/presence", {
        method: "POST",
        credentials: "same-origin"
      }).catch(() => undefined);
    };

    reportPresence();
    const heartbeat = window.setInterval(reportPresence, 10_000);
    const handleVisibility = () => {
      if (document.visibilityState === "visible") reportPresence();
    };
    window.addEventListener("focus", reportPresence);
    window.addEventListener("online", reportPresence);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      window.clearInterval(heartbeat);
      window.removeEventListener("focus", reportPresence);
      window.removeEventListener("online", reportPresence);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadTrip(controller.signal).catch((cause) => {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : "Could not load your trip.");
      }
    });
    return () => controller.abort();
  }, [loadTrip]);

  useEffect(() => {
    const refreshTrip = () => {
      void loadTrip().then(() => setError("")).catch((cause) => {
        setError(cause instanceof Error ? cause.message : "Could not refresh your trip.");
      });
    };

    const source = new EventSource("/api/staff/live");
    source.addEventListener("ready", refreshTrip);
    source.addEventListener("trip", refreshTrip);
    source.addEventListener("sync", refreshTrip);

    // Independent reconciliation: if SSE is interrupted by Safari, Vite, or a
    // tunnel/proxy, the open staff screen still discovers assignment/status
    // changes without a manual refresh. This must not depend on the SSE stream.
    const reconciliation = window.setInterval(refreshTrip, 3_000);
    const handleVisibility = () => {
      if (document.visibilityState === "visible") refreshTrip();
    };
    window.addEventListener("focus", refreshTrip);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      source.close();
      window.clearInterval(reconciliation);
      window.removeEventListener("focus", refreshTrip);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [loadTrip]);

  useEffect(() => () => {
    if (watchIdRef.current !== null && "geolocation" in navigator) {
      navigator.geolocation.clearWatch(watchIdRef.current);
    }
    releaseScreenWakeLock();
  }, []);

  useEffect(() => {
    if (trip === undefined) return;

    if (trip?.status === "active") {
      // Safari can reload a foreground page while the network changes. Preserve
      // the driver's explicit tracking choice for this active trip so a Wi-Fi
      // -> cellular handoff does not silently turn location off.
      if (watchIdRef.current === null && shouldResumePhoneLocation(trip.id)) {
        startPhoneLocation();
      }
      return;
    }

    if (watchIdRef.current !== null && "geolocation" in navigator) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    forgetPhoneLocationIntent();
    releaseScreenWakeLock();
    setWakeLockWarning("");
    setPhoneLocation({ status: "off" });
  }, [trip?.id, trip?.status]);

  useEffect(() => {
    if (phoneLocation.status !== "tracking") return;
    const timer = window.setInterval(() => setLocationNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, [phoneLocation.status]);

  useEffect(() => {
    if (trip?.status !== "planned") return;
    setTripClockNow(Date.now());
    const timer = window.setInterval(() => setTripClockNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [trip?.id, trip?.status]);

  useEffect(() => {
    const keepAwake = trip?.status === "active" && shouldResumePhoneLocation(trip.id);
    if (!keepAwake) {
      releaseScreenWakeLock();
      return;
    }
    void requestScreenWakeLock();
  }, [trip?.id, trip?.status, phoneLocation.status]);

  useEffect(() => {
    const restoreScreenWakeLock = () => {
      if (document.visibilityState !== "visible") return;
      if (trip?.status === "active" && shouldResumePhoneLocation(trip.id)) {
        void requestScreenWakeLock();
      }
    };
    document.addEventListener("visibilitychange", restoreScreenWakeLock);
    window.addEventListener("pageshow", restoreScreenWakeLock);
    return () => {
      document.removeEventListener("visibilitychange", restoreScreenWakeLock);
      window.removeEventListener("pageshow", restoreScreenWakeLock);
    };
  }, [trip?.id, trip?.status]);

  const nextStop = useMemo(() =>
    trip?.status === "active" ? trip.stops.find((stop) => !stop.departedAt) ?? null : null,
  [trip]);
  const finalStop = trip?.stops.at(-1) ?? null;
  const readyToComplete = Boolean(
    trip?.status === "active" &&
    finalStop?.arrivedAt &&
    trip.stops.slice(0, -1).every((stop) => stop.departedAt)
  );

  async function recordAction(type: "start" | "arrive" | "depart" | "complete", stopId?: string) {
    if (!trip || actionPending) return;

    if (type === "start") {
      const earlyBy = Date.parse(trip.departureAt) - Date.now();
      if (earlyBy > EARLY_START_WARNING_MS) {
        const minutesEarly = Math.ceil(earlyBy / 60_000);
        const confirmed = window.confirm(
          `This trip is scheduled for ${departureTimeLabel(trip.departureAt)}. Start ${minutesEarly} minutes early?`
        );
        if (!confirmed) return;
      }
    }

    const action = tripActionSchema.safeParse({ type, ...(stopId ? { stopId } : {}) });
    if (!action.success) return;

    setActionPending(true);
    setError("");
    try {
      const response = await fetch("/api/staff/trip/actions", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action.data)
      });
      if (!response.ok) throw new Error(await readError(response, "Could not update your trip."));
      const result = tripActionResponseSchema.parse(await response.json());
      if (result.status === "completed") {
        setJustCompleted(true);
        setTrip(null);
      } else {
        await loadTrip();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update your trip.");
    } finally {
      setActionPending(false);
    }
  }

  async function uploadPhoneLocation(position: GeolocationPosition) {
    if (!trip || trip.status !== "active") return;
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setLocationUploadError("");
      setLocationUploadNote("Offline · waiting for a connection. Old fixes will not be replayed.");
      return;
    }

    const sample = staffLocationSampleInputSchema.safeParse({
      tripId: trip.id,
      clientSampleId: crypto.randomUUID(),
      observedAt: new Date(position.timestamp || Date.now()).toISOString(),
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracyM: position.coords.accuracy,
      speedMps: position.coords.speed,
      headingDegrees: position.coords.heading
    });
    if (!sample.success) {
      setLocationUploadError("This phone produced a location sample Bussin could not send.");
      return;
    }

    try {
      const response = await fetch("/api/staff/trip/location", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sample.data)
      });
      if (!response.ok) {
        throw new Error(await readError(response, "Could not send this location."));
      }
      const result = staffLocationSampleResponseSchema.parse(await response.json());
      setLocationUploadError("");
      if (!result.accepted) {
        if (result.reason === "duplicate") {
          setLocationUploadNote("");
          setLastUploadedAt(Date.now());
          return;
        }
        const note = result.reason === "stale"
          ? "Waiting for a fresh GPS fix."
          : result.reason === "future"
            ? "Phone time is out of sync. Waiting for a valid GPS fix."
            : `Waiting for better GPS accuracy (±${Math.round(position.coords.accuracy)} m).`;
        setLocationUploadNote(note);
        return;
      }
      setLocationUploadNote("");
      setLastUploadedAt(Date.now());
    } catch (cause) {
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        setOnline(false);
        setLocationUploadError("");
        setLocationUploadNote("Offline · waiting for a connection. Old fixes will not be replayed.");
        return;
      }
      setLocationUploadError(
        cause instanceof Error
          ? `${cause.message} Bussin will retry with the next fresh GPS fix.`
          : "Could not send this location. Bussin will retry with the next fresh GPS fix."
      );
    }
  }

  function acceptPhonePosition(position: GeolocationPosition) {
    setPhoneLocation({
      status: "tracking",
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracy: position.coords.accuracy,
      observedAt: position.timestamp || Date.now()
    });
    setLocationNow(Date.now());
    void uploadPhoneLocation(position);
  }

  function requestFreshPhoneLocation() {
    if (watchIdRef.current === null || !("geolocation" in navigator)) return;
    navigator.geolocation.getCurrentPosition(
      acceptPhonePosition,
      () => setLocationUploadNote("Waiting for a fresh GPS fix."),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 }
    );
  }

  async function requestScreenWakeLock() {
    if (!trip || trip.status !== "active" || !shouldResumePhoneLocation(trip.id)) return;
    if (document.visibilityState !== "visible") return;

    const activeTripId = trip.id;
    const wakeLock = (navigator as WakeLockNavigator).wakeLock;

    if (!wakeLock) {
      setWakeLockHeld(false);
      setWakeLockWarning(
        "Screen stay-awake is unavailable. Keep this phone awake while GPS is live."
      );
      return;
    }

    if (wakeLockRef.current && !wakeLockRef.current.released) {
      setWakeLockHeld(true);
      setWakeLockWarning("");
      return;
    }

    if (wakeLockRequestPendingRef.current) return;
    wakeLockRequestPendingRef.current = true;

    try {
      const sentinel = await wakeLock.request("screen");

      // The driver may have stopped tracking while Safari was still granting
      // the asynchronous request. Never keep that late lock alive.
      if (
        document.visibilityState !== "visible" ||
        !shouldResumePhoneLocation(activeTripId)
      ) {
        await sentinel.release().catch(() => undefined);
        return;
      }

      wakeLockRef.current = sentinel;
      wakeLockIntentionalReleaseRef.current = false;
      setWakeLockHeld(true);
      setWakeLockWarning("");

      sentinel.addEventListener("release", () => {
        if (wakeLockRef.current === sentinel) wakeLockRef.current = null;
        setWakeLockHeld(false);

        if (wakeLockIntentionalReleaseRef.current) {
          wakeLockIntentionalReleaseRef.current = false;
          return;
        }

        if (
          document.visibilityState === "visible" &&
          shouldResumePhoneLocation(activeTripId)
        ) {
          setWakeLockWarning(
            "Screen stay-awake was released. Tap below to restore live tracking."
          );
        }
      });
    } catch {
      setWakeLockHeld(false);
      setWakeLockWarning(
        "Screen stay-awake needs your tap. Restore it to keep GPS live."
      );
    } finally {
      wakeLockRequestPendingRef.current = false;
    }
  }

  function releaseScreenWakeLock() {
    const sentinel = wakeLockRef.current;
    wakeLockRef.current = null;
    setWakeLockHeld(false);

    if (sentinel && !sentinel.released) {
      wakeLockIntentionalReleaseRef.current = true;
      void sentinel.release().catch(() => {
        wakeLockIntentionalReleaseRef.current = false;
      });
    } else {
      wakeLockIntentionalReleaseRef.current = false;
    }
  }

  function startPhoneLocation() {
    if (watchIdRef.current !== null) return;
    if (!trip || trip.status !== "active") return;
    if (!("geolocation" in navigator)) {
      forgetPhoneLocationIntent();
      setPhoneLocation({
        status: "error",
        message: "This browser does not support phone location."
      });
      return;
    }

    rememberPhoneLocationIntent(trip.id);
    void requestScreenWakeLock();
    setPhoneLocation({ status: "requesting" });
    watchIdRef.current = navigator.geolocation.watchPosition(
      acceptPhonePosition,
      (locationError) => {
        if (locationError.code === locationError.PERMISSION_DENIED) {
          if (watchIdRef.current !== null) {
            navigator.geolocation.clearWatch(watchIdRef.current);
            watchIdRef.current = null;
          }
          forgetPhoneLocationIntent();
          releaseScreenWakeLock();
          setPhoneLocation({ status: "error", message: locationErrorMessage(locationError) });
          return;
        }
        setLocationUploadNote(locationErrorMessage(locationError));
      },
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 15_000 }
    );
  }

  function restartPhoneLocation() {
    if (!trip || trip.status !== "active" || !shouldResumePhoneLocation(trip.id)) return;
    if (watchIdRef.current !== null && "geolocation" in navigator) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    startPhoneLocation();
  }

  function stopPhoneLocation() {
    if (watchIdRef.current !== null && "geolocation" in navigator) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    forgetPhoneLocationIntent();
    releaseScreenWakeLock();
    setWakeLockWarning("");
    setPhoneLocation({ status: "off" });
    setLocationUploadError("");
    setLocationUploadNote("");
    setLastUploadedAt(null);
  }

  useEffect(() => {
    const handleOnline = () => {
      setOnline(true);
      setLocationUploadError("");
      if (trip?.status === "active" && shouldResumePhoneLocation(trip.id)) {
        setLocationUploadNote("Connection restored · restarting GPS tracking.");
        restartPhoneLocation();
      }
    };
    const handleOffline = () => {
      setOnline(false);
      if (trip?.status === "active" && watchIdRef.current !== null) {
        setLocationUploadError("");
        setLocationUploadNote("Offline · waiting for a connection. Old fixes will not be replayed.");
      }
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [trip?.id, trip?.status]);

  useEffect(() => {
    const recoverPhoneLocation = () => {
      if (document.visibilityState !== "visible") return;
      if (trip?.status === "active" && shouldResumePhoneLocation(trip.id)) {
        // iOS Safari can leave an existing watchPosition id in memory after the
        // page was suspended even though that watcher no longer produces fixes.
        // Treat every foreground return as a hard GPS recovery: discard the old
        // watcher and create a new one while preserving the driver's saved intent.
        setLocationUploadNote("Bussin returned to the foreground · restarting GPS tracking.");
        restartPhoneLocation();
      }
    };
    document.addEventListener("visibilitychange", recoverPhoneLocation);
    window.addEventListener("focus", recoverPhoneLocation);
    window.addEventListener("pageshow", recoverPhoneLocation);
    return () => {
      document.removeEventListener("visibilitychange", recoverPhoneLocation);
      window.removeEventListener("focus", recoverPhoneLocation);
      window.removeEventListener("pageshow", recoverPhoneLocation);
    };
  }, [trip?.id, trip?.status]);

  async function signOut() {
    stopPhoneLocation();
    setSignOutError("");
    try {
      await logout();
    } catch {
      setSignOutError("Could not sign out. Try again.");
    }
  }

  const phoneLocationStale = phoneLocation.status === "tracking" && (
    locationNow - phoneLocation.observedAt > PHONE_LOCATION_STALE_MS ||
    phoneLocation.observedAt - locationNow > PHONE_LOCATION_FUTURE_TOLERANCE_MS
  );
  const phoneLocationBadge = !online && phoneLocation.status === "tracking"
    ? "OFFLINE"
    : phoneLocationStale
      ? "STALE"
      : phoneLocation.status === "tracking"
        ? "LIVE"
        : phoneLocation.status === "requesting"
          ? "FINDING"
          : phoneLocation.status === "error"
            ? "ERROR"
            : "OFF";
  const phoneLocationClass = !online && phoneLocation.status === "tracking"
    ? "offline"
    : phoneLocationStale
      ? "stale"
      : phoneLocation.status;
  const plannedTiming = trip?.status === "planned"
    ? plannedTripTiming(trip.departureAt, tripClockNow) : null;

  return (
    <main className="staff-screen">
      <header className="staff-topbar">
        <div>
          <span className="staff-wordmark">BUSSIN</span>
          <span className="staff-tenant">{tenant?.name ?? "Bussin"}</span>
        </div>
        <button className="auth-text-button" onClick={() => void signOut()}>Sign out</button>
      </header>

      <section className="staff-content">
        <p className="eyebrow">STAFF TRIP</p>
        <h1>{member?.display_name ?? "Your trip"}</h1>
        {signOutError && <p className="auth-error" role="alert">{signOutError}</p>}
        {error && <p className="auth-error" role="alert">{error}</p>}

        {trip === undefined ? (
          <section className="staff-state">
            <h2>Loading your trip…</h2>
          </section>
        ) : trip === null ? (
          <section className="staff-state">
            <span className="staff-state-mark" aria-hidden="true">○</span>
            <h2>{justCompleted ? "Trip complete" : "No trip assigned"}</h2>
            <p>{justCompleted
              ? "Dispatch can now assign your next trip."
              : "Dispatch has not assigned you to a trip yet."}</p>
          </section>
        ) : (
          <>
            <section className="staff-trip-card">
              <div className="staff-trip-head">
                <div>
                  <span className="staff-period">{trip.servicePeriod}</span>
                  <h2>{trip.routeName}</h2>
                </div>
                <span className={`staff-status staff-status-${trip.status}`}>{trip.status}</span>
              </div>

              <dl className="staff-trip-facts">
                <div>
                  <dt>Bus</dt>
                  <dd>{trip.busLabel}</dd>
                </div>
                <div>
                  <dt>Departure</dt>
                  <dd>{departureLabel(trip.departureAt)}</dd>
                </div>
              </dl>

              {plannedTiming && <div
                className={`staff-trip-alert staff-trip-alert-${plannedTiming.kind}`} role="alert">
                <strong>{plannedTiming.kind === "due" ? "DUE NOW" : "TRIP OVERDUE"}</strong>
                <span>Scheduled {departureTimeLabel(trip.departureAt)}{
                  plannedTiming.kind === "overdue" ? ` · ${plannedTiming.minutesLate} min late` : ""
                }</span>
              </div>}

              <div className="staff-primary-action" aria-label="Trip controls">
                {trip.status === "planned" && (
                  <button type="button" disabled={actionPending}
                    onClick={() => void recordAction("start")}>
                    {actionPending ? "Starting…" : "Start trip"}
                  </button>
                )}
                {trip.status === "active" && readyToComplete && (
                  <button type="button" disabled={actionPending}
                    onClick={() => void recordAction("complete")}>
                    {actionPending ? "Completing…" : "Complete trip"}
                  </button>
                )}
                {trip.status === "active" && !readyToComplete && nextStop && (
                  <button type="button" disabled={actionPending}
                    onClick={() => void recordAction(
                      nextStop.arrivedAt ? "depart" : "arrive", nextStop.id
                    )}>
                    {actionPending ? "Saving…"
                      : nextStop.arrivedAt
                        ? `Depart ${nextStop.label}`
                        : `Arrive at ${nextStop.label}`}
                  </button>
                )}
              </div>
            </section>

            {trip.status === "active" && (
              <section className="staff-location-card">
                <div className="staff-location-head">
                  <div>
                    <p className="eyebrow">PHONE LOCATION</p>
                    <h2>{phoneLocation.status === "tracking"
                      ? phoneLocationStale ? "GPS stale" : "GPS locked"
                      : "Location"}</h2>
                  </div>
                  <span className={`staff-location-state staff-location-${phoneLocationClass}`}>
                    {phoneLocationBadge}
                  </span>
                </div>

                {phoneLocation.status === "off" && (
                  <>
                    <p className="staff-location-copy">
                      Turn on location so this phone can follow the bus during the trip.
                    </p>
                    <button className="staff-location-button" type="button" onClick={startPhoneLocation}>
                      Enable location
                    </button>
                  </>
                )}

                {phoneLocation.status === "requesting" && (
                  <p className="staff-location-copy">Waiting for this phone's first GPS fix…</p>
                )}

                {phoneLocation.status === "error" && (
                  <>
                    <p className="staff-location-error" role="alert">{phoneLocation.message}</p>
                    <button className="staff-location-button" type="button" onClick={startPhoneLocation}>
                      Try again
                    </button>
                  </>
                )}

                {phoneLocation.status === "tracking" && (
                  <>
                    <dl className="staff-location-facts">
                      <div>
                        <dt>Accuracy</dt>
                        <dd>±{Math.round(phoneLocation.accuracy)} m</dd>
                      </div>
                      <div>
                        <dt>Last fix</dt>
                        <dd>{locationTime(phoneLocation.observedAt)}</dd>
                      </div>
                    </dl>
                    <p className="staff-location-coordinates">
                      {phoneLocation.latitude.toFixed(6)}, {phoneLocation.longitude.toFixed(6)}
                    </p>
                    <p className="staff-location-upload">
                      {!online
                        ? "Offline · Dispatch will mark this location stale until a fresh fix is sent."
                        : phoneLocationStale
                          ? "GPS has stopped updating · waiting for a fresh fix."
                          : locationUploadError
                            ? locationUploadError
                            : locationUploadNote
                              ? locationUploadNote
                              : lastUploadedAt
                                ? `Sent to Dispatch ${locationTime(lastUploadedAt)}`
                                : "Sending first fix to Dispatch…"}
                    </p>
                    <p className="staff-location-background-note">
                      Keep Bussin open during the trip. Mobile browsers may pause GPS in the background; Bussin marks old locations stale and requests a fresh fix when you return.
                    </p>
                    <p className={`staff-wake-lock-status ${
                      wakeLockHeld ? "staff-wake-lock-awake" : "staff-wake-lock-needs-tap"
                    }`}>
                      Screen: {wakeLockHeld ? "AWAKE" : "NEEDS TAP"}
                    </p>
                    {wakeLockWarning && (
                      <div className="staff-wake-lock-warning" role="status">
                        <span>{wakeLockWarning}</span>
                        <button
                          className="staff-wake-lock-button"
                          type="button"
                          onClick={() => void requestScreenWakeLock()}
                        >
                          KEEP SCREEN AWAKE
                        </button>
                      </div>
                    )}
                    <button className="staff-location-stop" type="button" onClick={stopPhoneLocation}>
                      Stop location
                    </button>
                  </>
                )}
              </section>
            )}

            <section className="staff-stops-card">
              <p className="eyebrow">ROUTE STOPS</p>
              <ol className="staff-stop-list">
                {trip.stops.map((stop) => {
                  const isFinal = stop.id === finalStop?.id;
                  const done = Boolean(stop.departedAt || (isFinal && stop.arrivedAt));
                  const current = nextStop?.id === stop.id;
                  return (
                    <li key={stop.id} className={done ? "staff-stop-done" : current ? "staff-stop-current" : ""}>
                      <span className="staff-stop-number">{stop.position}</span>
                      <div>
                        <strong>{stop.label}</strong>
                        <span className="staff-stop-state">
                          {done ? "Done" : stop.arrivedAt ? "Arrived" : current ? "Next stop" : "Upcoming"}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>
          </>
        )}
      </section>
    </main>
  );
}

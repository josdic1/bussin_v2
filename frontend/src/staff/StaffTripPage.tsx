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
const GPS_POLL_INTERVAL_MS = 6_000;
const GPS_REQUEST_TIMEOUT_MS = 12_000;
const GPS_WATCH_STALL_MS = 20_000;
const GPS_WATCHDOG_INTERVAL_MS = 8_000;
const GPS_BURST_DEDUPE_MS = 2_500;
const GPS_UPLOAD_RETRY_MS = 3_000;
const GPS_UPLOAD_QUEUE_MAX = 20;
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
  const [dispatchTransport, setDispatchTransport] = useState<"idle" | "sending" | "live" | "offline" | "error">("idle");
  const [locationNow, setLocationNow] = useState(() => Date.now());
  const [tripClockNow, setTripClockNow] = useState(() => Date.now());
  const [online, setOnline] = useState(() => typeof navigator === "undefined" ? true : navigator.onLine);
  const [wakeLockWarning, setWakeLockWarning] = useState("");
  const [wakeLockHeld, setWakeLockHeld] = useState(false);
  const locationPollTimerRef = useRef<number | null>(null);
  const locationRequestInFlightRef = useRef(false);
  const uploadQueueRef = useRef<ReturnType<typeof staffLocationSampleInputSchema.parse>[]>([]);
  const uploadFlushInFlightRef = useRef(false);
  const uploadRetryTimerRef = useRef<number | null>(null);
  const tripRef = useRef<StaffTrip | null | undefined>(undefined);
  const wakeLockRef = useRef<ScreenWakeLockSentinel | null>(null);
  const wakeLockRequestPendingRef = useRef(false);
  const wakeLockIntentionalReleaseRef = useRef(false);
  const watchStartedAtRef = useRef<number | null>(null);
  tripRef.current = trip;

  const lastUploadCandidateRef = useRef<{
    observedAt: number;
    latitude: number;
    longitude: number;
    accuracy: number;
  } | null>(null);

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
    // Staff runtime is infrastructure, not a driver toggle. Every open staff
    // screen immediately attempts both capabilities and keeps their true state visible.
    startPhoneLocation();
    void requestScreenWakeLock();
  }, []);

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
    if (locationPollTimerRef.current !== null) {
      window.clearTimeout(locationPollTimerRef.current);
      locationPollTimerRef.current = null;
    }
    if (uploadRetryTimerRef.current !== null) {
      window.clearTimeout(uploadRetryTimerRef.current);
      uploadRetryTimerRef.current = null;
    }
    locationRequestInFlightRef.current = false;
    uploadFlushInFlightRef.current = false;
    releaseScreenWakeLock();
  }, []);

  useEffect(() => {
    if (trip === undefined) return;

    if (trip?.status === "active") {
      // Product truth: an active staff trip always owns live phone location.
      // There is no separate "enable tracking" mode for the driver.
      rememberPhoneLocationIntent(trip.id);
      startPhoneLocation();
      return;
    }

    // GPS and wake lock remain active while the staff screen is open, even before
    // a trip starts. Uploading still occurs only for an active assigned trip.
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
    void requestScreenWakeLock();
  }, [trip?.id, trip?.status, phoneLocation.status]);

  useEffect(() => {
    const restoreScreenWakeLock = () => {
      if (document.visibilityState !== "visible") return;
      void requestScreenWakeLock();
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

  function scheduleUploadRetry() {
    if (uploadRetryTimerRef.current !== null) return;
    uploadRetryTimerRef.current = window.setTimeout(() => {
      uploadRetryTimerRef.current = null;
      void flushLocationUploadQueue();
    }, GPS_UPLOAD_RETRY_MS);
  }

  async function flushLocationUploadQueue() {
    if (uploadFlushInFlightRef.current) return;
    if (uploadQueueRef.current.length === 0) {
      if (lastUploadedAt !== null) setDispatchTransport("live");
      return;
    }
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setDispatchTransport("offline");
      setLocationUploadError("");
      setLocationUploadNote(`Dispatch offline · ${uploadQueueRef.current.length} GPS fix${uploadQueueRef.current.length === 1 ? "" : "es"} queued.`);
      scheduleUploadRetry();
      return;
    }

    uploadFlushInFlightRef.current = true;
    setDispatchTransport("sending");
    try {
      while (uploadQueueRef.current.length > 0) {
        const sample = uploadQueueRef.current[0];
        const response = await fetch("/api/staff/trip/location", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sample)
        });
        if (!response.ok) throw new Error(await readError(response, "Could not send location to Dispatch."));

        const result = staffLocationSampleResponseSchema.parse(await response.json());
        uploadQueueRef.current.shift();
        setLocationUploadError("");

        if (!result.accepted && result.reason !== "duplicate") {
          const note = result.reason === "stale"
            ? "Dispatch rejected an old queued fix; continuing with fresh GPS."
            : result.reason === "future"
              ? "Phone time is out of sync; waiting for a valid GPS fix."
              : "Dispatch rejected a low-accuracy fix; waiting for better GPS.";
          setLocationUploadNote(note);
          continue;
        }

        setLastUploadedAt(Date.now());
        setDispatchTransport("live");
        setLocationUploadNote(uploadQueueRef.current.length > 0
          ? `Dispatch reconnected · sending ${uploadQueueRef.current.length} queued GPS fix${uploadQueueRef.current.length === 1 ? "" : "es"}.`
          : "");
      }
    } catch (cause) {
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        setOnline(false);
        setDispatchTransport("offline");
      } else {
        setDispatchTransport("error");
      }
      setLocationUploadError(
        cause instanceof Error
          ? `${cause.message} GPS is still running; Dispatch upload will retry automatically.`
          : "Dispatch upload failed. GPS is still running; upload will retry automatically."
      );
      setLocationUploadNote(`${uploadQueueRef.current.length} GPS fix${uploadQueueRef.current.length === 1 ? "" : "es"} queued.`);
      scheduleUploadRetry();
    } finally {
      uploadFlushInFlightRef.current = false;
    }
  }

  function uploadPhoneLocation(position: GeolocationPosition) {
    const activeTrip = tripRef.current;
    if (!activeTrip || activeTrip.status !== "active") return;

    const observedAt = position.timestamp || Date.now();
    const prior = lastUploadCandidateRef.current;
    const sameBurstFix = prior !== null &&
      observedAt >= prior.observedAt &&
      observedAt - prior.observedAt < GPS_BURST_DEDUPE_MS &&
      Math.abs(position.coords.latitude - prior.latitude) < 0.0000001 &&
      Math.abs(position.coords.longitude - prior.longitude) < 0.0000001 &&
      Math.abs(position.coords.accuracy - prior.accuracy) < 0.5;

    if (sameBurstFix) return;
    lastUploadCandidateRef.current = {
      observedAt,
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracy: position.coords.accuracy
    };

    const parsed = staffLocationSampleInputSchema.safeParse({
      tripId: activeTrip.id,
      clientSampleId: crypto.randomUUID(),
      observedAt: new Date(observedAt).toISOString(),
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracyM: position.coords.accuracy,
      speedMps: position.coords.speed,
      headingDegrees: position.coords.heading
    });
    if (!parsed.success) {
      setLocationUploadError("This phone produced a location sample Bussin could not queue.");
      return;
    }

    uploadQueueRef.current.push(parsed.data);
    if (uploadQueueRef.current.length > GPS_UPLOAD_QUEUE_MAX) {
      uploadQueueRef.current.splice(0, uploadQueueRef.current.length - GPS_UPLOAD_QUEUE_MAX);
    }
    void flushLocationUploadQueue();
  }

  function acceptPhonePosition(position: GeolocationPosition) {
    watchStartedAtRef.current = Date.now();
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

  async function requestScreenWakeLock() {
    if (document.visibilityState !== "visible") return;

    const activeTripId = trip?.status === "active" ? trip.id : null;
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
        document.visibilityState !== "visible"
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
          document.visibilityState === "visible"
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

  function scheduleNextLocationPoll(delayMs = GPS_POLL_INTERVAL_MS) {
    if (locationPollTimerRef.current !== null) {
      window.clearTimeout(locationPollTimerRef.current);
    }
    locationPollTimerRef.current = window.setTimeout(() => {
      locationPollTimerRef.current = null;
      pollPhoneLocation();
    }, delayMs);
  }

  function pollPhoneLocation() {
    if (!("geolocation" in navigator)) {
      setPhoneLocation({ status: "error", message: "This browser does not support phone location." });
      return;
    }
    if (locationRequestInFlightRef.current) return;

    locationRequestInFlightRef.current = true;
    watchStartedAtRef.current = Date.now();
    if (phoneLocation.status !== "tracking") setPhoneLocation({ status: "requesting" });

    navigator.geolocation.getCurrentPosition(
      (position) => {
        locationRequestInFlightRef.current = false;
        acceptPhonePosition(position);
        scheduleNextLocationPoll();
      },
      (locationError) => {
        locationRequestInFlightRef.current = false;
        if (locationError.code === locationError.PERMISSION_DENIED) {
          forgetPhoneLocationIntent();
          setPhoneLocation({ status: "error", message: locationErrorMessage(locationError) });
          return;
        }
        setLocationUploadNote(`${locationErrorMessage(locationError)} Retrying automatically.`);
        scheduleNextLocationPoll();
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: GPS_REQUEST_TIMEOUT_MS }
    );
  }

  function startPhoneLocation() {
    if (!("geolocation" in navigator)) {
      forgetPhoneLocationIntent();
      setPhoneLocation({ status: "error", message: "This browser does not support phone location." });
      return;
    }

    const activeTrip = tripRef.current;
    if (activeTrip?.status === "active") rememberPhoneLocationIntent(activeTrip.id);
    void requestScreenWakeLock();

    if (locationPollTimerRef.current !== null || locationRequestInFlightRef.current) return;
    pollPhoneLocation();
  }

  function restartPhoneLocation() {
    if (locationPollTimerRef.current !== null) {
      window.clearTimeout(locationPollTimerRef.current);
      locationPollTimerRef.current = null;
    }
    locationRequestInFlightRef.current = false;
    pollPhoneLocation();
  }

  function stopPhoneLocation() {
    if (locationPollTimerRef.current !== null) {
      window.clearTimeout(locationPollTimerRef.current);
      locationPollTimerRef.current = null;
    }
    locationRequestInFlightRef.current = false;
    forgetPhoneLocationIntent();
    releaseScreenWakeLock();
    setWakeLockWarning("");
    setPhoneLocation({ status: "off" });
    setLocationUploadError("");
    setLocationUploadNote("");
    setLastUploadedAt(null);
    setDispatchTransport("idle");
    uploadQueueRef.current = [];
    if (uploadRetryTimerRef.current !== null) {
      window.clearTimeout(uploadRetryTimerRef.current);
      uploadRetryTimerRef.current = null;
    }
    watchStartedAtRef.current = null;
    lastUploadCandidateRef.current = null;
  }

  useEffect(() => {
    const handleOnline = () => {
      setOnline(true);
      setLocationUploadError("");
      setLocationUploadNote("Connection restored · resuming GPS and Dispatch upload.");
      restartPhoneLocation();
      void flushLocationUploadQueue();
    };
    const handleOffline = () => {
      setOnline(false);
      if (trip?.status === "active") {
        setDispatchTransport("offline");
        setLocationUploadError("");
        setLocationUploadNote(`Dispatch offline · ${uploadQueueRef.current.length} queued GPS fix${uploadQueueRef.current.length === 1 ? "" : "es"}.`);
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
      // iOS Safari can leave an existing watchPosition id in memory after the
      // page was suspended even though that watcher no longer produces fixes.
      setLocationUploadNote("Bussin returned to the foreground · restarting GPS tracking.");
      restartPhoneLocation();
      void requestScreenWakeLock();
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

  useEffect(() => {
    const watchdog = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;

      void requestScreenWakeLock();
      const now = Date.now();

      if (phoneLocation.status === "tracking") {
        const ageMs = now - phoneLocation.observedAt;
        if (ageMs > GPS_WATCH_STALL_MS) {
          setLocationUploadNote(
            `GPS silent for ${Math.max(1, Math.round(ageMs / 1000))}s · restarting automatically.`
          );
          restartPhoneLocation();
        }
        return;
      }

      if (phoneLocation.status === "requesting") {
        const waitingMs = watchStartedAtRef.current === null
          ? GPS_WATCH_STALL_MS + 1
          : now - watchStartedAtRef.current;
        if (waitingMs > GPS_WATCH_STALL_MS) {
          setLocationUploadNote("GPS request went silent · restarting automatically.");
          restartPhoneLocation();
        }
        return;
      }

      startPhoneLocation();
    }, GPS_WATCHDOG_INTERVAL_MS);

    return () => window.clearInterval(watchdog);
  }, [trip?.id, trip?.status, phoneLocation.status, phoneLocation.status === "tracking" ? phoneLocation.observedAt : 0]);

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

        <section className="staff-location-card" aria-label="Bussin system status">
          <div className="staff-location-head">
            <div>
              <p className="eyebrow">SYSTEM</p>
              <h2>Runtime truth</h2>
            </div>
          </div>
          <div className="staff-runtime-truth">
            <p className={`staff-wake-lock-status ${
              wakeLockHeld ? "staff-wake-lock-awake" : "staff-wake-lock-needs-tap"
            }`}>
              Wake Lock: {wakeLockHeld ? "✓ ACTIVE" : "⚠ NOT ACTIVE"}
            </p>
            <p className={`staff-wake-lock-status ${
              phoneLocation.status === "tracking" && !phoneLocationStale && online
                ? "staff-wake-lock-awake"
                : "staff-wake-lock-needs-tap"
            }`}>
              Location: {phoneLocation.status === "tracking" && !phoneLocationStale && online
                ? `✓ LIVE · ±${Math.round(phoneLocation.accuracy)} m`
                : phoneLocation.status === "requesting"
                  ? "… FINDING GPS"
                  : phoneLocation.status === "error"
                    ? "⚠ ERROR"
                    : phoneLocationStale
                      ? "⚠ STALE"
                      : !online
                        ? "⚠ OFFLINE"
                        : "⚠ NOT ACTIVE"}
            </p>
            <p className={`staff-wake-lock-status ${
              dispatchTransport === "live"
                ? "staff-wake-lock-awake"
                : "staff-wake-lock-needs-tap"
            }`}>
              Dispatch: {dispatchTransport === "live"
                ? "✓ RECEIVING"
                : dispatchTransport === "sending"
                  ? "… SENDING"
                  : dispatchTransport === "offline"
                    ? `⚠ OFFLINE · ${uploadQueueRef.current.length} QUEUED`
                    : dispatchTransport === "error"
                      ? `⚠ RETRYING · ${uploadQueueRef.current.length} QUEUED`
                      : "… WAITING FOR FIRST SEND"}
            </p>
          </div>
          {!wakeLockHeld && wakeLockWarning && (
            <button className="staff-wake-lock-button" type="button"
              onClick={() => void requestScreenWakeLock()}>
              RESTORE WAKE LOCK
            </button>
          )}
          {phoneLocation.status === "error" && (
            <button className="staff-location-button" type="button" onClick={restartPhoneLocation}>
              RETRY LOCATION
            </button>
          )}
        </section>

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
                  <p className="staff-location-copy">Starting live location automatically…</p>
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
                      Journey is watching the next stop automatically while GPS is live. Manual Arrive/Depart remains available.
                    </p>
                    <p className="staff-location-background-note">
                      Keep Bussin open during the trip. Mobile browsers may pause GPS in the background; Bussin marks old locations stale and requests a fresh fix when you return.
                    </p>
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

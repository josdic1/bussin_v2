import { lazy, Suspense, useCallback, useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import {
  assignTripStaffSchema,
  boardResponseSchema,
  busesResponseSchema,
  createPlannedTripSchema,
  dispatchStaffResponseSchema,
  dispatchLocationUpdateSchema,
  plannedTripSchema,
  routesResponseSchema,
  tripActionSchema,
  tripStaffAssignmentResponseSchema,
  type BoardTrip,
  type Bus,
  type Route,
  type TripStaff
} from "@bussin/shared";

const DispatchMap = lazy(async () => {
  const module = await import("./DispatchMap");
  return { default: module.DispatchMap };
});

const colors = ["#c14345", "#20834e", "#d88412", "#2065b5", "#8442a1", "#148783"];

function localDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dayBounds(day: string) {
  const start = new Date(`${day}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

function dateTime(value: string) {
  return new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function time(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

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

function confirmEarlyStart(trip: BoardTrip) {
  const earlyBy = Date.parse(trip.departureAt) - Date.now();
  if (earlyBy <= EARLY_START_WARNING_MS) return true;
  const minutesEarly = Math.ceil(earlyBy / 60_000);
  return window.confirm(
    `This trip is scheduled for ${time(trip.departureAt)}. Start ${minutesEarly} minutes early?`
  );
}

 function etaText(trip: BoardTrip) {
  if (trip.status !== "active") return null;

  if (!trip.eta || trip.eta.status === "calculating") {
    return "ETA calculating";
  }

  if (trip.eta.status === "stale") {
    return "ETA unavailable · location stale";
  }

  if (trip.eta.status === "off-route") {
    return "ETA unavailable · bus off route";
  }

  if (trip.eta.status === "unavailable") {
    return "ETA unavailable";
  }

  const nextStop =
    trip.eta.stops.find((stop) => !stop.actualArrival) ??
    trip.eta.stops[0];

  if (!nextStop) return "ETA unavailable";

  const source =
    trip.eta.source === "mapbox-traffic"
      ? "traffic"
      : "live GPS pace";

  const freshness =
    trip.eta.status === "aging"
      ? " · location aging"
      : "";

  return `${nextStop.label} · ETA ${time(nextStop.etaAt)} · ${source}${freshness}`;
}

function stopEtaText(trip: BoardTrip, stopId: string) {
  if (
    trip.status !== "active" ||
    !trip.eta ||
    !["live", "aging"].includes(trip.eta.status)
  ) {
    return null;
  }

  const eta = trip.eta.stops.find((stop) => stop.stopId === stopId);

  if (!eta || eta.actualArrival) return null;

  return `ETA ${time(eta.etaAt)}`;
}

function trackingText(trip: BoardTrip, now: number) {
  if (trip.status !== "active") {
    if (trip.status === "planned") {
      return Date.parse(trip.departureAt) < now
        ? "Departure time passed · trip not started"
        : "Tracking has not started";
    }
    return "No live tracking";
  }
  if (!trip.location) return "No live location yet";
  const age = now - Date.parse(trip.location.observedAt);
  if (age > 60_000 || age < -60_000) {
    return `Location stale · last update ${time(trip.location.observedAt)}`;
  }
  return `Live location · updated ${time(trip.location.observedAt)}`;
}

function presenceAge(value: string, now: number) {
  const ageMs = Math.max(0, now - Date.parse(value));
  if (ageMs < 10_000) return "just now";
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1_000)} sec ago`;
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function staffPresenceText(trip: BoardTrip, now: number) {
  if (!trip.assignedStaff || !["planned", "active"].includes(trip.status)) return null;
  if (!trip.staffLastSeenAt) return "Phone: NOT REPORTING · staff app not seen";
  const age = now - Date.parse(trip.staffLastSeenAt);
  if (age >= -5_000 && age <= 30_000) {
    return `Phone: ONLINE · seen ${presenceAge(trip.staffLastSeenAt, now)}`;
  }
  return `Phone: NOT REPORTING · last seen ${presenceAge(trip.staffLastSeenAt, now)}`;
}

function staffPresenceClass(trip: BoardTrip, now: number) {
  if (!trip.staffLastSeenAt) return "board-staff-presence-missing";
  const age = now - Date.parse(trip.staffLastSeenAt);
  return age >= -5_000 && age <= 30_000
    ? "board-staff-presence-online"
    : "board-staff-presence-missing";
}

function chooseTrip(trips: BoardTrip[], now: number) {
  return [...trips].sort((a, b) => {
    const rank = (trip: BoardTrip) => trip.status === "active" ? 0
      : trip.status === "planned" && Date.parse(trip.departureAt) >= now ? 1
      : trip.status === "planned" ? 2 : trip.status === "completed" ? 3 : 4;
    return rank(a) - rank(b) ||
      (rank(a) <= 1 ? Date.parse(a.departureAt) - Date.parse(b.departureAt)
        : Date.parse(b.departureAt) - Date.parse(a.departureAt));
  })[0];
}

async function readError(response: Response, fallback: string) {
  const body: unknown = await response.json().catch(() => null);
  return body && typeof body === "object" && "error" in body &&
    typeof body.error === "string" ? body.error : fallback;
}

function StopLine({ trip, color }: { trip: BoardTrip; color: string }) {
  return <ol className="board-stop-line" style={{ "--bus-color": color } as CSSProperties}>
    {trip.stops.map((stop, index) => <li key={stop.id}
      className={stop.departedAt || (index === trip.stops.length - 1 && stop.arrivedAt)
        ? "board-stop-done" : ""}>
      <span className="board-stop-dot" />
      <span className="board-stop-label">{stop.label}</span>
    </li>)}
  </ol>;
}

export function DispatchPage() {
  const [buses, setBuses] = useState<Bus[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [trips, setTrips] = useState<BoardTrip[]>([]);
  const [staff, setStaff] = useState<TripStaff[]>([]);
  const [date, setDate] = useState(() => localDate(new Date()));
  const [busQuery, setBusQuery] = useState("");
  const [routeQuery, setRouteQuery] = useState("");
  const [routeId, setRouteId] = useState("");
  const [busId, setBusId] = useState("");
  const [departure, setDeparture] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [staffSaving, setStaffSaving] = useState(false);
  const [staffId, setStaffId] = useState("");
  const [actionPending, setActionPending] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [revision, setRevision] = useState(0);
  const [liveStreamState, setLiveStreamState] = useState<"connecting" | "live" | "reconnecting">("connecting");
  const [params, setParams] = useSearchParams();
  const selectedTripId = params.get("trip");
  const selectedTrip = trips.find((trip) => trip.id === selectedTripId);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const source = new EventSource("/api/dispatch/live");
    source.onopen = () => setLiveStreamState("live");
    source.onerror = () => setLiveStreamState("reconnecting");

    const receiveLocation = (event: MessageEvent<string>) => {
      try {
        const update = dispatchLocationUpdateSchema.parse(JSON.parse(event.data));
        setTrips((current) => current.map((trip) =>
          trip.id === update.tripId ? { ...trip, location: update.location } : trip
        ));
        setNow(Date.now());
      } catch {
        // Ignore malformed live events; the normal board refresh remains the fallback.
      }
    };

    const receiveReady = () => setLiveStreamState("live");
    source.addEventListener("ready", receiveReady);
    source.addEventListener("location", receiveLocation as EventListener);
    return () => {
      source.removeEventListener("ready", receiveReady);
      source.removeEventListener("location", receiveLocation as EventListener);
      source.close();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const bounds = dayBounds(date);
    const url = `/api/dispatch/board?${new URLSearchParams(bounds)}`;
    async function load() {
      try {
        const [busResponse, routeResponse, boardResponse, staffResponse] = await Promise.all([
          fetch("/api/fleet/buses", { signal: controller.signal }),
          fetch("/api/routes", { signal: controller.signal }),
          fetch(url, { signal: controller.signal }),
          fetch("/api/dispatch/staff", { signal: controller.signal })
        ]);
        if (!busResponse.ok || !routeResponse.ok || !boardResponse.ok || !staffResponse.ok) {
          throw new Error("Could not load dispatch.");
        }
        const [busData, routeData, boardData, staffData] = await Promise.all([
          busResponse.json(), routeResponse.json(), boardResponse.json(), staffResponse.json()
        ]);
        if (controller.signal.aborted) return;
        setBuses(busesResponseSchema.parse(busData).buses);
        setRoutes(routesResponseSchema.parse(routeData).routes);
        setTrips(boardResponseSchema.parse(boardData).trips);
        setStaff(dispatchStaffResponseSchema.parse(staffData).staff);
        setError("");
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "Could not load dispatch.");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [date, revision]);

  useEffect(() => {
    setStaffId(selectedTrip?.assignedStaff?.id ?? "");
  }, [selectedTrip?.id, selectedTrip?.assignedStaff?.id]);

  async function planTrip(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const when = new Date(departure);
    const parsed = createPlannedTripSchema.safeParse({
      routeId, busId,
      departureAt: departure && Number.isFinite(when.getTime()) ? when.toISOString() : ""
    });
    if (!parsed.success) {
      setError("Select a route, bus and departure time.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/dispatch/trips", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data)
      });
      if (!response.ok) throw new Error(await readError(response, "Could not plan trip."));
      const trip = plannedTripSchema.parse(await response.json());
      setDate(localDate(new Date(trip.departureAt)));
      setRevision((value) => value + 1);
      setDeparture("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not plan trip.");
    } finally {
      setSaving(false);
    }
  }

  async function saveStaffAssignment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedTrip || selectedTrip.status !== "planned" || staffSaving) return;
    const parsed = assignTripStaffSchema.safeParse({ memberId: staffId || null });
    if (!parsed.success) return;

    setStaffSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/dispatch/trips/${selectedTrip.id}/staff`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data)
      });
      if (!response.ok) {
        throw new Error(await readError(response, "Could not save staff assignment."));
      }
      tripStaffAssignmentResponseSchema.parse(await response.json());
      setRevision((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save staff assignment.");
    } finally {
      setStaffSaving(false);
    }
  }

  async function recordAction(type: "start" | "arrive" | "depart" | "complete" | "cancel",
    stopId?: string) {
    if (!selectedTrip || actionPending) return;
    if (type === "start" && !confirmEarlyStart(selectedTrip)) return;
    const action = tripActionSchema.safeParse({ type, ...(stopId ? { stopId } : {}) });
    if (!action.success) return;
    setActionPending(true);
    setError("");
    try {
      const response = await fetch(`/api/dispatch/trips/${selectedTrip.id}/actions`, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action.data)
      });
      if (!response.ok) throw new Error(await readError(response, "Could not update trip."));
      setRevision((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update trip.");
    } finally {
      setActionPending(false);
    }
  }

  const visibleBuses = buses.filter((bus) => bus.active || trips.some((trip) => trip.busId === bus.id));
  const filteredBuses = visibleBuses.filter((bus) => {
    const busTrips = trips.filter((trip) => trip.busId === bus.id);
    return bus.label.toLowerCase().includes(busQuery.trim().toLowerCase()) &&
      (!routeQuery.trim() || busTrips.some((trip) =>
        trip.routeName.toLowerCase().includes(routeQuery.trim().toLowerCase())));
  });
  const colorForBus = useCallback((id: string) => {
    const index = visibleBuses.findIndex((bus) => bus.id === id);
    return colors[(index < 0 ? 0 : index) % colors.length];
  }, [buses, trips]);
  const featured = filteredBuses.flatMap((bus) => {
    const trip = chooseTrip(trips.filter((item) => item.busId === bus.id), now);
    return trip ? [trip] : [];
  });

  function openTrip(id: string) {
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.set("trip", id);
      return next;
    });
  }
  function showAll() {
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.delete("trip");
      return next;
    });
  }

  const map = (shown: BoardTrip[]) => <Suspense fallback={<p>Loading map…</p>}>
    <DispatchMap trips={shown} colorForBus={colorForBus} onSelect={openTrip} now={now} />
  </Suspense>;

  return <>
    <p className="eyebrow">OPERATIONS / DISPATCH</p>
    {error && <p className="auth-error" role="alert">{error}</p>}
    {liveStreamState !== "live" && (
      <p className="board-live-warning" role="status">
        {liveStreamState === "reconnecting"
          ? "Live location connection interrupted · reconnecting. 15-second refresh is still active."
          : "Starting live location connection · 15-second refresh is active."}
      </p>
    )}
    {selectedTrip ? <>
      <button className="board-back" type="button" onClick={showAll}>← Show all buses</button>
      <div className="board-detail-head">
        <div>
          <h1>{selectedTrip.busLabel}</h1>
          <p className="description">{selectedTrip.routeName} {
            <span className="board-period">{selectedTrip.servicePeriod}</span>}</p>
          <p>Scheduled departure: {dateTime(selectedTrip.departureAt)}</p>
        </div>
        <span className="board-status">{selectedTrip.status}</span>
      </div>
      <p className="board-tracking" role="status">{trackingText(selectedTrip, now)}</p>
      {etaText(selectedTrip) && (
        <p className="board-tracking" role="status">
          <strong>{etaText(selectedTrip)}</strong>
        </p>
      )}
      {selectedTrip.status === "planned" && (() => {
        const timing = plannedTripTiming(selectedTrip.departureAt, now);
        return timing ? <p className={`board-trip-alert board-trip-alert-${timing.kind}`} role="alert">
          <strong>{timing.kind === "due" ? "DUE NOW" : "TRIP OVERDUE"}</strong>
          <span>Scheduled {time(selectedTrip.departureAt)}{
            timing.kind === "overdue" ? ` · ${timing.minutesLate} min late` : ""
          }</span>
        </p> : null;
      })()}
      {selectedTrip.status === "planned" ? <form className="board-staff-form"
        onSubmit={(event) => void saveStaffAssignment(event)}>
        <label htmlFor="dispatch-staff">Assigned staff</label>
        <select id="dispatch-staff" value={staffId}
          onChange={(event) => setStaffId(event.target.value)} disabled={staffSaving}>
          <option value="">Unassigned</option>
          {staff.map((person) => <option value={person.id} key={person.id}>
            {person.displayName}
          </option>)}
        </select>
        <button type="submit" disabled={staffSaving ||
          staffId === (selectedTrip.assignedStaff?.id ?? "")}>
          {staffSaving ? "Saving…" : "Save staff"}
        </button>
        {!selectedTrip.assignedStaff && <span>Assign staff before starting this trip.</span>}
      </form> : <p className="board-assigned-staff">
        Staff: <strong>{selectedTrip.assignedStaff?.displayName ?? "Not recorded"}</strong>
      </p>}
      {staffPresenceText(selectedTrip, now) && <p
        className={`board-staff-presence ${staffPresenceClass(selectedTrip, now)}`}
        role="status">
        {staffPresenceText(selectedTrip, now)}
      </p>}
      <div className="board-trip-actions" aria-label="Trip controls">
        {selectedTrip.status === "planned" && <>
          <button type="button" disabled={actionPending || !selectedTrip.assignedStaff}
            onClick={() => void recordAction("start")}>Start trip</button>
          <button type="button" disabled={actionPending}
            onClick={() => void recordAction("cancel")}>Cancel trip</button>
        </>}
        {selectedTrip.status === "active" && <>
          <button type="button" disabled={actionPending}
            onClick={() => void recordAction("cancel")}>Cancel trip</button>
          <button type="button" disabled={actionPending ||
            !selectedTrip.stops.at(-1)?.arrivedAt ||
            selectedTrip.stops.slice(0, -1).some((stop) => !stop.departedAt)}
            onClick={() => void recordAction("complete")}>Complete trip</button>
        </>}
      </div>
      {trips.filter((trip) => trip.busId === selectedTrip.busId).length > 1 &&
        <div className="board-other-trips">
          <span>Other trips for {selectedTrip.busLabel}: </span>
          {trips.filter((trip) => trip.busId === selectedTrip.busId && trip.id !== selectedTrip.id)
            .map((trip) => <button key={trip.id} type="button" onClick={() => openTrip(trip.id)}>
              {trip.routeName} · {time(trip.departureAt)}
            </button>)}
        </div>}
      <section className="board-detail-timeline" aria-label="Stops in route order">
        <StopLine trip={selectedTrip} color={colorForBus(selectedTrip.busId)} />
      </section>
      <div className="board-detail-grid">
        <section className="dispatch-card board-timetable">
          <h2>Stops</h2>
          <p>Scheduled departure: {time(selectedTrip.departureAt)}</p>
          <ol>{selectedTrip.stops.map((stop) => <li key={stop.id}>
            <strong>{stop.position}. {stop.label}</strong>
            <span>{stop.arrivedAt ? `Arrived ${time(stop.arrivedAt)}` : "Arrival not recorded"}</span>
            {stopEtaText(selectedTrip, stop.id) && (
              <span><strong>{stopEtaText(selectedTrip, stop.id)}</strong></span>
            )}
            <span>{stop.id === selectedTrip.stops.at(-1)?.id
              ? "Final destination"
              : stop.departedAt ? `Departed ${time(stop.departedAt)}` : "Departure not recorded"}</span>
            {selectedTrip.status === "active" &&
              selectedTrip.stops.find((item) => !item.departedAt)?.id === stop.id &&
              (!stop.arrivedAt || stop.id !== selectedTrip.stops.at(-1)?.id) &&
              <button type="button" disabled={actionPending}
                onClick={() => void recordAction(stop.arrivedAt ? "depart" : "arrive", stop.id)}>
                {stop.arrivedAt ? "Record departure" : "Record arrival"}
              </button>}
          </li>)}</ol>
        </section>
        <section className="dispatch-card board-map-panel">
          <h2>Route stops</h2>
          <p>Numbered pins are stops. A bus marker appears only with a recent GPS update.</p>
          {map([selectedTrip])}
        </section>
      </div>
    </> : <>
      {selectedTripId && <p role="status">That trip is not shown for this date. <button
        type="button" onClick={showAll}>Show all buses</button></p>}
      <h1>All buses</h1>
      <p className="description">Today's bus trips in one view.</p>
      <div className="board-filters">
        <label htmlFor="board-date">Day<input id="board-date" type="date" value={date}
          onChange={(event) => { if (event.target.value) setDate(event.target.value); }} /></label>
        <label htmlFor="board-bus-search">Bus<input id="board-bus-search" type="search"
          value={busQuery} onChange={(event) => setBusQuery(event.target.value)}
          placeholder="Find a bus" /></label>
        <label htmlFor="board-route-search">Route<input id="board-route-search" type="search"
          value={routeQuery} onChange={(event) => setRouteQuery(event.target.value)}
          placeholder="Find a route" /></label>
      </div>
      {loading ? <p>Loading buses…</p> : filteredBuses.length === 0 ?
        <p>{visibleBuses.length ? "No buses match those filters." :
          <>No buses added. <Link to="/fleet">Add a bus in Fleet</Link>.</>}</p> :
        <div className="board-bus-grid">{filteredBuses.map((bus) => {
          const dailyTrips = trips.filter((trip) => trip.busId === bus.id);
          const trip = chooseTrip(dailyTrips, now);
          const color = colorForBus(bus.id);
          return trip ? <button type="button" className="board-bus-card" key={bus.id}
            style={{ "--bus-color": color } as CSSProperties}
            onClick={() => openTrip(trip.id)}>
            <span className="board-card-head"><strong>{bus.label}</strong>
              <span className="board-period">{trip.servicePeriod}</span></span>
            <span className="board-card-route">{trip.routeName}</span>
            <span className="board-card-time">{time(trip.departureAt)} · {trip.status}</span>
            <span className="board-card-staff">Staff: {trip.assignedStaff?.displayName ?? "Unassigned"}</span>
            {trip.status === "planned" && (() => {
              const timing = plannedTripTiming(trip.departureAt, now);
              return timing ? <span className={`board-card-alert board-card-alert-${timing.kind}`}>
                {timing.kind === "due"
                  ? "DUE NOW"
                  : `TRIP OVERDUE · ${timing.minutesLate} min late`}
              </span> : null;
            })()}
            {staffPresenceText(trip, now) && <span
              className={`board-staff-presence ${staffPresenceClass(trip, now)}`}>
              {staffPresenceText(trip, now)}
            </span>}
            <span className="board-card-tracking">{trackingText(trip, now)}</span>
            {etaText(trip) && (
              <span className="board-card-tracking">
                <strong>{etaText(trip)}</strong>
              </span>
            )}
            <span className="board-mini-line" aria-label={`${trip.stops.length} stops`}>
              {trip.stops.map((stop) => <span key={stop.id} title={stop.label} />)}
            </span>
            {dailyTrips.length > 1 && <small>{dailyTrips.length} trips on this day</small>}
          </button> : <div className="board-bus-card board-bus-empty" key={bus.id}
            style={{ "--bus-color": color } as CSSProperties}>
            <span className="board-card-head"><strong>{bus.label}</strong></span>
            <p>No trip scheduled for this day.</p>
          </div>;
        })}</div>}
      <section className="dispatch-card board-overview-map">
        <h2>Shared map</h2>
        <p>Numbered pins show stops in each bus's color. Only fresh GPS appears as a bus marker.</p>
        {featured.length ? map(featured) : <p>No trips to show on this map.</p>}
      </section>
    </>}
    <details className="dispatch-card board-plan">
      <summary>Plan another trip</summary>
      {buses.every((bus) => !bus.active) && <p>Add a bus in <Link to="/fleet">Fleet</Link> first.</p>}
      {routes.every((route) => !route.active || !route.stops.length) &&
        <p>Add a route in <Link to="/routes">Routes</Link> first.</p>}
      <form className="dispatch-form" onSubmit={(event) => void planTrip(event)}>
        <label htmlFor="dispatch-bus">Bus</label>
        <select id="dispatch-bus" value={busId} onChange={(event) => setBusId(event.target.value)}
          required disabled={saving}>
          <option value="">Choose a bus</option>
          {buses.filter((bus) => bus.active).map((bus) =>
            <option value={bus.id} key={bus.id}>{bus.label}</option>)}
        </select>
        <label htmlFor="dispatch-route">Route</label>
        <select id="dispatch-route" value={routeId}
          onChange={(event) => setRouteId(event.target.value)} required disabled={saving}>
          <option value="">Choose a route</option>
          {routes.filter((route) => route.active && route.stops.length).map((route) =>
            <option value={route.id} key={route.id}>{route.name} · {route.servicePeriod} ({route.stops.length} stops)</option>)}
        </select>
        <label htmlFor="dispatch-departure">Departure date and time</label>
        <input id="dispatch-departure" type="datetime-local" value={departure}
          onChange={(event) => setDeparture(event.target.value)} required disabled={saving} />
        <button className="auth-button" disabled={saving || loading ||
          !buses.some((bus) => bus.active) || !routes.some((route) => route.active && route.stops.length)}>
          {saving ? "Planning…" : "Plan trip"}
        </button>
      </form>
    </details>
  </>;
}

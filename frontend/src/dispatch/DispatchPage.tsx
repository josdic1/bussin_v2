import { lazy, Suspense, useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { createPlannedTripSchema, riderCoverageSchema, type BoardTrip, type Bus, type RiderCoverage, type Route } from "@bussin/shared";
import { getJson, message, send } from "../ops/api";
import { dateLabel, dayName, localDate, MIN, plural, routeWithPeriod, time } from "../ops/format";
import { busColors, fleetRows, gpsFresh, timing, type BusRow } from "../ops/fleetModel";
import { Overlay, useOps } from "../ops/OpsShell";
import { ErrorNote, LivePill, NoMatch } from "../ops/ui";
import { useBoard, useNow } from "../ops/useBoard";
import { useTripActions } from "../ops/useTripActions";
import { alerts as checkAlerts, counts, missed } from "../check/checkModel";
import { useCheckBoard } from "../check/useCheckBoard";
import { RideCheck } from "../check/RideCheck";
import { TripDetail } from "./TripDetail";
import { useAttentionSignal } from "./attentionSignal";
import { useTripAlerts } from "./useTripAlerts";
import "./now.css";

/*
 * Dispatch = right now. One card per bus, every bus once.
 * A card answers: where is it, when does it get there, who's on it.
 * A bus with a problem turns red and moves to the top. Nothing else competes for attention.
 */

const DispatchMap = lazy(async () => ({ default: (await import("./DispatchMap")).DispatchMap }));

/** "4 min", "1 hr 20 min" */
function mins(ms: number) {
  const total = Math.max(0, Math.round(ms / MIN));
  if (total < 60) return `${total} min`;
  return `${Math.floor(total / 60)} hr${total % 60 ? ` ${total % 60} min` : ""}`;
}

function rowForTrip(rows: BusRow[], tripId: string | null) {
  if (!tripId) return null;
  for (const row of rows) {
    const trip = row.trips.find((item) => item.id === tripId);
    if (trip) return { row, trip };
  }
  return null;
}

export function PlanTripForm({ buses, routes, onPlanned }: {
  buses: Bus[]; routes: Route[]; onPlanned: (trip: { busLabel: string; day: string }) => void;
}) {
  const today = localDate(new Date());
  const [busId, setBusId] = useState("");
  const [routeId, setRouteId] = useState("");
  const [date, setDate] = useState(today);
  const [clock, setClock] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const activeBuses = buses.filter((bus) => bus.active);
  const usableRoutes = routes.filter((route) => route.active && route.stops.length);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const when = new Date(`${date}T${clock}`);
    const parsed = createPlannedTripSchema.safeParse({
      busId, routeId, departureAt: date && clock && Number.isFinite(when.getTime()) ? when.toISOString() : ""
    });
    if (!parsed.success) { setError("Pick a bus, a route and a time."); return; }
    setSaving(true);
    setError("");
    try {
      await send("POST", "/api/dispatch/trips", parsed.data, "Could not add the trip.");
      onPlanned({ busLabel: activeBuses.find((bus) => bus.id === busId)?.label ?? "the bus", day: date });
    } catch (cause) {
      setError(message(cause, "Could not add the trip."));
    } finally {
      setSaving(false);
    }
  }

  return <form className="planf" onSubmit={(event) => void submit(event)} noValidate>
    {!activeBuses.length && <p className="hint">Add a bus in Fleet first.</p>}
    {!usableRoutes.length && <p className="hint">Add a line in Lines first.</p>}
    <div className="ctl-row"><label htmlFor="plan-bus">Bus</label>
      <select id="plan-bus" value={busId} onChange={(event) => setBusId(event.target.value)}>
        <option value="">Choose a bus</option>
        {activeBuses.map((bus) => <option key={bus.id} value={bus.id}>{bus.label}</option>)}
      </select></div>
    <div className="ctl-row"><label htmlFor="plan-route">Route</label>
      <select id="plan-route" value={routeId} onChange={(event) => setRouteId(event.target.value)}>
        <option value="">Choose a route</option>
        {usableRoutes.map((route) => <option key={route.id} value={route.id}>
          {routeWithPeriod(route.name, route.servicePeriod)}</option>)}
      </select></div>
    <div className="rf2">
      <div className="ctl-row"><label htmlFor="plan-date">Day</label>
        <input id="plan-date" type="date" value={date} min={today} onChange={(event) => setDate(event.target.value)} /></div>
      <div className="ctl-row"><label htmlFor="plan-time">Leaves at</label>
        <input id="plan-time" type="time" value={clock} onChange={(event) => setClock(event.target.value)} /></div>
    </div>
    <ErrorNote text={error} />
    <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? "Adding…" : "Add trip"}</button>
    <p className="hint">Same trip every day? Set it once in <Link to="/lines">Lines</Link>.</p>
  </form>;
}

// ---------- One bus, in plain words ----------

type Tone = "bad" | "warn" | "ok" | "idle";

type Card = {
  row: BusRow;
  trip: BoardTrip | null;
  tone: Tone;
  rank: number;
  tag: string;
  big: string;
  small: string;
  progress: { done: number; total: number } | null;
  problem: string | null;
  action: { label: string; run: () => void } | null;
};

function lastStop(trip: BoardTrip) {
  return trip.stops.at(-1) ?? null;
}

function arrivalAt(trip: BoardTrip): string | null {
  if (!trip.eta || !["live", "aging"].includes(trip.eta.status)) return null;
  return trip.eta.stops.at(-1)?.etaAt ?? null;
}

function doneCount(trip: BoardTrip) {
  return trip.stops.filter((stop, index) =>
    stop.departedAt || (index === trip.stops.length - 1 && stop.arrivedAt)).length;
}

function describe(row: BusRow, now: number, open: (id: string) => void, start: (trip: BoardTrip) => void): Card {
  const trip = row.trip;
  const base = { row, trip, progress: null, problem: null, action: null };
  if (!trip) return { ...base, tone: "idle", rank: 5, tag: "Not out today", big: "No trip today", small: "" };

  const end = lastStop(trip);
  const first = trip.stops[0];

  if (trip.status === "active") {
    const here = trip.stops.find((stop) => stop.arrivedAt && !stop.departedAt);
    const next = trip.stops.find((stop, index) =>
      index === trip.stops.length - 1 ? !stop.arrivedAt : !stop.departedAt);
    const arrive = arrivalAt(trip);
    const fresh = gpsFresh(trip, now);
    // A trip still "running" hours later was never finished: say that, not "stopped for 45 hr".
    const started = Date.parse(trip.stops[0]?.departedAt ?? trip.departureAt);
    if (now - started > 4 * 60 * MIN) {
      const day = new Date(started).toDateString() === new Date(now).toDateString() ? "" : `${dayName(localDate(new Date(started)))} `;
      return {
        ...base, tone: "bad", rank: 0, tag: "Never finished",
        big: "Still marked running", small: `Left ${day}${time(started)}. ${end ? `Going to ${end.label}.` : ""}`,
        problem: "Nobody finished this trip. Open it and finish or cancel it.",
        action: { label: "Open", run: () => open(trip.id) }
      };
    }
    const big = here
      ? here === end ? `At ${here.label}` : (() => {
        const stopped = now - Date.parse(here.arrivedAt!);
        return stopped >= 2 * MIN ? `Stopped at ${here.label}, ${mins(stopped)}` : `Stopped at ${here.label}`;
      })()
      : next ? `Heading to ${next.label}` : `At ${end?.label ?? "the last stop"}`;
    const small = end
      ? arrive ? `Gets to ${end.label} at ${time(arrive)}` : `Going to ${end.label}`
      : "";
    const silent = trip.location ? mins(now - Date.parse(trip.location.observedAt)) : null;
    return {
      ...base, tone: fresh ? "ok" : "bad", rank: fresh ? 2 : 0,
      tag: fresh ? "On the road" : "Lost signal",
      big, small,
      progress: { done: doneCount(trip), total: trip.stops.length },
      problem: fresh ? null : silent
        ? `No location for ${silent}. Call ${trip.assignedStaff?.displayName ?? "the bus"}.`
        : "No location since it left.",
      action: fresh ? null : { label: "Open", run: () => open(trip.id) }
    };
  }

  if (trip.status === "planned") {
    const late = timing(trip, now);
    const until = Date.parse(trip.departureAt) - now;
    const from = first ? `From ${first.label}${end ? ` to ${end.label}` : ""}` : "";
    if (late?.kind === "overdue") {
      return {
        ...base, tone: "bad", rank: 0, tag: `${late.minutes} min late`,
        big: "Hasn't left", small: `Was due at ${time(trip.departureAt)}. ${from}`,
        problem: trip.assignedStaff ? "Start it or cancel it." : "No lead counselor, so it can't start.",
        action: trip.assignedStaff ? { label: "Start", run: () => start(trip) } : { label: "Assign lead", run: () => open(trip.id) }
      };
    }
    const soon = until <= 30 * MIN;
    const noLead = !trip.assignedStaff;
    return {
      ...base, tone: noLead && soon ? "warn" : "idle", rank: noLead && soon ? 1 : 3,
      tag: late?.kind === "due" ? "Leaving now" : `Leaves ${time(trip.departureAt)}`,
      big: late?.kind === "due" ? "Leaving now" : `Leaves in ${mins(until)}`,
      small: from,
      problem: noLead && soon ? "No lead counselor yet." : null,
      action: late?.kind === "due" && trip.assignedStaff ? { label: "Start", run: () => start(trip) }
        : noLead && soon ? { label: "Assign lead", run: () => open(trip.id) } : null
    };
  }

  if (trip.status === "completed") {
    const at = end?.arrivedAt;
    return { ...base, tone: "idle", rank: 4, tag: "Done",
      big: at ? `Done at ${time(at)}` : "Done", small: end ? `Ended at ${end.label}` : "" };
  }
  return { ...base, tone: "idle", rank: 4, tag: "Cancelled", big: "Cancelled", small: "" };
}

function BusCard({ card, kids, onOpen }: {
  card: Card; kids: { aboard: number; total: number; missing: number } | null; onOpen: () => void;
}) {
  const { row, trip } = card;
  const pct = card.progress && card.progress.total > 1
    ? Math.round(card.progress.done / card.progress.total * 100) : 0;
  const live = trip && (trip.status === "active" || trip.status === "planned");
  const driverPhone = trip?.driver?.phone;
  return <article className={`nb-card ${card.tone}`} style={{ "--c": row.color } as CSSProperties}
    tabIndex={trip ? 0 : -1} role={trip ? "button" : undefined}
    onClick={trip ? onOpen : undefined}
    onKeyDown={(event) => { if (trip && event.key === "Enter") onOpen(); }}>
    <header>
      <span className="nb-num">{row.num}</span>
      <b className="nb-name">{row.bus.label}</b>
      <span className={`nb-tag ${card.tone}`}>{card.tag}</span>
    </header>
    <p className="nb-big">{card.big}</p>
    {card.small && <p className="nb-small">{card.small}</p>}
    {card.progress && <div className="nb-bar" aria-label={`${card.progress.done} of ${card.progress.total} stops done`}>
      <i style={{ width: `${pct}%` }} /></div>}
    {card.problem && <div className="nb-problem">
      <span>{card.problem}</span>
      {card.action && <button type="button" onClick={(event) => { event.stopPropagation(); card.action!.run(); }}>
        {card.action.label}</button>}
    </div>}
    {live && <footer>
      <span>{kids && trip!.status === "active" ? <><b>{kids.aboard}</b> of {kids.total} on{kids.missing ? <em className="nb-miss"> · {kids.missing} not checked</em> : null}</>
        : kids ? <><b>{kids.total}</b> {plural(kids.total, "kid", "kids")}</> : null}</span>
      <span className="nb-crew">
        {trip!.assignedStaff ? trip!.assignedStaff.displayName : <em>No lead</em>}
        {trip!.driver && (driverPhone
          ? <a href={`tel:${driverPhone}`} onClick={(event) => event.stopPropagation()}>Call driver</a>
          : <span className="nb-dim"> · {trip!.driver.name}</span>)}
      </span>
    </footer>}
  </article>;
}

// ---------- Page ----------

export function DispatchPage() {
  const { isAdmin, toast } = useOps();
  const navigate = useNavigate();
  const today = localDate(new Date());
  const board = useBoard(today, { routes: true, staff: true });
  const check = useCheckBoard(true, 15_000);
  const now = useNow();
  const actions = useTripActions(board.reload, toast);
  const tripAlerts = useTripAlerts(true);
  const [params, setParams] = useSearchParams();
  const [overlay, setOverlay] = useState<"plan" | "trip" | null>(null);
  const [coverage, setCoverage] = useState<RiderCoverage | null>(null);

  // Kids with no AM or PM route never show up on a bus, so check the roster directly.
  useEffect(() => {
    if (!isAdmin) { setCoverage(null); return; }
    const controller = new AbortController();
    const load = () => getJson("/api/families/coverage", riderCoverageSchema, controller.signal)
      .then(setCoverage).catch(() => { /* optional; the board works without it */ });
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 60_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [isAdmin]);

  const rows = useMemo(() => fleetRows(board.buses, board.trips, now), [board.buses, board.trips, now]);
  const colorOf = useMemo(() => busColors(board.buses), [board.buses]);
  const selected = rowForTrip(rows, params.get("trip"));

  function openTrip(id: string) {
    setParams((current) => { const next = new URLSearchParams(current); next.set("trip", id); return next; }, { replace: true });
    setOverlay("trip");
  }

  const kids = (tripId: string) => {
    const trip = check.trips.find((item) => item.id === tripId);
    if (!trip) return null;
    const c = counts(trip);
    // In the morning a kid can still be waiting at a later stop; only those the bus already passed are missing.
    const missing = trip.riders.filter((rider) => missed(trip, rider)).length;
    return { aboard: c.aboard, total: c.total, missing };
  };

  const cards = rows.map((row) => describe(row, now, openTrip, (trip) => actions.request(trip, "start")))
    .sort((a, b) => a.rank - b.rank ||
      (a.trip && b.trip ? Date.parse(a.trip.departureAt) - Date.parse(b.trip.departureAt) : 0) ||
      a.row.bus.label.localeCompare(b.row.bus.label, undefined, { numeric: true }));
  const shown = cards.filter((card) => card.trip);
  const idle = cards.filter((card) => !card.trip);

  const running = board.trips.filter((trip) => trip.status === "active");
  const needYou = cards.filter((card) => card.tone === "bad" || card.tone === "warn").length;
  const nextUp = cards.filter((card) => card.trip?.status === "planned" && card.rank === 3)
    .sort((a, b) => Date.parse(a.trip!.departureAt) - Date.parse(b.trip!.departureAt))[0];
  const finished = board.trips.filter((trip) => trip.status === "completed").length;

  // Things that aren't one bus: emergencies, notes from crews, kid checks, kids with no bus.
  const emergencies = tripAlerts.open.filter((alert) => alert.kind === "emergency");
  const updates = tripAlerts.open.filter((alert) => alert.kind === "update");
  const resolveAlert = (id: string) => { void tripAlerts.resolve(id).catch((cause) => toast(message(cause, "Could not mark it handled."))); };
  const kidChecks = check.trips.flatMap((trip) => checkAlerts(trip, now).filter((alert) => alert.sev === "high").map((alert) => ({ ...alert, tripId: trip.id, bus: trip.busLabel })));
  const noRoute = coverage?.noRoute ?? [];
  useAttentionSignal(needYou + emergencies.length + kidChecks.length);

  // One sentence a person can read from across the room.
  const kidWord = kidChecks.length ? `${kidChecks.length} ${plural(kidChecks.length, "kid", "kids")}` : "";
  const busWord = needYou ? `${needYou} ${plural(needYou, "bus", "buses")}` : "";
  const headline = needYou || kidChecks.length
    ? `${[busWord, kidWord].filter(Boolean).join(" and ")} ${needYou + kidChecks.length === 1 ? "needs" : "need"} you`
    : running.length ? "All buses OK" : nextUp ? "No buses out" : "Nothing running today";
  const sub = [
    running.length ? `${running.length} on the road` : null,
    nextUp ? `next leaves ${time(nextUp.trip!.departureAt)} (${nextUp.row.bus.label})` : null,
    finished ? `${finished} done` : null
  ].filter(Boolean).join(" · ");

  const overlayView = overlay && <Overlay onClose={() => setOverlay(null)}>
    {overlay === "plan"
      ? <><p className="eyebrow">Dispatch</p><h2 className="dt">Add a trip</h2>
        <PlanTripForm buses={board.buses} routes={board.routes} onPlanned={(planned) => {
          setOverlay(null);
          toast(planned.day === today ? `Trip added for ${planned.busLabel}.`
            : `Trip added for ${dayName(planned.day)}, ${dateLabel(planned.day)}. It shows here that day.`);
          board.reload();
        }} /></>
      : selected ? <TripDetail row={selected.row} trip={selected.trip} staff={board.staff} drivers={board.drivers}
        buses={board.buses} routes={board.routes} now={now} actions={actions}
        onEdited={() => board.reload()} editable onOpenTrip={openTrip} onChanged={board.reload}
        toast={toast} riders={kids(selected.trip.id)} />
        : <NoMatch>That trip isn't on today.</NoMatch>}
    {overlay === "trip" && selected && (() => {
      const ride = check.trips.find((trip) => trip.id === selected.trip.id);
      return ride ? <RideCheck trip={ride} now={now} color={colorOf(ride.busId)} onChanged={check.reload} toast={toast} /> : null;
    })()}
  </Overlay>;

  return <div className="nb">
    <header className={`nb-head ${needYou || kidChecks.length ? "bad" : ""}`}>
      <div>
        <p className="nb-clock">{time(now)}</p>
        <h1>{headline}</h1>
        {sub && <p className="nb-sub">{sub}</p>}
      </div>
      <div className="nb-head-acts">
        <LivePill state={board.live} />
        <button type="button" className="btn" onClick={() => setOverlay("plan")}>+ Add trip</button>
      </div>
    </header>

    <ErrorNote text={board.error} />
    {board.loading && <p className="hint">Loading buses…</p>}

    {emergencies.map((alert) => <section key={alert.id} className="em-banner" role="alert">
      <div><span>Emergency · {alert.busLabel} · {time(alert.createdAt)}</span>
        <b>{alert.label}</b>
        <p>{alert.sentBy}{alert.note ? `: "${alert.note}"` : ""}</p>
        {(() => {
          const onBoard = check.trips.find((trip) => trip.id === alert.tripId)?.riders.filter((rider) => rider.state === "aboard") ?? [];
          return onBoard.length ? <p className="em-kids"><b>{onBoard.length} {plural(onBoard.length, "kid", "kids")} on board:</b> {onBoard.map((rider) => `${rider.givenName} ${rider.familyName}`).join(", ")}</p> : null;
        })()}</div>
      <div className="em-acts">
        <button type="button" className="btn sm" onClick={() => openTrip(alert.tripId)}>Show bus</button>
        {alert.latitude !== null && alert.longitude !== null &&
          <a className="btn sm" target="_blank" rel="noreferrer" href={`https://www.google.com/maps?q=${alert.latitude},${alert.longitude}`}>Where they are</a>}
        <button type="button" className="btn sm btn-primary" onClick={() => resolveAlert(alert.id)}>Handled</button>
      </div>
    </section>)}

    {(updates.length > 0 || kidChecks.length > 0 || noRoute.length > 0) && <ul className="nb-notes">
      {updates.map((alert) => <li key={alert.id}>
        <span><b>{alert.busLabel}:</b> {alert.label}{alert.note ? ` "${alert.note}"` : ""} <span className="nb-dim">{alert.sentBy}, {time(alert.createdAt)}</span></span>
        <button type="button" onClick={() => resolveAlert(alert.id)}>Got it</button>
      </li>)}
      {kidChecks.length > 0 && <li className="bad">
        <span><b>{kidChecks[0].bus}:</b> {kidChecks[0].text}{kidChecks.length > 1 ? ` (and ${kidChecks.length - 1} more)` : ""}</span>
        <button type="button" onClick={() => openTrip(kidChecks[0].tripId)}>Open bus</button>
      </li>}
      {noRoute.length > 0 && <li className="bad">
        <span><b>{noRoute.length} {plural(noRoute.length, "kid has", "kids have")} no bus:</b> {noRoute.slice(0, 3).map((rider) => rider.name).join(", ")}{noRoute.length > 3 ? ` and ${noRoute.length - 3} more` : ""}</span>
        <button type="button" onClick={() => navigate("/families?attention=1")}>Fix</button>
      </li>}
    </ul>}

    {shown.length
      ? <div className="nb-grid">{shown.map((card) =>
        <BusCard key={card.row.bus.id} card={card} kids={card.trip ? kids(card.trip.id) : null}
          onOpen={() => card.trip && openTrip(card.trip.id)} />)}</div>
      : !board.loading && <div className="nb-empty">
        <p>No trips today.</p>
        <button type="button" className="btn btn-primary" onClick={() => setOverlay("plan")}>+ Add trip</button>
      </div>}

    {idle.length > 0 && <p className="nb-idle">Not out today: {idle.map((card) => card.row.bus.label).join(", ")}</p>}

    {running.length > 0 && <section className="nb-map">
      <Suspense fallback={<div className="mapfill" />}>
        <DispatchMap trips={running} colorForBus={colorOf} selectedTripId={null} onSelect={openTrip} now={now} fixedAll />
      </Suspense>
    </section>}

    {finished > 0 && <p className="nb-idle"><Link to="/transit">Earlier trips today</Link></p>}
    {overlayView}
  </div>;
}

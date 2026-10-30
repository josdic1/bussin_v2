import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { createPlannedTripSchema, riderCoverageSchema, type BoardTrip, type Bus, type RiderCoverage, type Route } from "@bussin/shared";
import { getJson, message, send } from "../ops/api";
import { dateLabel, dayName, localDate, plural, shiftDay, time, routeWithPeriod } from "../ops/format";
import {
  busColors, fleetRows, severityRank, type Alert, type BusRow
} from "../ops/fleetModel";
import { Overlay, useOps } from "../ops/OpsShell";
import { ErrorNote, Head, LivePill, NoMatch, Seg, Tile } from "../ops/ui";
import { useBoard, useNow } from "../ops/useBoard";
import { useTripActions } from "../ops/useTripActions";
import { alerts as checkAlerts, counts } from "../check/checkModel";
import { useCheckBoard } from "../check/useCheckBoard";
import { TripDetail } from "./TripDetail";
import { useAttentionSignal } from "./attentionSignal";
import { LiveBoard } from "./LiveBoard";
import { useTripAlerts } from "./useTripAlerts";


function rowForTrip(rows: BusRow[], tripId: string | null) {
  if (!tripId) return null;
  for (const row of rows) {
    const trip = row.trips.find((item) => item.id === tripId);
    if (trip) return { row, trip };
  }
  return null;
}

export function PlanTripForm({ buses, routes, day, onPlanned }: {
  buses: Bus[]; routes: Route[]; day: string; onPlanned: (trip: { busLabel: string; day: string }) => void;
}) {
  const today = localDate(new Date());
  const [busId, setBusId] = useState("");
  const [routeId, setRouteId] = useState("");
  const [date, setDate] = useState(day < today ? today : day);
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
    if (!parsed.success) { setError("Select a bus, route and departure time."); return; }
    setSaving(true);
    setError("");
    try {
      await send("POST", "/api/dispatch/trips", parsed.data, "Could not plan trip.");
      onPlanned({ busLabel: activeBuses.find((bus) => bus.id === busId)?.label ?? "the bus", day: date });
    } catch (cause) {
      setError(message(cause, "Could not plan trip."));
    } finally {
      setSaving(false);
    }
  }

  return <form className="planf" onSubmit={(event) => void submit(event)} noValidate>
    {!activeBuses.length && <p className="hint">Add a bus in Fleet first.</p>}
    {!usableRoutes.length && <p className="hint">Add a route with stops in Routes first.</p>}
    <div className="ctl-row"><label htmlFor="plan-bus">Bus</label>
      <select id="plan-bus" value={busId} onChange={(event) => setBusId(event.target.value)}>
        <option value="">Choose a bus</option>
        {activeBuses.map((bus) => <option key={bus.id} value={bus.id}>{bus.label}</option>)}
      </select></div>
    <div className="ctl-row"><label htmlFor="plan-route">Route</label>
      <select id="plan-route" value={routeId} onChange={(event) => setRouteId(event.target.value)}>
        <option value="">Choose a route</option>
        {usableRoutes.map((route) => <option key={route.id} value={route.id}>
          {route.name} · {route.servicePeriod} ({route.stops.length} stops)</option>)}
      </select></div>
    <div className="rf2">
      <div className="ctl-row"><label htmlFor="plan-date">Date</label>
        <input id="plan-date" type="date" value={date} min={today} onChange={(event) => setDate(event.target.value)} /></div>
      <div className="ctl-row"><label htmlFor="plan-time">Departure time</label>
        <input id="plan-time" type="time" value={clock} onChange={(event) => setClock(event.target.value)} /></div>
    </div>
    <ErrorNote text={error} />
    <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? "Planning…" : "Plan trip"}</button>
    <p className="hint">Runs every week? Add it once in <Link to="/lines">Lines</Link> instead.</p>
  </form>;
}

/** Dispatch is now: today, and tomorrow for planning. Earlier days live in Transit. */
function DaySeg({ day, setDay }: { day: string; setDay: (day: string) => void }) {
  const today = localDate(new Date());
  return <Seg label="Day" value={day} onChange={setDay} items={[[today, "Today"], [shiftDay(today, 1), "Tomorrow"]]} />;
}



/** Most urgent first. "All clear" rows only show when nothing else does. */
function attentionList(cards: Card[]) {
  const rank = { high: 0, med: 1, clear: 2 } as const;
  const real = cards.filter((card) => card.sev !== "clear");
  return real.length ? [...real].sort((a, b) => rank[a.sev] - rank[b.sev]) : cards.slice(0, 1);
}

type Card = { key: string; sev: "high" | "med" | "clear"; title: string; pill: string; text: string; actions: { label: string; primary?: boolean; run: () => void }[] };

function alertCard(row: BusRow, alert: Alert, open: (id: string) => void, start: (trip: BoardTrip) => void): Card {
  const trip = row.trip!;
  const actions: Card["actions"] = [{ label: alert.kind === "nodriver" ? "Assign crew" : "Open bus", primary: true, run: () => open(trip.id) }];
  if ((alert.kind === "late" || alert.kind === "due") && trip.assignedStaff) actions.push({ label: "Start trip", run: () => start(trip) });
  const text = alert.kind === "gps"
    ? `${alert.text}. ${trip.assignedStaff ? `${trip.assignedStaff.displayName}'s phone` : "The phone"} is not sending location.`
    : alert.kind === "nodriver" ? `${routeWithPeriod(trip.routeName, trip.servicePeriod)} leaves ${time(trip.departureAt)}. ${alert.text}.`
      : `${routeWithPeriod(trip.routeName, trip.servicePeriod)} was scheduled for ${time(trip.departureAt)}. ${alert.text.replace(/\.$/, "")}.`;
  return {
    key: `${row.bus.id}-${alert.kind}-${alert.short}`, sev: alert.sev, title: `${row.bus.label} · ${alert.short}`,
    pill: alert.sev === "high" ? "Urgent" : `Before ${time(trip.departureAt)}`, text, actions
  };
}

export function DispatchPage() {
  const { mode, isAdmin, toast } = useOps();
  const [coverage, setCoverage] = useState<RiderCoverage | null>(null);
  const navigate = useNavigate();
  const today = localDate(new Date());
  const [day, setDay] = useState(today);
  // A trip saved for a later date: say where it is instead of leaving the two-day view.
  const showDay = (target: string) => {
    if (target === today || target === shiftDay(today, 1)) setDay(target);
    else toast(`Saved for ${dayName(target)}, ${dateLabel(target)}. It shows here the day before, and in Transit now.`);
  };
  const board = useBoard(day, { routes: true, staff: true });

  // Riders with no AM or PM route never show up on a bus, so check the roster directly.
  useEffect(() => {
    if (!isAdmin) { setCoverage(null); return; }
    const controller = new AbortController();
    const load = () => getJson("/api/families/coverage", riderCoverageSchema, controller.signal)
      .then(setCoverage).catch(() => { /* the card is a helper; the board still works without it */ });
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 60_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [isAdmin]);
  const check = useCheckBoard(day === today, 15_000);
  const now = useNow();
  const actions = useTripActions(board.reload, toast);
  const [params, setParams] = useSearchParams();
  const [overlay, setOverlay] = useState<"plan" | "trip" | null>(null);

  const rows = useMemo(() => fleetRows(board.buses, board.trips, now)
    .sort((a, b) => severityRank(a) - severityRank(b) || a.bus.label.localeCompare(b.bus.label, undefined, { numeric: true })),
  [board.buses, board.trips, now]);
  const colorOf = useMemo(() => busColors(board.buses), [board.buses]);

  const paramTrip = params.get("trip");
  const selected = rowForTrip(rows, paramTrip);

  function select(id: string) {
    setParams((current) => { const next = new URLSearchParams(current); next.set("trip", id); return next; }, { replace: true });
  }
  function openTrip(id: string) {
    select(id);
    setOverlay("trip");
  }


  const riderCount = (tripId: string) => {
    const trip = check.trips.find((item) => item.id === tripId);
    if (!trip) return null;
    const c = counts(trip);
    return { aboard: c.aboard, total: c.total };
  };

  const attention = rows.filter((row) => row.alerts.length);
  const running = rows.filter((row) => row.trip?.status === "active");
  const later = rows.filter((row) => row.trip?.status === "planned" && Date.parse(row.trip.departureAt) > now)
    .sort((a, b) => Date.parse(a.trip!.departureAt) - Date.parse(b.trip!.departureAt));
  const activeBuses = rows.filter((row) => row.bus.active);
  const stale = rows.filter((row) => row.status === "GPS STALE").length;
  const aboard = check.trips.filter((trip) => trip.status === "active").reduce((sum, trip) => sum + counts(trip).aboard, 0);
  const high = attention.filter((row) => row.alerts.some((alert) => alert.sev === "high")).length;
  const tripAlerts = useTripAlerts(day === today);
  const emergencies = tripAlerts.open.filter((alert) => alert.kind === "emergency");
  const resolveAlert = (id: string) => { void tripAlerts.resolve(id).catch((cause) => toast(message(cause, "Could not mark it handled."))); };
  useAttentionSignal(day === today ? high + emergencies.length : 0);

  const cards: Card[] = attention.map((row) => alertCard(row, row.alerts[0], openTrip, (trip) => actions.request(trip, "start")));
  if (day === today) {
    const decisions = check.trips.flatMap((trip) => checkAlerts(trip, now).map((alert) => ({ trip, alert })));
    const urgent = decisions.filter((item) => item.alert.sev === "high");
    if (decisions.length) {
      const first = urgent[0] ?? decisions[0];
      cards.push({
        key: "ridecheck", sev: urgent.length ? "high" : "med",
        title: decisions.length === 1 ? first.alert.short : `${decisions.length} Ride Check decisions`,
        pill: first.trip.busLabel,
        text: decisions.length === 1 ? first.alert.text : `${urgent.length} urgent. First: ${first.alert.text}`,
        actions: [{ label: "Resolve in Ride Check", primary: true, run: () => navigate("/check") }]
      });
    } else if (!check.loading && check.trips.length) {
      cards.push({ key: "ridecheck", sev: "clear", title: "All riders accounted for", pill: "Clear",
        text: "No unresolved rider checks across today's trips.", actions: [{ label: "View Ride Check", run: () => navigate("/check") }] });
    }
  }
  if (coverage && coverage.noRoute.length) {
    const names = coverage.noRoute.map((rider) => rider.name);
    const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? ` and ${names.length - 3} more` : "");
    cards.unshift({
      key: "noroute", sev: "high",
      title: names.length === 1 ? "1 rider has no bus route" : `${names.length} riders have no bus route`,
      pill: "Riders",
      text: `${shown}: no AM or PM stop, so no bus will pick them up.`,
      actions: [{ label: "Fix in Riders", primary: true, run: () => navigate("/families?attention=1") }]
    });
  }
  // Updates from the crews: running late, bathroom stop. Emergencies get the red banner instead.
  for (const alert of tripAlerts.open.filter((item) => item.kind === "update")) {
    cards.unshift({
      key: `crew-${alert.id}`, sev: "med", title: `${alert.busLabel} · ${alert.label}`, pill: "From the bus",
      text: `${alert.sentBy} at ${time(alert.createdAt)}${alert.note ? `: "${alert.note}"` : "."}`,
      actions: [{ label: "Got it", primary: true, run: () => resolveAlert(alert.id) }, { label: "Open bus", run: () => openTrip(alert.tripId) }]
    });
  }
  if (!cards.length && !board.loading) {
    cards.push({ key: "none", sev: "clear", title: "Nothing needs you", pill: "Clear", text: "Every bus is on schedule and reporting.", actions: [] });
  }


  const detail = (id: string) => {
    const found = rowForTrip(rows, id);
    return found ? <TripDetail row={found.row} trip={found.trip} staff={board.staff} drivers={board.drivers} buses={board.buses} routes={board.routes} now={now} actions={actions}
      onEdited={(departureAt) => { showDay(localDate(new Date(departureAt))); board.reload(); }}
      editable={day === today} onOpenTrip={openTrip} onChanged={board.reload} toast={toast} riders={riderCount(found.trip.id)} />
      : <NoMatch>That trip is not on this day.</NoMatch>;
  };

  const overlayView = overlay && <Overlay onClose={() => setOverlay(null)}>
    {overlay === "plan"
      ? <><p className="eyebrow">Dispatch</p><h2 className="dt">Plan a trip</h2>
        <PlanTripForm buses={board.buses} routes={board.routes} day={day} onPlanned={(planned) => {
          setOverlay(null);
          toast(`Trip planned on ${planned.busLabel}.`);
          showDay(planned.day);
          board.reload();
        }} /></>
      : selected ? detail(selected.trip.id) : <NoMatch>Select a bus.</NoMatch>}
  </Overlay>;



  const issues = cards.filter((card) => card.sev !== "clear");
  return <>
    <Head eyebrow="Operations" title="Dispatch"
      sub={day === today ? "What needs attention now, then everything currently moving." : `${dayName(day)}, ${dateLabel(day)}`}
      actions={<>
        <LivePill state={board.live} />
        {mode === "desktop" && <DaySeg day={day} setDay={setDay} />}
        <button type="button" className="btn btn-primary" onClick={() => setOverlay("plan")}>+ Plan trip</button>
      </>} />
    {mode !== "desktop" && <DaySeg day={day} setDay={setDay} />}
    <ErrorNote text={board.error} />
    {board.loading && <p className="hint">Loading buses…</p>}
    {emergencies.map((alert) => <section key={alert.id} className="em-banner" role="alert">
      <div><span>Emergency · {alert.busLabel} · {time(alert.createdAt)}</span>
        <b>{alert.label}</b>
        <p>{alert.sentBy}, {routeWithPeriod(alert.routeName, alert.servicePeriod)}{alert.note ? `: "${alert.note}"` : ""}</p></div>
      <div className="em-acts">
        <button type="button" className="btn sm" onClick={() => openTrip(alert.tripId)}>Show bus</button>
        {alert.latitude !== null && alert.longitude !== null &&
          <a className="btn sm" target="_blank" rel="noreferrer" href={`https://www.google.com/maps?q=${alert.latitude},${alert.longitude}`}>Where they are</a>}
        <button type="button" className="btn sm btn-primary" onClick={() => resolveAlert(alert.id)}>Handled</button>
      </div>
    </section>)}

    <div className="tiles">
      <Tile label="Needs attention" value={issues.length} className={issues.length ? "bad" : "good"}
        sub={`${issues.filter((card) => card.sev === "high").length} urgent · ${issues.filter((card) => card.sev !== "high").length} follow-up`} />
      <Tile label="On the road" value={running.length}
        sub={day === today ? `${aboard} ${plural(aboard, "rider", "riders")} aboard` : "Buses on the road"} />
      <Tile label="Coming up" value={later.length} sub={later[0] ? `Next at ${time(later[0].trip!.departureAt)}` : "Nothing else planned"} />
      <Tile label="Fleet ready" value={`${activeBuses.length - stale} / ${activeBuses.length}`}
        sub={stale ? `${stale} GPS stale` : "All reporting"} />
    </div>

    <div className="sec-h"><h2>Needs attention</h2><span>Most urgent first</span></div>
    <div className="attn-list">{attentionList(cards).map((card) => <div key={card.key} className={`attn-row ${card.sev}`}>
      <span className={`attn-chip ${card.sev}`}>{card.sev === "high" ? "Urgent" : card.sev === "clear" ? "Clear" : card.pill === "From the bus" ? "From bus" : "Follow up"}</span>
      <b>{card.title}</b>
      <span className="attn-text">{card.text}</span>
      <span className="attn-acts">{card.actions.map((action) =>
        <button key={action.label} type="button" className={action.primary ? "primary" : ""} onClick={action.run}>{action.label}</button>)}</span>
    </div>)}</div>

    <LiveBoard trips={board.trips} colorOf={colorOf} now={now} isToday={day === today} riders={riderCount}
      onOpen={openTrip} onStart={(trip) => actions.request(trip, "start")} onTransit={() => navigate("/transit")} />
    {overlayView}
  </>;
}

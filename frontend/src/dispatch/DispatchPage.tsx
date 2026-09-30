import { lazy, Suspense, useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { createPlannedTripSchema, type BoardTrip, type Bus, type Route } from "@bussin/shared";
import { message, send } from "../ops/api";
import { dateLabel, dayName, localDate, plural, shiftDay, time, age, routeWithPeriod } from "../ops/format";
import {
  busColors, fleetRows, nextEta, severityRank, stopsDone, type Alert, type BusRow
} from "../ops/fleetModel";
import { Overlay, useOps } from "../ops/OpsShell";
import { Dot, ErrorNote, Head, LivePill, NoMatch, Seg, Tile } from "../ops/ui";
import { useBoard, useNow } from "../ops/useBoard";
import { useTripActions } from "../ops/useTripActions";
import { alerts as checkAlerts, counts } from "../check/checkModel";
import { useCheckBoard } from "../check/useCheckBoard";
import { TripDetail, TripPill } from "./TripDetail";

const DispatchMap = lazy(async () => ({ default: (await import("./DispatchMap")).DispatchMap }));

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
  </form>;
}

function DaySeg({ day, setDay }: { day: string; setDay: (day: string) => void }) {
  const today = localDate(new Date());
  return <Seg label="Day" value={day} onChange={setDay} items={[
    [shiftDay(today, -1), "Yesterday"], [today, "Today"], [shiftDay(today, 1), "Tomorrow"]]} />;
}

const GROUPS: [string, (row: BusRow) => boolean][] = [
  ["Needs attention", (row) => row.alerts.length > 0],
  ["Running", (row) => !row.alerts.length && row.trip?.status === "active"],
  ["Later", (row) => !row.alerts.length && row.trip?.status === "planned"],
  ["Finished or idle", (row) => !row.alerts.length && (!row.trip || row.trip.status === "completed" || row.trip.status === "cancelled")]
];

function ListRow({ row, selected, now, onSelect }: { row: BusRow; selected: boolean; now: number; onSelect: (id: string) => void }) {
  const trip = row.trip;
  const eta = trip ? nextEta(trip) : null;
  const first = row.alerts[0];
  const sub = !trip ? "No trip on this day"
    : trip.status === "active" ? `Running · ${trip.assignedStaff?.displayName ?? "No driver"} · ${stopsDone(trip)} of ${trip.stops.length} stops`
      : trip.status === "planned" ? `Planned · ${trip.assignedStaff?.displayName ?? "No driver"} · ${time(trip.departureAt)}`
        : trip.status === "completed" ? `Finished ${trip.routeName}` : `Cancelled ${trip.routeName}`;
  const right = first
    ? <span className={`pill ${first.sev === "high" ? "bad" : "warn"}`}>{first.short}</span>
    : trip?.status === "active"
      ? <><b>{eta ? `ETA ${time(eta.etaAt)}` : "ETA pending"}</b><small>GPS {trip.location ? age(trip.location.observedAt, now) : "none"}</small></>
      : trip?.status === "planned" ? <span className="pill neutral">{time(trip.departureAt)}</span>
        : trip ? <TripPill status={trip.status} /> : <span className="pill neutral">Idle</span>;
  return <button type="button" disabled={!trip} className={`li2${selected ? " sel" : ""}`}
    style={{ "--c": row.color } as CSSProperties} onClick={() => trip && onSelect(trip.id)}>
    <span className="bar" />
    <span><strong>{row.bus.label}{trip ? ` · ${routeWithPeriod(trip.routeName, trip.servicePeriod)}` : ""}</strong><small>{sub}</small></span>
    <span className="right">{right}</span>
  </button>;
}

type Card = { key: string; sev: "high" | "med" | "clear"; title: string; pill: string; text: string; actions: { label: string; primary?: boolean; run: () => void }[] };

function alertCard(row: BusRow, alert: Alert, open: (id: string) => void, start: (trip: BoardTrip) => void): Card {
  const trip = row.trip!;
  const actions: Card["actions"] = [{ label: alert.kind === "nodriver" ? "Assign driver" : "Open bus", primary: true, run: () => open(trip.id) }];
  if ((alert.kind === "late" || alert.kind === "due") && trip.assignedStaff) actions.push({ label: "Start trip", run: () => start(trip) });
  const text = alert.kind === "gps"
    ? `${alert.text}. ${trip.assignedStaff ? `${trip.assignedStaff.displayName}'s phone` : "The phone"} is not sending location.`
    : alert.kind === "nodriver" ? `${routeWithPeriod(trip.routeName, trip.servicePeriod)} leaves ${time(trip.departureAt)} with no assigned staff.`
      : `${routeWithPeriod(trip.routeName, trip.servicePeriod)} was scheduled for ${time(trip.departureAt)}. ${alert.text}.`;
  return {
    key: `${row.bus.id}-${alert.kind}`, sev: alert.sev, title: `${row.bus.label} · ${alert.short}`,
    pill: alert.sev === "high" ? "Urgent" : `Before ${time(trip.departureAt)}`, text, actions
  };
}

export function DispatchPage() {
  const { mode, role, toast } = useOps();
  const navigate = useNavigate();
  const today = localDate(new Date());
  const [day, setDay] = useState(today);
  const board = useBoard(day, { routes: true, staff: true });
  const monitor = role === "monitor";
  const check = useCheckBoard(monitor && day === today, 15_000);
  const now = useNow();
  const actions = useTripActions(board.reload, toast);
  const [params, setParams] = useSearchParams();
  const [overlay, setOverlay] = useState<"plan" | "trip" | null>(null);
  const [phoneView, setPhoneView] = useState<"board" | "map">("board");

  const rows = useMemo(() => fleetRows(board.buses, board.trips, now)
    .sort((a, b) => severityRank(a) - severityRank(b) || a.bus.label.localeCompare(b.bus.label, undefined, { numeric: true })),
  [board.buses, board.trips, now]);
  const colorOf = useMemo(() => busColors(board.buses), [board.buses]);
  const ordered = GROUPS.flatMap(([, test]) => rows.filter(test)).filter((row) => row.trip);

  const paramTrip = params.get("trip");
  const selected = rowForTrip(rows, paramTrip) ?? (ordered[0] ? { row: ordered[0], trip: ordered[0].trip! } : null);

  function select(id: string) {
    setParams((current) => { const next = new URLSearchParams(current); next.set("trip", id); return next; }, { replace: true });
  }
  function openTrip(id: string) {
    select(id);
    if (mode !== "desktop") setOverlay("trip");
  }

  // J / K move through buses in list order.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest("input,select,textarea")) return;
      if (event.key !== "j" && event.key !== "k") return;
      if (!ordered.length) return;
      const index = ordered.findIndex((row) => row.trip!.id === selected?.trip.id);
      const next = ordered[(index + (event.key === "j" ? 1 : ordered.length - 1)) % ordered.length];
      select(next.trip!.id);
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  });

  const riderCount = (tripId: string) => {
    if (!monitor) return null;
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

  const cards: Card[] = attention.map((row) => alertCard(row, row.alerts[0], openTrip, (trip) => actions.request(trip, "start")));
  if (monitor && day === today) {
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
  if (!cards.length && !board.loading) {
    cards.push({ key: "none", sev: "clear", title: "Nothing needs you", pill: "Clear", text: "Every bus is on schedule and reporting.", actions: [] });
  }

  const mapTrips = rows.flatMap((row) => row.trip && (row.trip.status === "active" || row.trip.status === "planned") ? [row.trip] : []);
  if (selected && !mapTrips.some((trip) => trip.id === selected.trip.id)) mapTrips.push(selected.trip);

  const detail = (id: string) => {
    const found = rowForTrip(rows, id);
    return found ? <TripDetail row={found.row} trip={found.trip} staff={board.staff} now={now} actions={actions}
      editable={day === today} onOpenTrip={openTrip} onChanged={board.reload} toast={toast} riders={riderCount(found.trip.id)} />
      : <NoMatch>That trip is not on this day.</NoMatch>;
  };

  const overlayView = overlay && <Overlay onClose={() => setOverlay(null)}>
    {overlay === "plan"
      ? <><p className="eyebrow">Dispatch</p><h2 className="dt">Plan a trip</h2>
        <PlanTripForm buses={board.buses} routes={board.routes} day={day} onPlanned={(planned) => {
          setOverlay(null);
          toast(`Trip planned on ${planned.busLabel}.`);
          setDay(planned.day);
          board.reload();
        }} /></>
      : selected ? detail(selected.trip.id) : <NoMatch>Select a bus.</NoMatch>}
  </Overlay>;

  const map = <Suspense fallback={<div className="mapfill" />}>
    <DispatchMap trips={mapTrips} colorForBus={colorOf} selectedTripId={selected?.trip.id ?? null}
      onSelect={mode === "desktop" ? select : openTrip} now={now} />
  </Suspense>;

  const list = <>
    {!board.loading && !rows.length && <NoMatch>No buses yet. Add one in Fleet.</NoMatch>}
    {!board.loading && rows.length > 0 && !ordered.length && <NoMatch>No trips {dayName(day).toLowerCase()}.</NoMatch>}
    {GROUPS.map(([label, test]) => {
      const members = rows.filter(test);
      if (!members.length) return null;
      return <div key={label}>
        <div className="grp">{label} · {members.length}</div>
        {members.map((row) => <ListRow key={row.bus.id} row={row} now={now}
          selected={!!row.trip && selected?.trip.id === row.trip.id} onSelect={mode === "desktop" ? select : openTrip} />)}
      </div>;
    })}
  </>;

  return <>
    <Head eyebrow="Operations" title="Dispatch"
      sub={day === today ? "What needs attention now, then everything currently moving." : `${dayName(day)}, ${dateLabel(day)}`}
      actions={<>
        <LivePill state={board.live} />
        {mode === "desktop" && <DaySeg day={day} setDay={setDay} />}
        {mode === "desktop" && <input type="date" aria-label="Pick a day" className="daypick" value={day}
          onChange={(event) => { if (event.target.value) setDay(event.target.value); }} />}
        <button type="button" className="btn btn-primary" onClick={() => setOverlay("plan")}>+ Plan trip</button>
      </>} />
    {mode !== "desktop" && <DaySeg day={day} setDay={setDay} />}
    <ErrorNote text={board.error} />
    {board.loading && <p className="hint">Loading buses…</p>}

    <div className="tiles">
      <Tile label="Needs attention" value={attention.length} className={attention.length ? "bad" : "good"}
        sub={`${high} urgent · ${attention.length - high} follow-up`}
        onClick={attention[0]?.trip ? () => openTrip(attention[0].trip!.id) : undefined} />
      <Tile label="Running" value={running.length}
        sub={monitor && day === today ? `${aboard} ${plural(aboard, "rider", "riders")} aboard` : "Buses on the road"} />
      <Tile label="Later" value={later.length} sub={later[0] ? `Next at ${time(later[0].trip!.departureAt)}` : "Nothing else planned"} />
      <Tile label="Fleet ready" value={`${activeBuses.length - stale} / ${activeBuses.length}`}
        sub={stale ? `${stale} GPS stale` : "All reporting"} />
    </div>

    <div className="sec-h"><h2>Needs attention</h2><span>Only exceptions appear here</span></div>
    <div className="attn-grid">{cards.map((card) => <article key={card.key} className={`acard ${card.sev}`}>
      <div className="acard-top"><div className="acard-title"><Dot tone={card.sev === "high" ? "bad" : card.sev === "med" ? "warn" : "ok"} />{card.title}</div>
        <span className={`pill ${card.sev === "high" ? "bad" : card.sev === "med" ? "warn" : "ok"}`}>{card.pill}</span></div>
      <p>{card.text}</p>
      {card.actions.length > 0 && <div className="acts">{card.actions.map((action) =>
        <button key={action.label} type="button" className={`btn sm${action.primary ? " btn-primary" : ""}`} onClick={action.run}>{action.label}</button>)}</div>}
    </article>)}</div>

    <div className="sec-h"><h2>Live board</h2><span>{mode === "desktop" ? "List, map and detail share one selection" : "Tap a bus for details"}</span></div>
    {mode === "desktop" ? <div className="board">
      <div className="panel listpanel"><div className="panel-head"><h3>{dayName(day)}&rsquo;s buses</h3><span>Sorted by what needs you</span></div>{list}</div>
      <div className="panel mappanel"><div className="panel-head"><h3>Live map</h3><span>Road paths · buses glide between fixes</span></div>
        <div className="mapwrap">{map}</div></div>
      <div className="panel detailpanel"><div className="detail">{selected ? detail(selected.trip.id) : <NoMatch>Select a bus.</NoMatch>}</div></div>
    </div> : <>
      <Seg label="View" value={phoneView} onChange={setPhoneView} items={[["board", "List"], ["map", "Map"]]} />
      {phoneView === "map" ? <div className="mapwrap">{map}</div> : <div className="panel">{list}</div>}
    </>}
    {overlayView}
  </>;
}

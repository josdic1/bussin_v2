import { lazy, Suspense, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { createPlannedTripSchema, type BoardTrip, type Bus, type Route } from "@bussin/shared";
import { message, send } from "../ops/api";
import { dateLabel, dayName, localDate, plural, shiftDay, time, ageShort, routeWithPeriod } from "../ops/format";
import {
  busColors, currentStopIndex, etaText, fleetRows, gpsStale, nextAction, plainState, presence,
  severityRank, stopsDone, trackingText, type BusRow
} from "../ops/fleetModel";
import { Overlay, useOps } from "../ops/OpsShell";
import { Dot, ErrorNote, Head, LivePill, NoMatch, Plus, Seg, SRow, type Tone } from "../ops/ui";
import { useBoard, useNow } from "../ops/useBoard";
import { useTripActions, type TripActions } from "../ops/useTripActions";
import { ConfirmFor, StopMiniLine, TripDetail, TripPill } from "./TripDetail";

const DispatchMap = lazy(async () => ({ default: (await import("./DispatchMap")).DispatchMap }));

type OverlayState = { type: "plan" } | { type: "trip"; id: string } | null;

function AlertChips({ row }: { row: BusRow }) {
  return <>{row.alerts.map((alert) => <span key={alert.short} className={`od${alert.sev === "med" ? " med" : ""}`}>
    {alert.short.toUpperCase()}</span>)}</>;
}

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
    {!usableRoutes.length && <p className="hint">Add a route with stops in Fleet &rsaquo; Routes first.</p>}
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

function AdvCard({ row, trip, now, onOpen }: { row: BusRow; trip: BoardTrip; now: number; onOpen: () => void }) {
  const phone = presence(trip, now);
  const eta = etaText(trip);
  return <button type="button" className={`bc${row.alerts.length ? " attn" : ""}`} style={{ "--c": row.color } as CSSProperties} onClick={onOpen}>
    <div className="h"><strong>{row.bus.label}<span className="per">{trip.servicePeriod}</span></strong><TripPill status={trip.status} /></div>
    <div className="rt2">{trip.routeName}</div>
    <div className="tm"><span>{time(trip.departureAt)} · {trip.assignedStaff?.displayName ?? "Unassigned"}</span></div>
    {row.alerts.length > 0 && <div className="ch"><AlertChips row={row} /></div>}
    {phone && <p className={`pres ${phone.ok ? "ok" : "no"}`}>{phone.text}</p>}
    {eta && <p className="tk"><b>{eta}</b></p>}
    <StopMiniLine trip={trip} color={row.color} />
  </button>;
}

function SimpleCard({ row, now, actions, onDetails }: {
  row: BusRow; now: number; actions: TripActions; onDetails: () => void;
}) {
  const trip = row.trip!;
  const state = plainState(row, now);
  const index = trip.status === "active" ? currentStopIndex(trip) : -1;
  const stop = index >= 0 ? trip.stops[index] : null;
  const next = nextAction(trip);
  const phone = presence(trip, now);
  const actionLabel = next && {
    start: `Start ${row.bus.label}`,
    assign: "Assign a driver",
    arrive: `${row.bus.label} reached ${stop?.label ?? ""}`,
    depart: `${row.bus.label} left ${stop?.label ?? ""}`,
    complete: "Finish trip"
  }[next.kind];

  return <div className="scard">
    <h2><Dot tone="bad" />{row.bus.label}: {state.word}</h2>
    {trip.status === "active"
      ? <><p>{row.bus.label} is driving <b>{trip.routeName}</b>. It has reached {stopsDone(trip)} of {trip.stops.length} stops.</p>
        {stop && <p>Next stop: <b>{stop.label}</b>.</p>}</>
      : <p>{row.bus.label} is set for <b>{trip.routeName}</b>. It was due at {time(trip.departureAt)}.</p>}
    {row.alerts.map((alert) => <p key={alert.short} className="bad">{
      alert.kind === "gps" ? (row.latestGps ? `No GPS for ${ageShort(row.latestGps, now)}. Last seen ${time(row.latestGps)}.` : "No GPS has come in yet.")
        : alert.kind === "late" ? `It has not started. ${alert.short}.`
          : alert.kind === "due" ? "It is due to leave now." : "No driver is assigned."}</p>)}
    {phone && !phone.ok && <p className="bad">Driver&rsquo;s phone is not connected.</p>}
    {trip.assignedStaff && <p>Driver: <b>{trip.assignedStaff.displayName}</b>.</p>}
    {next && actionLabel && (next.kind === "assign"
      ? <button type="button" className="bigbtn" onClick={onDetails}>{actionLabel}</button>
      : <button type="button" className="bigbtn" disabled={actions.busy} onClick={() =>
        actions.request(trip, next.kind === "complete" ? "complete" : next.kind === "start" ? "start" : next.kind,
          "stopId" in next ? next.stopId : undefined)}>{actionLabel}</button>)}
    {(trip.status === "planned" || trip.status === "active") &&
      <button type="button" className="bigbtn red slim" onClick={() => actions.request(trip, "cancel")}>Cancel trip</button>}
    <button type="button" className="bigbtn out slim" onClick={onDetails}>See full details</button>
    <ConfirmFor trip={trip} actions={actions} />
  </div>;
}

function simpleRow(row: BusRow, now: number, open: (id: string) => void) {
  const trip = row.trip;
  const state = plainState(row, now);
  const tone: Tone = state.tone;
  if (!trip) return <SRow key={row.bus.id} tone=""><b>{row.bus.label}</b> has no trip today.</SRow>;
  const onClick = () => open(trip.id);
  if (trip.status === "active") return <SRow key={row.bus.id} tone={tone} onClick={onClick} small={etaText(trip) ?? ""}>
    <b>{row.bus.label}</b> is running {trip.routeName}.</SRow>;
  if (trip.status === "planned") return <SRow key={row.bus.id} tone={tone} onClick={onClick}
    small={`${trip.routeName}, ${trip.assignedStaff?.displayName ?? "no driver yet"}`}>
    <b>{row.bus.label}</b> leaves at {time(trip.departureAt)}.</SRow>;
  if (trip.status === "cancelled") return <SRow key={row.bus.id} tone="bad" onClick={onClick} small={trip.routeName}>
    <b>{row.bus.label}</b> was cancelled.</SRow>;
  return <SRow key={row.bus.id} tone="" onClick={onClick}><b>{row.bus.label}</b> finished {trip.routeName}.</SRow>;
}

export function DispatchPage() {
  const { mode, toast } = useOps();
  const today = localDate(new Date());
  const [chosenDay, setChosenDay] = useState(today);
  const day = mode === "simple" ? today : chosenDay;
  const board = useBoard(day, { routes: true, staff: true });
  const now = useNow();
  const actions = useTripActions(board.reload, toast);
  const [params, setParams] = useSearchParams();
  const [overlay, setOverlay] = useState<OverlayState>(null);
  const [phoneView, setPhoneView] = useState<"board" | "map">("board");

  const rows = useMemo(() => fleetRows(board.buses, board.trips, now)
    .sort((a, b) => severityRank(a) - severityRank(b)), [board.buses, board.trips, now]);
  const colorOf = useMemo(() => busColors(board.buses), [board.buses]);
  const withTrips = rows.filter((row) => row.trip);

  const paramTrip = params.get("trip");
  const selected = rowForTrip(rows, paramTrip) ?? (withTrips[0] ? { row: withTrips[0], trip: withTrips[0].trip! } : null);

  function select(id: string) {
    setParams((current) => { const next = new URLSearchParams(current); next.set("trip", id); return next; }, { replace: true });
  }
  function openTrip(id: string) {
    select(id);
    if (mode !== "desktop") setOverlay({ type: "trip", id });
  }

  const counts = {
    attention: rows.filter((row) => row.alerts.length).length,
    running: rows.filter((row) => row.trip?.status === "active").length
  };
  const mapTrips = rows.flatMap((row) => row.trip && (row.trip.status === "active" || row.trip.status === "planned") ? [row.trip] : []);
  if (selected && !mapTrips.some((trip) => trip.id === selected.trip.id)) mapTrips.push(selected.trip);

  const detail = (id: string, withGps = true) => {
    const found = rowForTrip(rows, id);
    return found ? <TripDetail row={found.row} trip={found.trip} staff={board.staff} now={now} actions={actions}
      editable onOpenTrip={openTrip} onChanged={board.reload} toast={toast} withGps={withGps} /> : <NoMatch>That trip is not on this day.</NoMatch>;
  };

  const overlayView = overlay && <Overlay onClose={() => setOverlay(null)}>
    {overlay.type === "plan"
      ? <><p className="eyebrow">DISPATCH</p><h2 className="dt">Plan a trip</h2>
        <PlanTripForm buses={board.buses} routes={board.routes} day={day} onPlanned={(planned) => {
          setOverlay(null);
          toast(`Trip planned on ${planned.busLabel}.`);
          if (mode !== "simple") setChosenDay(planned.day);
          board.reload();
        }} /></>
      : detail(overlay.id)}
  </Overlay>;

  const map = <Suspense fallback={<div className="mapfill" />}>
    <DispatchMap trips={mapTrips} colorForBus={colorOf} selectedTripId={selected?.trip.id ?? null}
      onSelect={select} now={now} />
  </Suspense>;

  const status = <>
    <ErrorNote text={board.error} />
    {board.loading && <p className="hint">Loading buses…</p>}
  </>;

  if (mode === "desktop") {
    const groups: [string, (row: BusRow) => boolean][] = [
      ["Needs attention", (row) => row.alerts.length > 0],
      ["Running", (row) => !row.alerts.length && row.trip?.status === "active"],
      ["Upcoming", (row) => !row.alerts.length && row.trip?.status === "planned"],
      ["Finished", (row) => !row.alerts.length && (!row.trip || row.trip.status === "completed" || row.trip.status === "cancelled")]
    ];
    return <>
      <Head eyebrow="DISPATCH" title="All buses" actions={<>
        <LivePill state={board.live} />
        <DaySeg day={day} setDay={setChosenDay} />
        <input type="date" aria-label="Pick a day" className="daypick" value={day}
          onChange={(event) => { if (event.target.value) setChosenDay(event.target.value); }} />
        <button type="button" className="btn btn-primary" onClick={() => setOverlay({ type: "plan" })}>Plan trip</button>
      </>} />
      {status}
      <div className="room">
        <div className="pane l">
          {!board.loading && !rows.length && <NoMatch>No buses yet. Add one in Fleet.</NoMatch>}
          {groups.map(([label, test]) => {
            const members = rows.filter(test);
            if (!members.length) return null;
            return <div key={label}>
              <div className="grp">{label} &middot; {members.length}</div>
              {members.map((row) => {
                const trip = row.trip;
                return <button key={row.bus.id} type="button" disabled={!trip}
                  className={`li2${trip && selected?.trip.id === trip.id ? " sel" : ""}`}
                  style={{ "--c": row.color } as CSSProperties} onClick={() => trip && select(trip.id)}>
                  <span className="bar" />
                  <span><strong>{row.bus.label}</strong> <small>{trip ? routeWithPeriod(trip.routeName, trip.servicePeriod) : "No trip"}</small></span>
                  {trip ? <TripPill status={trip.status} /> : <span />}
                  <small style={{ gridColumn: "2/span 2" }}>{trip ? `${time(trip.departureAt)} · ${trackingText(trip, now)}` : ""}</small>
                  {row.alerts.length > 0 && <span className="ch"><AlertChips row={row} /></span>}
                </button>;
              })}
            </div>;
          })}
        </div>
        <div className="pane c">
          {map}
          <div className="mapmsg">{selected ? `${selected.row.bus.label} selected. Click any route to switch.` : "Select a bus"}</div>
        </div>
        <div className="pane r">{selected ? detail(selected.trip.id) : <NoMatch>Select a bus.</NoMatch>}</div>
      </div>
      {overlayView}
    </>;
  }

  if (mode === "adv") {
    return <>
      <Head eyebrow="DISPATCH" title="All buses"
        sub={<>{dateLabel(day)} &middot; {counts.attention} need attention &middot; {counts.running} running</>}
        actions={<><LivePill state={board.live} /><Plus label="Plan trip" onClick={() => setOverlay({ type: "plan" })} /></>} />
      <DaySeg day={day} setDay={setChosenDay} />
      <Seg label="View" value={phoneView} onChange={setPhoneView} items={[["board", "Board"], ["map", "Map"]]} />
      {status}
      {phoneView === "map" ? <>
        <div className="mapbox">{map}</div>
        {selected && <AdvCard row={selected.row} trip={selected.trip} now={now} onOpen={() => openTrip(selected.trip.id)} />}
        <p className="hint">Tap a route on the map to switch bus.</p>
      </> : <>
        <div className="cards">{withTrips.map((row) =>
          <AdvCard key={row.bus.id} row={row} trip={row.trip!} now={now} onOpen={() => openTrip(row.trip!.id)} />)}</div>
        {!board.loading && !withTrips.length && <NoMatch>No trips on {dayName(day).toLowerCase()}.</NoMatch>}
        {rows.length > withTrips.length && <p className="hint">{rows.length - withTrips.length} {plural(rows.length - withTrips.length, "bus has", "buses have")} no trip on this day.</p>}
      </>}
      {overlayView}
    </>;
  }

  const need = rows.filter((row) => row.alerts.length && row.trip && (row.trip.status === "planned" || row.trip.status === "active" || gpsStale(row.trip, now)));
  const rest = rows.filter((row) => !need.includes(row));
  return <>
    <h1 className="sh1">What needs me</h1>
    {status}
    {need.length
      ? <p className="sline bad">{need.length} {plural(need.length, "thing needs you.", "things need you.")}</p>
      : !board.loading && <p className="sline ok">Nothing needs you right now. Every bus is fine.</p>}
    {need.map((row) => <SimpleCard key={row.bus.id} row={row} now={now} actions={actions}
      onDetails={() => openTrip(row.trip!.id)} />)}
    {rest.length > 0 && <><h2 className="sh2">Everything else</h2>
      <div className="sl">{rest.map((row) => simpleRow(row, now, openTrip))}</div></>}
    <div className="pin"><button type="button" className="bigbtn" onClick={() => setOverlay({ type: "plan" })}>Add a trip</button></div>
    {overlayView}
  </>;
}

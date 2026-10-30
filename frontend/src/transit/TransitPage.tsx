import { lazy, Suspense, useEffect, useMemo, useState, type CSSProperties } from "react";
import { Link } from "react-router";
import {
  busesResponseSchema, dispatchGpsAuditResponseSchema, historyResponseSchema,
  type Bus, type DispatchGpsAuditEntry, type HistoryTrip
} from "@bussin/shared";
import { getJson, message } from "../ops/api";
import {
  dateLabel, dayBounds, dayName, duration, localDate, MIN, plural, shiftDay, time, timeWithSeconds, routeWithPeriod } from "../ops/format";
import { busColors, busNumber } from "../ops/fleetModel";
import { Overlay, useOps } from "../ops/OpsShell";
import { CrewPills, ErrorNote, Head, NoMatch, Seg } from "../ops/ui";
import { useNow, usePolling } from "../ops/useBoard";
import "./transit.css";
import { DemoDeleteRide } from "../demo/DemoDeleteRide";

// The map only loads when someone opens Replay.
const Replay = lazy(() => import("./Replay").then((module) => ({ default: module.Replay })));

/*
 * History: the record of what ran. Today is for right now; this is for "did every bus run,
 * when, and what went wrong". Day view: one row per bus, its morning and afternoon runs side
 * by side. Week view: a grid of AM/PM dots per bus per day. Click any run for the full trip
 * and a replay of the drive.
 */

type Flag = { sev: "high" | "med"; text: string };
type TripView = HistoryTrip & {
  day: string; flags: Flag[]; delayMin: number; manual: number; automatic: number; corrections: number;
  done: number; durationMin: number | null; color: string; leftAt: string | null; finishedAt: string | null;
  health: "ok" | "warn" | "bad" | "open";
};
type Tab = "replay" | "events" | "stops" | "gps";
/** "Yesterday, Wed, Oct 28" for nearby days, plain "Mon, Oct 26" otherwise. */
function dayWords(day: string) {
  const name = dayName(day);
  return ["Today", "Yesterday", "Tomorrow"].includes(name) ? `${name}, ${dateLabel(day)}` : dateLabel(day);
}

type LogRow = { at: string; kind: string; text: string; sub?: string; method?: string | null; sev?: "high" | "med"; replaced?: boolean };

function buildView(trip: HistoryTrip, now: number, color: string): TripView {
  const flags: Flag[] = [];
  const delayMin = trip.startedAt ? Math.round((Date.parse(trip.startedAt) - Date.parse(trip.departureAt)) / MIN) : 0;
  const today = localDate(new Date(now));
  const day = localDate(new Date(trip.departureAt));
  if (trip.status === "cancelled") flags.push({ sev: "high", text: "Cancelled" });
  if (trip.status === "planned" && day < today) flags.push({ sev: "high", text: "Never started" });
  if (trip.status === "planned" && day === today) {
    const late = Math.floor((now - Date.parse(trip.departureAt)) / MIN);
    if (late >= 1) flags.push({ sev: "high", text: `Not started, ${late} min late` });
    if (!trip.assignedStaff) flags.push({ sev: "med", text: "No lead assigned" });
  }
  if (delayMin >= 5) flags.push({ sev: delayMin >= 10 ? "high" : "med", text: `Started ${delayMin} min late` });
  const manual = trip.stops.filter((stop) => stop.arrivalMethod === "manual" || stop.arrivalMethod === "override").length;
  if (manual) flags.push({ sev: "med", text: `${manual} tapped arrival${manual > 1 ? "s" : ""}` });
  const disputed = trip.stops.filter((stop) => stop.arrivalMethod === "override").length;
  if (disputed) flags.push({ sev: "high", text: `${disputed} arrival${disputed > 1 ? "s" : ""} tapped while GPS disagreed` });
  const corrections = trip.events.filter((event) => event.type === "correction").length;
  if (corrections) flags.push({ sev: "med", text: `${corrections} correction${corrections > 1 ? "s" : ""}` });
  if (trip.riders.unchecked && trip.status !== "planned" && trip.status !== "cancelled") {
    flags.push({ sev: "high", text: `${trip.riders.unchecked} ${trip.riders.unchecked === 1 ? "kid" : "kids"} never checked` });
  }
  if (trip.riders.stillAboard && trip.status === "completed") {
    flags.push({ sev: "high", text: `${trip.riders.stillAboard} still marked on bus` });
  }
  if (trip.status === "completed" && trip.riders.total > 0 && !trip.riders.sweptAt) flags.push({ sev: "med", text: "Bus not walked" });
  for (const alert of trip.alerts.filter((item) => item.kind === "emergency")) flags.push({ sev: "high", text: `Emergency: ${alert.label}` });
  for (const gap of trip.gps.gaps) flags.push({ sev: gap.durationSeconds >= 120 ? "high" : "med", text: `GPS gap ${duration(gap.durationSeconds)}` });
  if (trip.status === "active") {
    const silent = trip.gps.lastObservedAt ? now - Date.parse(trip.gps.lastObservedAt) : null;
    if (silent === null) flags.push({ sev: "high", text: "No GPS yet" });
    else if (silent > 60_000) flags.push({ sev: "high", text: `GPS silent ${duration(Math.round(silent / 1000)).replace(/ \d+s$/, "")}` });
  }
  const end = trip.endedAt ?? (trip.status === "active" ? new Date(now).toISOString() : null);
  const health = trip.status === "planned" ? (flags.some((f) => f.sev === "high") ? "bad" : "open")
    : trip.status === "cancelled" || flags.some((f) => f.sev === "high") ? "bad" : flags.length ? "warn" : "ok";
  return {
    ...trip, day, flags, delayMin, manual, corrections, color, health,
    leftAt: trip.stops[0]?.departedAt ?? trip.startedAt,
    finishedAt: trip.stops.at(-1)?.arrivedAt ?? trip.endedAt,
    automatic: trip.stops.filter((stop) => stop.arrivalMethod === "automatic").length,
    done: trip.stops.filter((stop) => stop.arrivedAt).length,
    durationMin: trip.startedAt && end ? Math.round((Date.parse(end) - Date.parse(trip.startedAt)) / MIN) : null
  };
}

function Pill({ status }: { status: HistoryTrip["status"] }) {
  return <span className={`st st-t-${status}`}>{status.toUpperCase()}</span>;
}

function FlagChips({ flags, limit }: { flags: Flag[]; limit?: number }) {
  return <>{flags.slice(0, limit).map((flag) => <span key={flag.text} className={`fc ${flag.sev}`}>{flag.text.toUpperCase()}</span>)}</>;
}

function eventRows(trip: TripView): LogRow[] {
  const rows: LogRow[] = trip.events.map((event) => {
    switch (event.type) {
      case "started": return { at: event.occurredAt, kind: event.type, text: "Trip started",
        sub: trip.delayMin > 0 ? `${trip.delayMin} min after scheduled ${time(trip.departureAt)}`
          : trip.delayMin < 0 ? `${-trip.delayMin} min before scheduled ${time(trip.departureAt)}` : "On time" };
      case "arrived_stop": return { at: event.occurredAt, kind: event.type, text: `Arrived at ${event.stopLabel}`, method: event.method, replaced: event.replaced };
      case "departed_stop": return { at: event.occurredAt, kind: event.type, text: `Departed ${event.stopLabel}`, method: event.method, replaced: event.replaced };
      case "completed": return event.method === "automatic"
        ? { at: event.occurredAt, kind: event.type, text: "Trip completed", method: event.method, sub: "Finished automatically 10 min after the final stop" }
        : { at: event.occurredAt, kind: event.type, text: "Trip completed" };
      case "cancelled": return { at: event.occurredAt, kind: event.type, text: "Trip cancelled", sev: "high", sub: `By ${event.recordedBy}` };
      case "correction": return { at: event.occurredAt, kind: event.type, text: `Arrival at ${event.stopLabel} undone`, sev: "med", sub: `By ${event.recordedBy}` };
      default: return { at: event.occurredAt, kind: event.type, text: "Note", sub: `By ${event.recordedBy}` };
    }
  });
  for (const alert of trip.alerts) {
    rows.push({ at: alert.createdAt, kind: `alert-${alert.kind}`, sev: alert.kind === "emergency" ? "high" : undefined,
      text: alert.kind === "emergency" ? `EMERGENCY: ${alert.label}` : `From the bus: ${alert.label}`,
      sub: `${alert.sentBy}${alert.note ? `: "${alert.note}"` : ""}${alert.resolvedAt ? ` · handled by ${alert.resolvedBy ?? "Dispatch"} at ${time(alert.resolvedAt)}` : " · not handled"}` });
  }
  for (const gap of trip.gps.gaps) {
    rows.push({ at: gap.startedAt, kind: "gap", text: `GPS gap ${duration(gap.durationSeconds)}`, sev: "high",
      sub: `No fixes from ${timeWithSeconds(gap.startedAt)} to ${timeWithSeconds(gap.resumedAt)}` });
  }
  return rows;
}

function Log({ rows, seconds }: { rows: LogRow[]; seconds?: boolean }) {
  if (!rows.length) return <p className="muted">No events recorded yet.</p>;
  const sorted = [...rows].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return <ol className="lg">{sorted.map((row, index) => <li key={`${row.at}-${index}`}
    className={`lg-${row.kind}${row.sev ? ` ${row.sev}` : ""}${row.replaced ? " rep" : ""}`}>
    <time>{row.kind === "sample" || seconds ? timeWithSeconds(row.at) : time(row.at)}</time><i />
    <div><b>{row.text}{row.method && <span className={`mt ${row.method}`}>{row.method.toUpperCase()}</span>}
      {row.replaced && <span className="mt undone">UNDONE</span>}</b>{row.sub && <span>{row.sub}</span>}</div>
  </li>)}</ol>;
}

function GpsTab({ trip }: { trip: TripView }) {
  const [entries, setEntries] = useState<DispatchGpsAuditEntry[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    getJson(`/api/dispatch/trips/${trip.id}/gps-audit`, dispatchGpsAuditResponseSchema, controller.signal)
      .then((data) => setEntries(data.entries))
      .catch((cause) => { if (!controller.signal.aborted) setError(message(cause, "Could not load GPS captures.")); });
    return () => controller.abort();
  }, [trip.id]);
  if (error) return <ErrorNote text={error} />;
  if (!entries) return <p className="hint">Loading GPS captures…</p>;
  const samples = entries.filter((entry) => entry.kind === "sample");
  if (!samples.length) return <NoMatch>No GPS captures for this trip.</NoMatch>;
  const rows: LogRow[] = [...eventRows(trip), ...samples.map((sample) => ({
    at: sample.observedAt, kind: "sample", text: "GPS fix",
    sub: `±${Math.round(sample.accuracyM)} m · ${sample.speedMps === null ? "speed —" : `${sample.speedMps.toFixed(1)} m/s`}${sample.headingDegrees === null ? "" : ` · ${Math.round(sample.headingDegrees)}°`} · server +${Math.max(0, Math.round((Date.parse(sample.receivedAt) - Date.parse(sample.observedAt)) / 1000))}s`
  }))];
  return <><p className="muted" style={{ margin: "12px 0 4px" }}>
    {trip.gps.samples > samples.length ? `Newest ${samples.length} of ${trip.gps.samples} fixes.` : `${samples.length} fixes.`} Gaps show as missing time between rows.</p>
    <Log rows={rows} seconds /></>;
}

function TripDetailView({ trip, tab, setTab }: { trip: TripView; tab: Tab; setTab: (tab: Tab) => void }) {
  const endLabel = trip.status === "cancelled" ? "Cancelled" : trip.status === "active" ? "Elapsed" : "Completed";
  const endValue = trip.status === "cancelled" ? time(trip.cancelledAt) : trip.endedAt ? time(trip.endedAt)
    : trip.durationMin !== null ? `${trip.durationMin} min` : "—";
  return <>
    <div className="dh"><span className="av" style={{ "--c": trip.color, "--s": "44px" } as CSSProperties}>{busNumber(trip.busLabel)}</span>
      <h2>{routeWithPeriod(trip.routeName, trip.servicePeriod)}</h2></div>
    <p className="dsub">{trip.busLabel} &middot; {dayWords(trip.day)} &nbsp;<Pill status={trip.status} /></p>
    <CrewPills lead={trip.assignedStaff} counselors={trip.counselors} driver={trip.driver} />
    {trip.flags.length > 0 && <div className="fcs"><FlagChips flags={trip.flags} /></div>}
    <div className="dsec"><h3>Times</h3></div>
    <dl className="sm">
      <div><dt>Scheduled</dt><dd>{time(trip.departureAt)}</dd></div>
      <div><dt>Started</dt><dd>{trip.startedAt ? <>{time(trip.startedAt)}{trip.delayMin > 0 && <small> +{trip.delayMin} min</small>}</> : "—"}</dd></div>
      <div><dt>{endLabel}</dt><dd>{endValue}</dd></div>
      <div><dt>Duration</dt><dd>{trip.durationMin !== null ? `${trip.durationMin} min` : "—"}</dd></div>
      <div><dt>Stops</dt><dd>{trip.done} of {trip.stops.length}</dd></div>
      <div><dt>Arrivals</dt><dd>{trip.automatic} by GPS · {trip.manual} tapped</dd></div>
    </dl>
    <div className="dsec"><h3>Ride Check</h3></div>
    <dl className="sm">
      <div><dt>Rode</dt><dd>{trip.riders.rode} of {trip.riders.total}</dd></div>
      <div><dt>No-shows</dt><dd>{trip.riders.noShow}</dd></div>
      <div><dt>Not riding</dt><dd>{trip.riders.notRiding}</dd></div>
      <div><dt>Never checked</dt><dd className={trip.riders.unchecked && trip.status !== "planned" ? "bad" : ""}>{trip.riders.unchecked}</dd></div>
      <div><dt>Still on bus</dt><dd className={trip.riders.stillAboard && trip.status === "completed" ? "bad" : ""}>{trip.riders.stillAboard}</dd></div>
      <div><dt>Bus walked</dt><dd>{trip.riders.sweptAt ? time(trip.riders.sweptAt) : "—"}</dd></div>
    </dl>
    <div className="tabs2" role="tablist">{([["replay", "Replay"], ["events", "Event log"], ["stops", "Stops"], ["gps", `GPS captures (${trip.gps.samples})`]] as const).map(([key, label]) =>
      <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? "on" : ""} onClick={() => setTab(key)}>{label}</button>)}</div>
    {tab === "replay" && <Suspense fallback={<p className="hint">Loading the map…</p>}><Replay trip={trip} color={trip.color} /></Suspense>}
    {tab === "events" && <Log rows={eventRows(trip)} />}
    {tab === "stops" && <div className="tt"><table><thead><tr><th>Stop</th><th>Arrived</th><th>Departed</th><th>Dwell</th><th>Method</th></tr></thead>
      <tbody>{trip.stops.map((stop) => <tr key={stop.id}>
        <td><b>{stop.position}</b> {stop.label}</td>
        <td>{stop.arrivedAt ? time(stop.arrivedAt) : <span className="dim">—</span>}</td>
        <td>{stop.departedAt ? time(stop.departedAt) : <span className="dim">—</span>}</td>
        <td>{stop.arrivedAt && stop.departedAt ? `${Math.round((Date.parse(stop.departedAt) - Date.parse(stop.arrivedAt)) / MIN)} min` : "—"}</td>
        <td>{stop.arrivalMethod ? <span className={`mt ${stop.arrivalMethod}`}>{stop.arrivalMethod === "automatic" ? "AUTO" : stop.arrivalMethod === "override" ? "GPS DISAGREED" : "TAPPED"}</span> : <span className="dim">—</span>}</td>
      </tr>)}</tbody></table></div>}
    {tab === "gps" && <GpsTab trip={trip} />}
  </>;
}

// ---------- helpers ----------

const lateLabel = (trip: TripView) => !trip.startedAt ? "—"
  : trip.delayMin >= 2 ? `+${trip.delayMin} min` : trip.delayMin <= -2 ? `${-trip.delayMin} early` : "On time";

function kidsLabel(trip: TripView) {
  const r = trip.riders;
  if (!r.total) return "—";
  if (trip.status === "planned") return `${r.total} expected`;
  return `${r.rode}/${r.total}${r.noShow ? ` · ${r.noShow} no-show` : ""}`;
}

const HEALTH_TEXT: Record<TripView["health"], string> = {
  ok: "Ran, no problems", warn: "Ran, small issues", bad: "Problem or cancelled", open: "Not started yet"
};

// ---------- Day: one row per bus ----------

/** "+3" late, "-2" early, nothing when within a minute. */
function offset(actual: string | null, planned: string) {
  if (!actual) return null;
  const min = Math.round((Date.parse(actual) - Date.parse(planned)) / MIN);
  return Math.abs(min) < 2 ? null : min > 0 ? `+${min}` : `${min}`;
}

function RunCell({ trip, onOpen }: { trip: TripView; onOpen: (id: string) => void }) {
  const late = offset(trip.leftAt, trip.departureAt);
  const state = trip.status === "cancelled" ? "Cancelled"
    : trip.status === "planned" ? (trip.health === "bad" ? "Never started" : "Not started")
      : trip.status === "active" ? "Running now" : null;
  return <button type="button" className={`hb-run h-${trip.health}`} style={{ "--c": trip.color } as CSSProperties} onClick={() => onOpen(trip.id)}>
    <span className="hb-route">{trip.routeName}</span>
    <span className="hb-times">
      <span><small>Scheduled</small><b>{time(trip.departureAt)}</b></span>
      <span><small>Left</small><b>{trip.leftAt ? time(trip.leftAt) : "—"}</b>{late && <em className={late.startsWith("+") && trip.delayMin >= 5 ? "bad" : ""}>{late}</em>}</span>
      <span><small>Arrived</small><b>{trip.status === "completed" && trip.finishedAt ? time(trip.finishedAt) : "—"}</b></span>
    </span>
    <span className="hb-foot">{state ? <span className={`hb-state ${trip.health}`}>{state}</span>
      : <span>{trip.riders.total ? `${trip.riders.rode} of ${trip.riders.total} kids` : "No kids listed"}</span>}
      {trip.flags.some((f) => f.text !== state) && trip.status !== "cancelled" && <span className={`hb-flag ${trip.flags.some((f) => f.sev === "high") ? "high" : "med"}`}>
        {trip.flags.filter((f) => f.text !== state)[0]!.text}{trip.flags.filter((f) => f.text !== state).length > 1 ? ` +${trip.flags.filter((f) => f.text !== state).length - 1}` : ""}</span>}
    </span>
  </button>;
}

function ByBus({ buses, trips, colorOf, problemsOnly, onOpen }: {
  buses: Bus[]; trips: TripView[]; colorOf: (id: string) => string; problemsOnly: boolean; onOpen: (id: string) => void;
}) {
  const rows = buses.map((bus) => {
    const list = trips.filter((trip) => trip.busId === bus.id);
    return { bus, am: list.filter((trip) => trip.servicePeriod === "AM"), pm: list.filter((trip) => trip.servicePeriod !== "AM"), list };
  }).filter((row) => row.list.length && (!problemsOnly || row.list.some((trip) => trip.flags.length)));
  if (!rows.length) return <NoMatch>{problemsOnly ? "No problems this day." : "No trips this day."}</NoMatch>;
  return <div className="hb">
    <div className="hb-head" aria-hidden="true"><span>Bus</span><span>Morning</span><span>Afternoon</span></div>
    {rows.map(({ bus, am, pm, list }) => <div key={bus.id} className="hb-row">
      <div className="hb-bus">
        <span className="av" style={{ "--c": colorOf(bus.id), "--s": "34px" } as CSSProperties}>{busNumber(bus.label)}</span>
        <div><b>{bus.label}</b><small>{list.find((trip) => trip.assignedStaff)?.assignedStaff?.displayName ?? "No lead"}{list.find((trip) => trip.driver)?.driver ? ` · ${list.find((trip) => trip.driver)!.driver!.name}` : ""}</small></div>
      </div>
      <div className="hb-col" data-label="Morning">{am.length ? am.map((trip) => <RunCell key={trip.id} trip={trip} onOpen={onOpen} />) : <span className="hb-none">No morning run</span>}</div>
      <div className="hb-col" data-label="Afternoon">{pm.length ? pm.map((trip) => <RunCell key={trip.id} trip={trip} onOpen={onOpen} />) : <span className="hb-none">No afternoon run</span>}</div>
    </div>)}
  </div>;
}

// ---------- Week: did the buses run? ----------

function Week({ buses, trips, days, today, colorOf, onDay, onOpen }: {
  buses: Bus[]; trips: TripView[]; days: string[]; today: string; colorOf: (id: string) => string;
  onDay: (day: string) => void; onOpen: (id: string) => void;
}) {
  const rows = buses.filter((bus) => bus.active || trips.some((trip) => trip.busId === bus.id));
  return <div className="tr-week">
    <table>
      <thead><tr><th>Bus</th>{days.map((day) => <th key={day}>
        <button type="button" onClick={() => onDay(day)}>{day === today ? "Today" : dateLabel(day).replace(/,.*$/, "")}<small>{dateLabel(day).split(", ")[1]}</small></button></th>)}</tr></thead>
      <tbody>{rows.map((bus) => <tr key={bus.id}>
        <th><span className="av" style={{ "--c": colorOf(bus.id), "--s": "26px" } as CSSProperties}>{busNumber(bus.label)}</span>{bus.label}</th>
        {days.map((day) => {
          const list = trips.filter((trip) => trip.busId === bus.id && trip.day === day)
            .sort((a, b) => Date.parse(a.departureAt) - Date.parse(b.departureAt));
          return <td key={day}>{list.length
            ? list.map((trip) => <button key={trip.id} type="button" className={`tr-dot ${trip.health}`} onClick={() => onOpen(trip.id)}
              title={`${trip.servicePeriod} · ${routeWithPeriod(trip.routeName, trip.servicePeriod)} · ${time(trip.departureAt)} · ${HEALTH_TEXT[trip.health]}`}
              aria-label={`${bus.label} ${trip.servicePeriod} ${dateLabel(day)}: ${HEALTH_TEXT[trip.health]}`}>{trip.servicePeriod}</button>)
            : <span className="tr-none">—</span>}</td>;
        })}
      </tr>)}</tbody>
    </table>
    <div className="tr-legend">{(["ok", "warn", "bad", "open"] as const).map((key) =>
      <span key={key}><i className={`tr-dot ${key}`} />{HEALTH_TEXT[key]}</span>)}</div>
  </div>;
}

// ---------- Page ----------

export function TransitPage() {
  const { mode } = useOps();
  const now = useNow(15_000);
  const today = localDate(new Date());
  const [view, setView] = useState<"day" | "week">("day");
  const [day, setDay] = useState(today);
  const [trips, setTrips] = useState<HistoryTrip[]>([]);
  const [buses, setBuses] = useState<Bus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("replay");

  const days = view === "week" ? Array.from({ length: 7 }, (_, i) => shiftDay(day, i - 6)) : [day];
  usePolling(async (signal) => {
    const range = dayBounds(days[0]!, days.length);
    try {
      const [history, fleet] = await Promise.all([
        getJson(`/api/dispatch/history?${new URLSearchParams(range)}`, historyResponseSchema, signal),
        getJson("/api/fleet/buses", busesResponseSchema, signal)
      ]);
      if (signal.aborted) return;
      setTrips(history.trips);
      setBuses(fleet.buses);
      setError("");
    } catch (cause) {
      if (!signal.aborted) setError(message(cause, "Could not load trips."));
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, 30_000, [day, view]);

  const colorOf = useMemo(() => busColors(buses), [buses]);
  const views = useMemo(() => trips.map((trip) => buildView(trip, now, colorOf(trip.busId)))
    .sort((a, b) => Date.parse(a.departureAt) - Date.parse(b.departureAt)), [trips, now, colorOf]);
  const dayTrips = views.filter((trip) => trip.day === day);

  const ran = dayTrips.filter((trip) => trip.status === "completed" || trip.status === "active");
  const late = ran.filter((trip) => trip.delayMin >= 5).length;
  const problems = dayTrips.filter((trip) => trip.flags.length > 0).length;
  const busCount = new Set(ran.map((trip) => trip.busId)).size;
  const summary = !dayTrips.length ? `No trips ${dayName(day).toLowerCase()}`
    : !ran.length ? `${dayTrips.length} ${plural(dayTrips.length, "trip", "trips")} planned, none ran`
      : `${busCount} ${plural(busCount, "bus", "buses")} ran ${ran.length} ${plural(ran.length, "trip", "trips")}`;

  const step = view === "week" ? 7 : 1;
  const label = view === "week" ? `${dateLabel(days[0]!)} to ${dateLabel(days.at(-1)!)}` : dayWords(day);
  const nav = <div className="tr-nav">
    <Seg label="View" value={view} onChange={setView} items={[["day", "Day"], ["week", "Week"]]} />
    <div className="tr-step">
      <button type="button" aria-label="Earlier" onClick={() => setDay(shiftDay(day, -step))}>&lsaquo;</button>
      <span>{label}</span>
      <button type="button" aria-label="Later" onClick={() => setDay(shiftDay(day, step))}>&rsaquo;</button>
    </div>
    {day !== today && <button type="button" className="btn sm" onClick={() => setDay(today)}>Today</button>}
  </div>;

  const openTrip = views.find((trip) => trip.id === openId) ?? null;
  const overlay = openId && <Overlay onClose={() => setOpenId(null)}>
    {openTrip ? <TripDetailView trip={openTrip} tab={tab} setTab={setTab} /> : <NoMatch>Trip not found.</NoMatch>}
    {openTrip && <DemoDeleteRide tripId={openTrip.id} onDeleted={() => { setTrips((list) => list.filter((trip) => trip.id !== openTrip.id)); setOpenId(null); }} />}
  </Overlay>;
  const open = (id: string) => { setTab(views.find((trip) => trip.id === id)?.status === "completed" ? "replay" : "events"); setOpenId(id); };

  return <div className="tr">
    <Head eyebrow="Daily" title="History" actions={<>{mode === "desktop" && nav}<Link className="btn" to="/reports">Reports</Link></>} />
    {mode !== "desktop" && nav}
    <ErrorNote text={error} />
    {loading && <p className="hint">Loading trips…</p>}

    {view === "week"
      ? <Week buses={buses} trips={views} days={days} today={today} colorOf={colorOf} onOpen={open}
          onDay={(next) => { setDay(next); setView("day"); }} />
      : <>
        <div className="hb-sum">
          <h2>{summary}</h2>
          {dayTrips.length > 0 && <p>
            <span className={late ? "warn" : ""}>{late ? `${late} left late` : "All left on time"}</span>
            <button type="button" className={`hb-pf${problems ? " bad" : ""}${problemsOnly ? " on" : ""}`} aria-pressed={problemsOnly}
              disabled={!problems && !problemsOnly} onClick={() => setProblemsOnly(!problemsOnly)}>
              {problems ? `${problems} ${plural(problems, "trip", "trips")} with problems${problemsOnly ? " · show all" : " · show only these"}` : "No problems"}</button>
          </p>}
        </div>
        <ByBus buses={buses} trips={dayTrips} colorOf={colorOf} problemsOnly={problemsOnly} onOpen={open} />
      </>}
    {overlay}
  </div>;
}

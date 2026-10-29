import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  busesResponseSchema, dispatchGpsAuditResponseSchema, historyResponseSchema,
  type Bus, type DispatchGpsAuditEntry, type HistoryTrip
} from "@bussin/shared";
import { getJson, message } from "../ops/api";
import {
  dateLabel, dayBounds, dayName, duration, localDate, MIN, plural, shiftDay, time, timeWithSeconds, routeWithPeriod } from "../ops/format";
import { busColors, busNumber } from "../ops/fleetModel";
import { Overlay, useOps } from "../ops/OpsShell";
import { CrewPills, ErrorNote, Head, NoMatch, Search, Seg, Tile } from "../ops/ui";
import { useNow, usePolling } from "../ops/useBoard";
import "./transit.css";

/*
 * Transit: the record of what ran. Dispatch is for right now; this is for "did every bus run,
 * when, and what went wrong". Day view: a timeline board (one row per bus) and a departures
 * table. Week view: a grid of AM/PM dots per bus per day. Click anything for the full trip.
 */

type Flag = { sev: "high" | "med"; text: string };
type TripView = HistoryTrip & {
  day: string; flags: Flag[]; delayMin: number; manual: number; automatic: number; corrections: number;
  done: number; durationMin: number | null; color: string; leftAt: string | null; finishedAt: string | null;
  health: "ok" | "warn" | "bad" | "open";
};
type Tab = "events" | "stops" | "gps";
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
    <div className="tabs2" role="tablist">{([["events", "Event log"], ["stops", "Stops"], ["gps", `GPS captures (${trip.gps.samples})`]] as const).map(([key, label]) =>
      <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? "on" : ""} onClick={() => setTab(key)}>{label}</button>)}</div>
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

// ---------- Day: timeline board ----------

function Board({ buses, trips, day, now, colorOf, onOpen }: {
  buses: Bus[]; trips: TripView[]; day: string; now: number; colorOf: (id: string) => string; onOpen: (id: string) => void;
}) {
  const at = (hour: number) => new Date(`${day}T${String(hour).padStart(2, "0")}:00:00`).getTime();
  const spanOf = (trip: TripView) => {
    const start = Date.parse(trip.startedAt ?? trip.departureAt);
    const end = trip.endedAt ? Date.parse(trip.endedAt)
      : trip.status === "active" ? Math.max(now, start + 5 * MIN)
        : trip.cancelledAt ? start + 20 * MIN : start + 30 * MIN;
    return { start, end };
  };
  // Hours shown: 6 AM to 7 PM, stretched to fit any trip outside that.
  let first = at(6), last = at(19);
  for (const trip of trips) {
    const { start, end } = spanOf(trip);
    first = Math.min(first, start - 30 * MIN); last = Math.max(last, end + 30 * MIN);
  }
  first = Math.floor(first / (60 * MIN)) * 60 * MIN; last = Math.ceil(last / (60 * MIN)) * 60 * MIN;
  const pct = (t: number) => `${((t - first) / (last - first)) * 100}%`;
  const hours: number[] = [];
  for (let t = first; t <= last; t += 60 * MIN) hours.push(t);
  const isToday = day === localDate(new Date(now));
  const rows = buses.map((bus) => ({ bus, trips: trips.filter((trip) => trip.busId === bus.id) }))
    .filter((row) => row.bus.active || row.trips.length);

  return <div className="tr-board" role="table" aria-label="Trips by bus">
    <div className="tr-axis" aria-hidden="true"><span />
      <div className="tr-lane">{hours.map((t) => <i key={t} style={{ left: pct(t) }}>{new Date(t).toLocaleTimeString("en-US", { hour: "numeric" })}</i>)}
        {isToday && now > first && now < last && <b className="tr-now-tag" style={{ left: pct(now) }}>NOW</b>}</div></div>
    {rows.map(({ bus, trips: list }) => <div key={bus.id} className="tr-row" role="row">
      <div className="tr-bus" role="rowheader">
        <span className="av" style={{ "--c": colorOf(bus.id), "--s": "30px" } as CSSProperties}>{busNumber(bus.label)}</span>
        <div><b>{bus.label}</b><small>{list.length ? `${list.length} ${plural(list.length, "trip", "trips")}` : "No trips"}</small></div>
      </div>
      <div className="tr-lane" role="cell">
        {hours.map((t) => <i key={t} className="tr-grid" style={{ left: pct(t) }} />)}
        {isToday && now > first && now < last && <i className="tr-now" style={{ left: pct(now) }} />}
        {list.map((trip) => {
          const { start, end } = spanOf(trip);
          return <button key={trip.id} type="button" className={`tr-bar s-${trip.status} h-${trip.health}`}
            style={{ left: pct(start), width: `max(64px, calc(${pct(end)} - ${pct(start)}))`, "--c": trip.color } as CSSProperties}
            title={`${routeWithPeriod(trip.routeName, trip.servicePeriod)} · ${time(trip.departureAt)} · ${trip.status}${trip.flags.length ? ` · ${trip.flags.map((f) => f.text).join(", ")}` : ""}`}
            onClick={() => onOpen(trip.id)}>
            <span>{time(trip.departureAt).replace(/ [AP]M$/, "")} {trip.servicePeriod}</span>
            {trip.stops.filter((stop) => stop.arrivedAt).map((stop) => <em key={stop.id}
              className={`tk ${stop.arrivalMethod ?? ""}`} style={{ left: `${((Date.parse(stop.arrivedAt!) - start) / Math.max(1, end - start)) * 100}%` }} />)}
          </button>;
        })}
      </div>
    </div>)}
    <div className="tr-legend">
      <span><i className="lg-run" />Ran, start to finish</span><span><i className="lg-plan" />Planned, not started</span>
      <span><i className="lg-bad" />Problem</span><span><i className="lg-can" />Cancelled</span>
      <span><i className="lg-tick" />Stop reached by GPS</span><span><i className="lg-tick man" />Stop tapped</span>
    </div>
  </div>;
}

// ---------- Day: departures table ----------

function Departures({ trips, onOpen }: { trips: TripView[]; onOpen: (id: string) => void }) {
  if (!trips.length) return <NoMatch>No trips match.</NoMatch>;
  return <div className="tr-table-wrap"><table className="tbl tr-table">
    <thead><tr><th>Time</th><th>Bus</th><th>Route</th><th>Lead</th><th>Driver</th><th>Left</th><th>Finished</th>
      <th>Start</th><th>Kids</th><th>Status</th><th>Problems</th></tr></thead>
    <tbody>{trips.map((trip) => <tr key={trip.id} data-ov="" tabIndex={0} className={`h-${trip.health}`}
      onClick={() => onOpen(trip.id)} onKeyDown={(event) => { if (event.key === "Enter") onOpen(trip.id); }}>
      <td className="mono"><b>{time(trip.departureAt)}</b></td>
      <td><span className="tr-busc"><span className="av" style={{ "--c": trip.color, "--s": "24px" } as CSSProperties}>{busNumber(trip.busLabel)}</span>{trip.busLabel}</span></td>
      <td>{routeWithPeriod(trip.routeName, trip.servicePeriod)}</td>
      <td>{trip.assignedStaff?.displayName ?? <span className="bad">None</span>}</td>
      <td>{trip.driver?.name ?? <span className="dim">—</span>}</td>
      <td className="mono">{trip.leftAt ? time(trip.leftAt) : <span className="dim">—</span>}</td>
      <td className="mono">{trip.finishedAt ? time(trip.finishedAt) : <span className="dim">—</span>}</td>
      <td className={trip.delayMin >= 5 ? "bad" : ""}>{lateLabel(trip)}</td>
      <td className={trip.riders.unchecked && trip.status !== "planned" ? "bad" : ""}>{kidsLabel(trip)}</td>
      <td><Pill status={trip.status} /></td>
      <td>{trip.flags.length ? <FlagChips flags={trip.flags} limit={2} /> : <span className="dim">None</span>}
        {trip.flags.length > 2 && <span className="dim"> +{trip.flags.length - 2}</span>}</td>
    </tr>)}</tbody></table></div>;
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
  const [query, setQuery] = useState("");
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("events");

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
  const needle = query.trim().toLowerCase();
  const dayTrips = views.filter((trip) => trip.day === day);
  const shown = dayTrips.filter((trip) => (!problemsOnly || trip.flags.length > 0) &&
    (!needle || `${trip.busLabel} ${trip.routeName} ${trip.assignedStaff?.displayName ?? ""} ${trip.counselors.map((c) => c.displayName).join(" ")} ${trip.driver?.name ?? ""}`.toLowerCase().includes(needle)));

  const ran = dayTrips.filter((trip) => trip.status === "completed" || trip.status === "active");
  const late = ran.filter((trip) => trip.delayMin >= 5).length;
  const problems = dayTrips.filter((trip) => trip.flags.length > 0).length;
  const rode = ran.reduce((sum, trip) => sum + trip.riders.rode, 0);
  const expected = ran.reduce((sum, trip) => sum + trip.riders.total, 0);
  const planned = dayTrips.filter((trip) => trip.status === "planned").length;

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
  </Overlay>;
  const open = (id: string) => { setTab("events"); setOpenId(id); };

  return <div className="tr">
    <Head eyebrow="History" title="Transit" sub="Every trip, as it ran. Dispatch is for right now; this is the record." actions={mode === "desktop" ? nav : undefined} />
    {mode !== "desktop" && nav}
    <ErrorNote text={error} />
    {loading && <p className="hint">Loading trips…</p>}

    {view === "week"
      ? <Week buses={buses} trips={views} days={days} today={today} colorOf={colorOf} onOpen={open}
          onDay={(next) => { setDay(next); setView("day"); }} />
      : <>
        <div className="tiles">
          <Tile label="Trips" value={dayTrips.length} sub={planned ? `${planned} not started` : "all started or done"} />
          <Tile label="On time" value={ran.length - late} sub="started within 5 min" />
          <Tile label="Late" value={late} sub="5+ min after scheduled" className={late ? "warn" : ""} />
          <Tile label="Problems" value={problems} sub={problems ? "tap Problems only to list them" : "none"} className={problems ? "bad" : ""}
            onClick={() => setProblemsOnly((value) => !value)} pressed={problemsOnly} />
          <Tile label="Kids rode" value={expected ? `${rode}/${expected}` : "—"} sub="on trips that ran" />
        </div>
        {mode === "desktop" && dayTrips.length > 0 && <Board buses={buses} trips={dayTrips} day={day} now={now} colorOf={colorOf} onOpen={open} />}
        <div className="sec-h tr-sec"><h2>Departures</h2>
          <div className="tr-filters"><Search value={query} onChange={setQuery} placeholder="Bus, route, lead or driver" />
            <label className="ck"><input type="checkbox" checked={problemsOnly} onChange={(event) => setProblemsOnly(event.target.checked)} /> Problems only</label></div></div>
        {mode === "desktop"
          ? <Departures trips={shown} onOpen={open} />
          : shown.length ? <div className="surface">{shown.map((trip) => <button key={trip.id} type="button" className={`it tr-card h-${trip.health}`} onClick={() => open(trip.id)}>
              <span className="av" style={{ "--c": trip.color, "--s": "34px" } as CSSProperties}>{busNumber(trip.busLabel)}</span>
              <div><div className="a"><strong>{time(trip.departureAt)} · {routeWithPeriod(trip.routeName, trip.servicePeriod)}</strong></div>
                <div className="b"><Pill status={trip.status} /> <span className="muted">{trip.busLabel} · {lateLabel(trip)} · kids {kidsLabel(trip)}</span></div>
                {trip.flags.length > 0 && <div className="fcs"><FlagChips flags={trip.flags} limit={3} /></div>}</div>
            </button>)}</div>
            : <NoMatch>{loading ? "Loading…" : dayTrips.length ? "No trips match." : `No trips ${dayName(day).toLowerCase()}.`}</NoMatch>}
      </>}
    {overlay}
  </div>;
}

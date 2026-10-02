import { useEffect, useMemo, useState, type CSSProperties, type ReactElement } from "react";
import {
  busesResponseSchema, dispatchGpsAuditResponseSchema, historyResponseSchema,
  type DispatchGpsAuditEntry, type HistoryTrip
} from "@bussin/shared";
import { getJson, message } from "../ops/api";
import {
  dateLabel, dayBounds, dayName, duration, localDate, MIN, plural, shiftDay, time, timeWithSeconds, routeWithPeriod } from "../ops/format";
import { busColors, busNumber } from "../ops/fleetModel";
import { Overlay, useOps } from "../ops/OpsShell";
import { ErrorNote, Head, NoMatch, Search, Seg } from "../ops/ui";
import { useNow, usePolling } from "../ops/useBoard";

type Flag = { sev: "high" | "med"; text: string };
type TripView = HistoryTrip & {
  day: string; flags: Flag[]; delayMin: number; manual: number; automatic: number; corrections: number;
  done: number; durationMin: number | null; color: string;
};
type Tab = "events" | "stops" | "gps";
type LogRow = { at: string; kind: string; text: string; sub?: string; method?: string | null; sev?: "high" | "med"; replaced?: boolean };

const DAYS = 3;

function buildView(trip: HistoryTrip, now: number, color: string): TripView {
  const flags: Flag[] = [];
  const delayMin = trip.startedAt ? Math.round((Date.parse(trip.startedAt) - Date.parse(trip.departureAt)) / MIN) : 0;
  const today = localDate(new Date(now));
  const day = localDate(new Date(trip.departureAt));
  if (trip.status === "cancelled") flags.push({ sev: "high", text: "Cancelled" });
  if (trip.status === "planned" && day === today) {
    const late = Math.floor((now - Date.parse(trip.departureAt)) / MIN);
    if (late >= 1) flags.push({ sev: "high", text: `Not started, ${late} min late` });
    if (!trip.assignedStaff) flags.push({ sev: "med", text: "No driver assigned" });
  }
  if (delayMin >= 5) flags.push({ sev: delayMin >= 10 ? "high" : "med", text: `Started ${delayMin} min late` });
  const manual = trip.stops.filter((stop) => stop.arrivalMethod === "manual").length;
  if (manual) flags.push({ sev: "med", text: `${manual} manual arrival${manual > 1 ? "s" : ""}` });
  const corrections = trip.events.filter((event) => event.type === "correction").length;
  if (corrections) flags.push({ sev: "med", text: `${corrections} correction${corrections > 1 ? "s" : ""}` });
  for (const gap of trip.gps.gaps) flags.push({ sev: gap.durationSeconds >= 120 ? "high" : "med", text: `GPS gap ${duration(gap.durationSeconds)}` });
  if (trip.status === "active") {
    const silent = trip.gps.lastObservedAt ? now - Date.parse(trip.gps.lastObservedAt) : null;
    if (silent === null) flags.push({ sev: "high", text: "No GPS yet" });
    else if (silent > 60_000) flags.push({ sev: "high", text: `GPS silent ${duration(Math.round(silent / 1000)).replace(/ \d+s$/, "")}` });
  }
  const end = trip.endedAt ?? (trip.status === "active" ? new Date(now).toISOString() : null);
  return {
    ...trip, day, flags, delayMin, manual, corrections, color,
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
        sub: trip.delayMin > 0 ? `${trip.delayMin} min after scheduled ${time(trip.departureAt)}` : "On time" };
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
    <p className="dsub">{trip.busLabel} &middot; {trip.assignedStaff?.displayName ?? "No driver assigned"} &middot; {dayName(trip.day)}, {dateLabel(trip.day)} &nbsp;<Pill status={trip.status} /></p>
    {trip.flags.length > 0 && <div className="fcs"><FlagChips flags={trip.flags} /></div>}
    <div className="dsec"><h3>Times</h3></div>
    <dl className="sm">
      <div><dt>Scheduled</dt><dd>{time(trip.departureAt)}</dd></div>
      <div><dt>Started</dt><dd>{trip.startedAt ? <>{time(trip.startedAt)}{trip.delayMin > 0 && <small> +{trip.delayMin} min</small>}</> : "—"}</dd></div>
      <div><dt>{endLabel}</dt><dd>{endValue}</dd></div>
      <div><dt>Duration</dt><dd>{trip.durationMin !== null ? `${trip.durationMin} min` : "—"}</dd></div>
      <div><dt>Stops</dt><dd>{trip.done} of {trip.stops.length}</dd></div>
      <div><dt>Arrivals</dt><dd>{trip.automatic} auto · {trip.manual} manual</dd></div>
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
        <td>{stop.arrivalMethod ? <span className={`mt ${stop.arrivalMethod}`}>{stop.arrivalMethod.toUpperCase()}</span> : <span className="dim">—</span>}</td>
      </tr>)}</tbody></table></div>}
    {tab === "gps" && <GpsTab trip={trip} />}
  </>;
}

export function TransitPage() {
  const { mode } = useOps();
  const now = useNow(15_000);
  const today = localDate(new Date());
  const [trips, setTrips] = useState<HistoryTrip[]>([]);
  const [colorOf, setColorOf] = useState<(id: string) => string>(() => () => "#17382c");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [exceptionsOnly, setExceptionsOnly] = useState(false);
  const [scope, setScope] = useState<"exc" | "all">("exc");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [overlayId, setOverlayId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("events");

  usePolling(async (signal) => {
    const range = dayBounds(shiftDay(today, -(DAYS - 1)), DAYS);
    try {
      const [history, buses] = await Promise.all([
        getJson(`/api/dispatch/history?${new URLSearchParams(range)}`, historyResponseSchema, signal),
        getJson("/api/fleet/buses", busesResponseSchema, signal)
      ]);
      if (signal.aborted) return;
      setTrips(history.trips);
      setColorOf(() => busColors(buses.buses));
      setError("");
    } catch (cause) {
      if (!signal.aborted) setError(message(cause, "Could not load trip history."));
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, 30_000, [today]);

  const views = useMemo(() => trips.map((trip) => buildView(trip, now, colorOf(trip.busId)))
    .sort((a, b) => Date.parse(b.departureAt) - Date.parse(a.departureAt)), [trips, now, colorOf]);
  const needle = query.trim().toLowerCase();
  const filter = (options: { status?: string; exceptions?: boolean; day?: string }) => views.filter((trip) =>
    (!options.status || trip.status === options.status) && (!options.exceptions || trip.flags.length > 0) &&
    (!options.day || trip.day === options.day) &&
    (!needle || `${trip.busLabel} ${trip.routeName} ${trip.assignedStaff?.displayName ?? ""}`.toLowerCase().includes(needle)));

  const grouped = (list: TripView[], render: (trip: TripView) => ReactElement) => {
    if (!list.length) return <NoMatch>{loading ? "Loading trips…" : "No trips match."}</NoMatch>;
    const out: ReactElement[] = [];
    let last = "";
    for (const trip of list) {
      if (trip.day !== last) { last = trip.day; out.push(<div key={`h-${trip.day}`} className="gh">{dayName(trip.day)} &middot; {dateLabel(trip.day)}</div>); }
      out.push(render(trip));
    }
    return <>{out}</>;
  };
  const item = (trip: TripView, selected: boolean, onClick: () => void, flagLimit: number) =>
    <button key={trip.id} type="button" className={`it${selected ? " sel" : ""}`} onClick={onClick}>
      <span className="av" style={{ "--c": trip.color, "--s": "34px" } as CSSProperties}>{busNumber(trip.busLabel)}</span>
      <div><div className="a"><strong>{time(trip.departureAt)} &middot; {routeWithPeriod(trip.routeName, trip.servicePeriod)}</strong></div>
        <div className="b"><Pill status={trip.status} /> &nbsp;{trip.assignedStaff?.displayName ?? "No driver"}</div>
        {trip.flags.length > 0 && <div className="fcs"><FlagChips flags={trip.flags} limit={flagLimit} /></div>}</div>
    </button>;
  const overlayTrip = overlayId ? views.find((trip) => trip.id === overlayId) : null;
  const overlayView = overlayId && <Overlay onClose={() => setOverlayId(null)}>
    {overlayTrip ? <TripDetailView trip={overlayTrip} tab={tab} setTab={setTab} /> : <NoMatch>Trip not found.</NoMatch>}
  </Overlay>;
  const status = <ErrorNote text={error} />;

  if (mode === "desktop") {
    const list = filter({ status: statusFilter, exceptions: exceptionsOnly });
    const selected = list.find((trip) => trip.id === selectedId) ?? list[0] ?? null;
    return <>
      <Head eyebrow="History" title="Transit" sub="See each trip and every recorded event." />
      {status}
      <div className="tsplit">
        <div className="tlist">
          <div className="tctl">
            <Search value={query} onChange={setQuery} placeholder="Search bus, route or driver" />
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <select aria-label="Status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                <option value="">All statuses</option><option value="active">Active</option><option value="planned">Planned</option>
                <option value="completed">Completed</option><option value="cancelled">Cancelled</option>
              </select>
              <label className="ck" style={{ whiteSpace: "nowrap" }}><input type="checkbox" checked={exceptionsOnly}
                onChange={(event) => setExceptionsOnly(event.target.checked)} /> Exceptions</label>
            </div>
            <span className="muted">{list.length} of {views.length} trips, last {DAYS} days</span>
          </div>
          {grouped(list, (trip) => item(trip, trip.id === selected?.id, () => setSelectedId(trip.id), 2))}
        </div>
        <div className="tpane">{selected ? <TripDetailView trip={selected} tab={tab} setTab={setTab} /> : <NoMatch>Select a trip.</NoMatch>}</div>
      </div>
    </>;
  }

  const list = filter({ exceptions: scope === "exc" });
  return <>
    <Head eyebrow="History" title="Transit" sub={`${list.length} ${scope === "exc" ? "trips with exceptions" : `trips, last ${DAYS} days`}`} />
    <Seg label="Scope" value={scope} onChange={setScope} items={[["exc", "Exceptions"], ["all", "All trips"]]} />
    {status}
    <Search value={query} onChange={setQuery} placeholder="Search bus, route or driver" />
    <div style={{ marginTop: 8 }} className="surface">{grouped(list, (trip) => item(trip, false, () => setOverlayId(trip.id), 3))}</div>
    {overlayView}
  </>;
}

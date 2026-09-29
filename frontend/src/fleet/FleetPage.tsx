import { useMemo, useState, type CSSProperties, type FormEvent, type ReactElement } from "react";
import { Link, useNavigate } from "react-router";
import { createBusSchema } from "@bussin/shared";
import { message, send } from "../ops/api";
import { age, ageShort, localDate, PALETTE, plural, routeWithPeriod, time } from "../ops/format";
import { currentStopIndex, fleetRows, STATUS_SLUG, type BusRow, type FleetStatus } from "../ops/fleetModel";
import { Overlay, useOps } from "../ops/OpsShell";
import { Bar, ErrorNote, Head, NoMatch, Plus, Search, SRow, Swatch, Tile, type Tone } from "../ops/ui";
import { useBoard, useNow } from "../ops/useBoard";


type Filter = "ALL" | FleetStatus;
type OverlayState = { type: "bus"; id: string } | { type: "addbus" } | { type: "routes" } | null;
const ORDER: FleetStatus[] = ["IN SERVICE", "GPS STALE", "PLANNED", "AVAILABLE", "INACTIVE"];

function StatusPill({ status }: { status: FleetStatus }) {
  return <span className={`st st-${STATUS_SLUG[status]}`}>{status}</span>;
}

function GpsCell({ row, now }: { row: BusRow; now: number }) {
  const cls = row.status === "GPS STALE" ? "stale" : row.latestGps && row.status === "IN SERVICE" ? "live" : "none";
  return <span className={`gps ${cls}`}><i />{age(row.latestGps, now)}</span>;
}

function AlertChips({ row }: { row: BusRow }) {
  return <>{row.alerts.map((alert) => <span key={alert.short} className={`od${alert.sev === "med" ? " med" : ""}`}>{alert.short.toUpperCase()}</span>)}</>;
}

function sentence(row: BusRow, now: number): [ReactElement, string, Tone] {
  const trip = row.trip;
  const label = <b>{row.bus.label}</b>;
  if (row.status === "GPS STALE" && trip) {
    return [<>{label} {row.latestGps ? `lost GPS ${ageShort(row.latestGps, now)} ago.` : "has sent no GPS yet."}</>,
      `${trip.routeName}, ${trip.assignedStaff?.displayName ?? "no driver"}`, "bad"];
  }
  if (trip?.status === "planned" && row.alerts.some((alert) => alert.kind === "late")) {
    return [<>{label} has not started. It was due at {time(trip.departureAt)}.</>, trip.assignedStaff?.displayName ?? "No driver assigned", "bad"];
  }
  if (row.status === "IN SERVICE" && trip) {
    return [<>{label} is running {trip.routeName}.</>,
      `${trip.assignedStaff?.displayName ?? "No driver"}${row.next?.etaAt ? `. Next stop at ${time(row.next.etaAt)}.` : "."}`, "ok"];
  }
  if (row.status === "PLANNED" && trip) {
    return [<>{label} leaves at {time(trip.departureAt)}.</>, `${trip.routeName}, ${trip.assignedStaff?.displayName ?? "no driver yet"}`, "warn"];
  }
  if (row.status === "INACTIVE") return [<>{label} is turned off.</>, "Not used for trips", ""];
  return [<>{label} has no trips right now.</>, "Available", ""];
}

function BusDetail({ row, now }: { row: BusRow; now: number }) {
  const trip = row.trip;
  return <>
    <p className="eyebrow">BUS</p>
    <h2 className="d-title"><Swatch color={row.color} />{row.bus.label}</h2>
    <div className="d-status"><StatusPill status={row.status} /><span>{row.bus.active ? "Bus record active" : "Bus record inactive"}</span></div>
    {row.alerts.length > 0 && <div className="d-alerts">{row.alerts.map((alert) =>
      <div key={alert.text} className={`alert alert-${alert.sev}`}><b>{alert.sev === "high" ? "ATTENTION" : "HEADS UP"}</b><span>{alert.text}</span></div>)}</div>}
    <dl className="d-grid">
      <div><dt>Current route</dt><dd>{trip?.routeName ?? "—"}</dd></div>
      <div><dt>Period</dt><dd>{trip?.servicePeriod ?? "—"}</dd></div>
      <div><dt>Driver</dt><dd>{trip?.assignedStaff?.displayName ?? "—"}</dd></div>
      <div><dt>Last GPS</dt><dd>{age(row.latestGps, now)}</dd></div>
      {row.next && <><div><dt>Next stop</dt><dd>{row.next.label}</dd></div>
        <div><dt>ETA</dt><dd>{row.next.etaAt ? time(row.next.etaAt) : "—"}</dd></div></>}
    </dl>
    {trip?.status === "active" && (() => {
      const current = currentStopIndex(trip);
      return <><div className="d-sec"><h3>Stops</h3><span>{row.progress?.done} of {trip.stops.length} done</span></div>
        <ol className="d-stops">{trip.stops.map((stop, index) => {
          const done = !!stop.departedAt || (index === trip.stops.length - 1 && !!stop.arrivedAt);
          const cls = done ? "done" : index === current ? "cur" : "";
          return <li key={stop.id} className={cls}><i style={{ "--c": row.color } as CSSProperties} /><span>{stop.label}</span>
            <em>{done || stop.arrivedAt ? "Arrived" : index === current ? "Next" : ""}</em></li>;
        })}</ol></>;
    })()}
    <div className="d-sec"><h3>Today&rsquo;s trips</h3><span>{row.trips.length}</span></div>
    {!row.trips.length && <p className="muted">No trips for this bus today.</p>}
    {row.trips.map((item) => <Link key={item.id} className="d-trip" to={`/?trip=${item.id}`}>
      <div><strong>{item.routeName}</strong><span>{item.servicePeriod} · {time(item.departureAt)}</span></div>
      <span className={`ts ts-${item.status}`}>{item.status}</span></Link>)}
  </>;
}

function AddBusForm({ suggested, onAdded }: { suggested: string; onAdded: (label: string) => void }) {
  const [label, setLabel] = useState(suggested);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = createBusSchema.safeParse({ label: label.trim() });
    if (!parsed.success) { setError("Enter a bus name."); return; }
    setSaving(true);
    try {
      await send("POST", "/api/fleet/buses", parsed.data, "Could not add bus.");
      onAdded(parsed.data.label);
    } catch (cause) {
      setError(message(cause, "Could not add bus."));
    } finally { setSaving(false); }
  }
  return <><p className="eyebrow">FLEET</p><h2 className="dt">Add bus</h2>
    <form className="planf" onSubmit={(event) => void submit(event)} noValidate>
      <div className="ctl-row"><label htmlFor="bus-label">Bus name</label>
        <input id="bus-label" value={label} maxLength={80} autoComplete="off" onChange={(event) => setLabel(event.target.value)} /></div>
      <ErrorNote text={error} />
      <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? "Adding…" : "Add bus"}</button>
    </form></>;
}

function RoutesList({ routes, isAdmin }: { routes: ReturnType<typeof useBoard>["routes"]; isAdmin: boolean }) {
  const families = [...new Set(routes.map((route) => route.routeFamilyName))];
  return <><p className="eyebrow">FLEET</p><h2 className="dt">Routes</h2>
    <p className="muted">Routes stay reachable from Fleet. Buses are assigned to trips, not permanently to routes.</p>
    {isAdmin && <div className="acts"><Link className="btn btn-primary" to="/routes">Open route editor</Link></div>}
    {!routes.length && <p className="hint">No routes yet.</p>}
    {routes.map((route) => <div key={route.id} className="dblock">
      <h3><Swatch color={PALETTE[families.indexOf(route.routeFamilyName) % PALETTE.length]} /> {route.name}
        <span className="per">{route.servicePeriod}</span>{!route.active && <span className="per">INACTIVE</span>}</h3>
      <p className="tk">{route.stops.map((stop) => stop.label).join(" → ") || "No stops"}</p>
    </div>)}
  </>;
}

export function FleetPage() {
  const { mode, isAdmin, toast } = useOps();
  const board = useBoard(localDate(new Date()), { routes: true });
  const now = useNow();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>("ALL");
  const [query, setQuery] = useState("");
  const [overlay, setOverlay] = useState<OverlayState>(null);

  const all = useMemo(() => fleetRows(board.buses, board.trips, now), [board.buses, board.trips, now]);
  const count = (status: FleetStatus) => all.filter((row) => row.status === status).length;
  const attention = all.filter((row) => row.alerts.length);
  const needle = query.trim().toLowerCase();
  const rows = all.filter((row) => (filter === "ALL" || row.status === filter) &&
    (!needle || `${row.bus.label} ${row.trip?.routeName ?? ""} ${row.trip?.assignedStaff?.displayName ?? ""}`.toLowerCase().includes(needle)))
    .sort((a, b) => (a.alerts.length ? 0 : 1) - (b.alerts.length ? 0 : 1) ||
      ORDER.indexOf(a.status) - ORDER.indexOf(b.status) ||
      a.bus.label.localeCompare(b.bus.label, undefined, { numeric: true }));
  const tiles: [Filter, string, number, string][] = [
    ["ALL", "All buses", all.length, "fleet"], ["IN SERVICE", "In service", count("IN SERVICE"), "live now"],
    ["PLANNED", "Planned", count("PLANNED"), "today"], ["AVAILABLE", "Available", count("AVAILABLE"), "no trips"],
    ["GPS STALE", "GPS stale", count("GPS STALE"), "over 60s"]];

  const selectedRow = overlay?.type === "bus" ? all.find((row) => row.bus.id === overlay.id) : null;
  const overlayView = overlay && <Overlay onClose={() => setOverlay(null)}>
    {overlay.type === "bus" ? (selectedRow ? <BusDetail row={selectedRow} now={now} /> : <NoMatch>Bus not found.</NoMatch>)
      : overlay.type === "routes" ? <RoutesList routes={board.routes} isAdmin={isAdmin} />
        : <AddBusForm suggested={`Bus ${board.buses.length + 1}`} onAdded={(label) => {
          setOverlay(null); toast(`${label} added to the fleet.`); board.reload();
        }} />}
  </Overlay>;
  const status = <><ErrorNote text={board.error} />{board.loading && <p className="hint">Loading fleet…</p>}</>;
  const openBus = (id: string) => setOverlay({ type: "bus", id });

  if (mode === "desktop") {
    return <>
      <Head eyebrow="FLEET" title="Fleet" sub="Buses, current work, assigned staff and GPS freshness." actions={<>
        <button type="button" className="btn" onClick={() => setOverlay({ type: "routes" })}>Routes</button>
        {isAdmin && <button type="button" className="btn btn-primary" onClick={() => setOverlay({ type: "addbus" })}>Add bus</button>}
      </>} />
      {status}
      <div className="tiles">{tiles.map(([key, label, value, sub]) =>
        <Tile key={key} label={label} value={value} sub={sub} pressed={filter === key}
          className={`${key === "GPS STALE" && value ? "bad " : ""}${filter === key ? "on" : ""}`} onClick={() => setFilter(key)} />)}</div>
      {attention.length > 0 && <div className="attnstrip"><b>{attention.length} NEED ATTENTION</b>
        {attention.map((row) => <button key={row.bus.id} type="button" className="pillbtn" onClick={() => openBus(row.bus.id)}>
          {row.bus.label}: {row.alerts.map((alert) => alert.short).join(", ")}</button>)}</div>}
      <div className="filters"><Search label="Search" value={query} onChange={setQuery} placeholder="Bus, route or driver" />
        <span className="cnt">Sorted by attention, then status</span></div>
      <table className="tbl">
        <thead><tr><th>Bus</th><th>Status</th><th>Route</th><th>Driver</th><th>Progress</th><th>Next stop</th><th>Departure</th><th>Last GPS</th></tr></thead>
        <tbody>{rows.length ? rows.map((row) => {
          const trip = row.trip;
          return <tr key={row.bus.id} data-ov="" className={row.alerts.length ? "attn" : ""} tabIndex={0}
            onClick={() => openBus(row.bus.id)}
            onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openBus(row.bus.id); } }}>
            <td className="busc" style={{ "--c": row.color } as CSSProperties}><b>{row.bus.label}</b><AlertChips row={row} /></td>
            <td><StatusPill status={row.status} /></td>
            <td>{trip ? <>{routeWithPeriod(trip.routeName, trip.servicePeriod)}</> : <span className="dim">No trip</span>}</td>
            <td>{trip?.assignedStaff?.displayName ?? <span className="dim">Unassigned</span>}</td>
            <td>{row.progress ? <Bar done={row.progress.done} total={row.progress.total} color={row.color} /> : <span className="dim">&mdash;</span>}</td>
            <td>{row.next ? <>{row.next.label}{row.next.etaAt && <small>ETA {time(row.next.etaAt)}</small>}</> : <span className="dim">&mdash;</span>}</td>
            <td>{trip ? time(trip.departureAt) : <span className="dim">&mdash;</span>}</td>
            <td><GpsCell row={row} now={now} /></td>
          </tr>;
        }) : <tr><td colSpan={8} className="nomatch">{board.loading ? "Loading…" : "No buses match this view."}</td></tr>}</tbody>
      </table>
      {overlayView}
    </>;
  }

  if (mode === "adv") {
    return <>
      <Head eyebrow="FLEET" title="Fleet" sub={<>{all.length} buses &middot; {count("IN SERVICE")} in service</>}
        actions={isAdmin ? <Plus label="Add bus" onClick={() => setOverlay({ type: "addbus" })} /> : undefined} />
      {status}
      {attention.length > 0 && <div className="alertbar"><div><b>{attention.length} NEED ATTENTION</b>
        <span>{attention.map((row) => row.bus.label).join(", ")}</span></div>
        <button type="button" onClick={() => setFilter("ALL")}>View</button></div>}
      <div className="chips">{tiles.map(([key, label, value]) => <button key={key} type="button"
        className={`chip${filter === key ? " on" : ""}`} aria-pressed={filter === key} onClick={() => setFilter(key)}>
        {label.toUpperCase()} <b>{value}</b></button>)}</div>
      <Search value={query} onChange={setQuery} placeholder="Bus, route or driver" />
      <div className="cards" style={{ marginTop: 12 }}>{rows.length ? rows.map((row) => {
        const trip = row.trip;
        return <button key={row.bus.id} type="button" className={`bc${row.alerts.length ? " attn" : ""}`}
          style={{ "--c": row.color } as CSSProperties} onClick={() => openBus(row.bus.id)}>
          <div className="h"><strong>{row.bus.label}</strong><StatusPill status={row.status} /></div>
          {row.alerts.length > 0 && <div className="ch"><AlertChips row={row} /></div>}
          {trip ? <>
            <div className="rt2">{routeWithPeriod(trip.routeName, trip.servicePeriod)}</div>
            <div className="tm"><span>{trip.assignedStaff?.displayName ?? "No driver"}</span><span>Departs {time(trip.departureAt)}</span></div>
            {row.progress && <Bar done={row.progress.done} total={row.progress.total} color={row.color} />}
          </> : <div className="rt2 muted">No trip today</div>}
          <div><GpsCell row={row} now={now} /></div>
        </button>;
      }) : <NoMatch>No buses match.</NoMatch>}</div>
      <div className="acts"><button type="button" className="btn" onClick={() => setOverlay({ type: "routes" })}>Routes</button></div>
      {overlayView}
    </>;
  }

  const need = rows.filter((row) => row.alerts.length);
  const running = rows.filter((row) => !row.alerts.length && row.status === "IN SERVICE");
  const others = rows.filter((row) => !need.includes(row) && !running.includes(row));
  const section = (title: string, cls: string, list: BusRow[]) => list.length > 0 && <>
    <h2 className={`sh2 ${cls}`}>{title}</h2>
    <div className="sl">{list.map((row) => {
      const [main, small, tone] = sentence(row, now);
      return <SRow key={row.bus.id} tone={tone} small={small} onClick={() => openBus(row.bus.id)}>{main}</SRow>;
    })}</div></>;
  return <>
    <h1 className="sh1">Fleet</h1>
    {status}
    {attention.length
      ? <div className="sbanner bad"><strong>{attention.length} {plural(attention.length, "bus needs attention", "buses need attention")}</strong>
        <small>{count("IN SERVICE")} running right now</small></div>
      : <div className="sbanner ok"><strong>All buses are fine</strong><small>{count("IN SERVICE")} running right now</small></div>}
    {section("Needs attention", "bad", need)}
    {section("Running", "", running)}
    {section("Not running", "", others)}
    <div className="pin">{isAdmin
      ? <button type="button" className="bigbtn out" onClick={() => setOverlay({ type: "addbus" })}>Add a bus</button>
      : <button type="button" className="bigbtn out" onClick={() => navigate("/")}>Open Dispatch</button>}</div>
    {overlayView}
  </>;
}

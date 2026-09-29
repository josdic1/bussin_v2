import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  boardResponseSchema,
  busSchema,
  busesResponseSchema,
  createBusSchema,
  type BoardTrip,
  type Bus
} from "@bussin/shared";
import { useAuth } from "../auth/AuthProvider";
import { Link } from "react-router";

type FleetStatus = "IN SERVICE" | "PLANNED" | "AVAILABLE" | "INACTIVE";
type FleetFilter = "ALL" | FleetStatus | "NEEDS ATTENTION";
type GpsState = "live" | "stale-warning" | "stale-complete" | "none";

function localDayBounds() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

function time(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function age(value: string | null | undefined, now: number) {
  if (!value) return "—";
  const seconds = Math.max(0, Math.floor((now - Date.parse(value)) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function statusSlug(status: FleetStatus) {
  return status.toLowerCase().replaceAll(" ", "-");
}

function statusFor(bus: Bus, trips: BoardTrip[]): FleetStatus {
  if (trips.some((trip) => trip.status === "active")) return "IN SERVICE";
  if (trips.some((trip) => trip.status === "planned")) return "PLANNED";
  if (!bus.active) return "INACTIVE";
  return "AVAILABLE";
}

function gpsStateFor(trip: BoardTrip | null, latestGps: string | null, now: number): GpsState {
  if (!latestGps || !trip) return "none";
  const gpsAge = now - Date.parse(latestGps);
  const stale = !Number.isFinite(gpsAge) || gpsAge > 60_000 || gpsAge < -60_000;
  if (!stale) return "live";
  return trip.status === "completed" || trip.status === "cancelled"
    ? "stale-complete"
    : "stale-warning";
}

function gpsText(state: GpsState, latestGps: string | null, now: number) {
  if (state === "none") return "—";
  if (state === "live") return `LIVE · ${age(latestGps, now)}`;
  return `STALE · ${age(latestGps, now)}`;
}

function featuredTrip(trips: BoardTrip[]) {
  return [...trips].sort((a, b) => {
    const rank = (trip: BoardTrip) => trip.status === "active" ? 0
      : trip.status === "planned" ? 1
      : trip.status === "completed" ? 2 : 3;
    return rank(a) - rank(b) || Date.parse(b.departureAt) - Date.parse(a.departureAt);
  })[0] ?? null;
}

export function FleetPage() {
  const { member } = useAuth();
  const [buses, setBuses] = useState<Bus[]>([]);
  const [trips, setTrips] = useState<BoardTrip[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FleetFilter>("ALL");
  const [selectedBusId, setSelectedBusId] = useState<string | null>(null);
  const [showAddBus, setShowAddBus] = useState(false);
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const canManage = member?.roles.includes("admin") ?? false;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const bounds = localDayBounds();
    const params = new URLSearchParams(bounds);

    async function loadFleet() {
      try {
        const [busResponse, boardResponse] = await Promise.all([
          fetch("/api/fleet/buses", { credentials: "same-origin", signal: controller.signal }),
          fetch(`/api/dispatch/board?${params}`, { credentials: "same-origin", signal: controller.signal })
        ]);
        if (!busResponse.ok || !boardResponse.ok) throw new Error("Could not load fleet.");

        const [busBody, boardBody] = await Promise.all([busResponse.json(), boardResponse.json()]);
        if (controller.signal.aborted) return;
        setBuses(busesResponseSchema.parse(busBody).buses);
        setTrips(boardResponseSchema.parse(boardBody).trips);
        setError("");
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "Could not load fleet.");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    void loadFleet();
    const timer = window.setInterval(() => void loadFleet(), 15_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, []);

  async function addBus(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = createBusSchema.safeParse({ label: label.trim() });
    if (!parsed.success) {
      setError("Enter a bus name between 1 and 80 characters.");
      return;
    }

    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/fleet/buses", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data)
      });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const message = body && typeof body === "object" && "error" in body && typeof body.error === "string"
          ? body.error : "Could not add bus.";
        throw new Error(message);
      }
      const bus = busSchema.parse(await response.json());
      setBuses((current) => [...current, bus].sort((a, b) => a.label.localeCompare(b.label)));
      setLabel("");
      setShowAddBus(false);
      setSelectedBusId(bus.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add bus.");
    } finally {
      setSaving(false);
    }
  }

  const rows = useMemo(() => buses.map((bus) => {
    const busTrips = trips.filter((trip) => trip.busId === bus.id);
    const trip = featuredTrip(busTrips);
    const latestGps = busTrips
      .flatMap((item) => item.location ? [item.location.observedAt] : [])
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
    return {
      bus,
      busTrips,
      trip,
      status: statusFor(bus, busTrips),
      latestGps,
      gpsState: gpsStateFor(trip, latestGps, now)
    };
  }), [buses, trips, now]);

  const visibleRows = rows.filter((row) => {
    const needle = query.trim().toLowerCase();
    const matchesSearch = !needle || [
      row.bus.label,
      row.trip?.routeName ?? "",
      row.trip?.assignedStaff?.displayName ?? ""
    ].some((value) => value.toLowerCase().includes(needle));
    const matchesFilter = filter === "ALL"
      || (filter === "NEEDS ATTENTION"
        ? row.gpsState === "stale-warning"
        : row.status === filter);
    return matchesSearch && matchesFilter;
  });

  const selected = rows.find((row) => row.bus.id === selectedBusId) ?? null;

  return (
    <section className="fleet-v2">
      <header className="fleet-v2-head">
        <div>
          <p className="eyebrow">OPERATIONS / FLEET</p>
          <h1>Fleet</h1>
          <p className="description">Buses, current work, assigned staff and GPS freshness.</p>
        </div>
        <div className="fleet-v2-head-actions">
          <Link className="fleet-v2-link" to="/routes">Routes</Link>
          {canManage && (
            <button className="fleet-v2-primary" type="button" onClick={() => setShowAddBus(true)}>
              Add bus
            </button>
          )}
        </div>
      </header>

      {error && <p className="auth-error" role="alert">{error}</p>}

      <div className="fleet-v2-toolbar">
        <label className="fleet-v2-search">
          <span>Search</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search buses, routes, drivers…"
          />
        </label>
        <label className="fleet-v2-filter">
          <span>Status</span>
          <select
            value={filter}
            onChange={(event) => setFilter(event.target.value as FleetFilter)}
          >
            <option value="ALL">All</option>
            <option value="IN SERVICE">In service</option>
            <option value="PLANNED">Planned</option>
            <option value="AVAILABLE">Available</option>
            <option value="NEEDS ATTENTION">Needs attention</option>
          </select>
        </label>
      </div>

      <div className="fleet-v2-table-shell">
        <table className="fleet-v2-table">
          <thead>
            <tr>
              <th>Bus</th>
              <th>Status</th>
              <th>Route</th>
              <th>Driver</th>
              <th>Departure</th>
              <th>Last GPS</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="fleet-v2-empty">Loading fleet…</td></tr>
            ) : visibleRows.length === 0 ? (
              <tr><td colSpan={6} className="fleet-v2-empty">No buses match this view.</td></tr>
            ) : visibleRows.map((row) => (
              <tr
                key={row.bus.id}
                onClick={() => setSelectedBusId(row.bus.id)}
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setSelectedBusId(row.bus.id);
                  }
                }}
              >
                <td data-label="Bus"><strong>{row.bus.label}</strong></td>
                <td data-label="Status">
                  <span className={`fleet-v2-status fleet-v2-status-${statusSlug(row.status)}`}>{row.status}</span>
                </td>
                <td data-label="Route">{row.trip ? `${row.trip.routeName} · ${row.trip.servicePeriod}` : "—"}</td>
                <td data-label="Driver">{row.trip?.assignedStaff?.displayName ?? "—"}</td>
                <td data-label="Departure">{row.trip ? time(row.trip.departureAt) : "—"}</td>
                <td data-label="Last GPS">
                  <span className={`fleet-v2-gps fleet-v2-gps-${row.gpsState}`}>
                    {gpsText(row.gpsState, row.latestGps, now)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(selected || showAddBus) && (
        <div className="fleet-v2-drawer-backdrop" onMouseDown={() => {
          setSelectedBusId(null);
          setShowAddBus(false);
        }}>
          <aside className="fleet-v2-drawer" onMouseDown={(event) => event.stopPropagation()}>
            <button className="fleet-v2-close" type="button" onClick={() => {
              setSelectedBusId(null);
              setShowAddBus(false);
            }}>Close</button>

            {showAddBus ? (
              <>
                <p className="eyebrow">FLEET</p>
                <h2>Add bus</h2>
                <form className="fleet-v2-add-form" onSubmit={(event) => void addBus(event)}>
                  <label htmlFor="bus-label">Bus name</label>
                  <input
                    id="bus-label"
                    value={label}
                    onChange={(event) => setLabel(event.target.value)}
                    placeholder="For example, Bus 1"
                    maxLength={80}
                    disabled={saving}
                    autoFocus
                    required
                  />
                  <button className="fleet-v2-primary" type="submit" disabled={saving}>
                    {saving ? "Adding…" : "Add bus"}
                  </button>
                </form>
              </>
            ) : selected ? (
              <>
                <p className="eyebrow">BUS</p>
                <h2>{selected.bus.label}</h2>
                <div className="fleet-v2-drawer-status">
                  <span className={`fleet-v2-status fleet-v2-status-${statusSlug(selected.status)}`}>{selected.status}</span>
                  <span>{selected.bus.active ? "Bus record active" : "Bus record inactive"}</span>
                </div>

                <dl className="fleet-v2-details">
                  <div><dt>Current route</dt><dd>{selected.trip?.routeName ?? "—"}</dd></div>
                  <div><dt>Period</dt><dd>{selected.trip?.servicePeriod ?? "—"}</dd></div>
                  <div><dt>Driver</dt><dd>{selected.trip?.assignedStaff?.displayName ?? "—"}</dd></div>
                  <div><dt>Last GPS</dt><dd>{age(selected.latestGps, now)}</dd></div>
                </dl>

                <section className="fleet-v2-trip-list">
                  <div className="fleet-v2-section-title">
                    <h3>Today’s trips</h3>
                    <span>{selected.busTrips.length}</span>
                  </div>
                  {selected.busTrips.length === 0 ? (
                    <p className="fleet-v2-muted">No trips for this bus today.</p>
                  ) : (
                    selected.busTrips
                      .sort((a, b) => Date.parse(a.departureAt) - Date.parse(b.departureAt))
                      .map((trip) => (
                        <Link key={trip.id} to={`/?trip=${trip.id}`} className="fleet-v2-trip-row">
                          <div>
                            <strong>{trip.routeName}</strong>
                            <span>{trip.servicePeriod} · {time(trip.departureAt)}</span>
                          </div>
                          <span className={`fleet-v2-trip-state fleet-v2-trip-state-${trip.status}`}>{trip.status}</span>
                        </Link>
                      ))
                  )}
                </section>
              </>
            ) : null}
          </aside>
        </div>
      )}
    </section>
  );
}

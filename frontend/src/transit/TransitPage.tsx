import { useEffect, useMemo, useState } from "react";
import {
  boardResponseSchema,
  dispatchGpsAuditResponseSchema,
  type BoardTrip,
  type DispatchGpsAuditEntry
} from "@bussin/shared";

function dateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dayBounds(key: string) {
  const [year, month, day] = key.split("-").map(Number);
  const from = new Date(year, month - 1, day);
  const to = new Date(year, month - 1, day + 1);
  return { from: from.toISOString(), to: to.toISOString() };
}

function time(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
    .format(new Date(value));
}

function statusClass(status: BoardTrip["status"]) {
  return `transit-status transit-status-${status}`;
}

function eventLabel(entry: DispatchGpsAuditEntry) {
  if (entry.kind === "sample") return "GPS capture";
  if (entry.kind === "journey") return entry.action === "arrived_stop" ? "Auto arrived" : "Auto departed";
  if (entry.kind === "correction") return "Arrival undone";
  return "GPS resumed";
}

function eventTime(entry: DispatchGpsAuditEntry) {
  return entry.kind === "sample" ? entry.observedAt :
    entry.kind === "gap" ? entry.resumedAt : entry.occurredAt;
}

function eventDetail(entry: DispatchGpsAuditEntry) {
  if (entry.kind === "sample") {
    return `±${Math.round(entry.accuracyM)} m · ${entry.latitude.toFixed(5)}, ${entry.longitude.toFixed(5)}`;
  }
  if (entry.kind === "journey" || entry.kind === "correction") return entry.stopLabel;
  return `No accepted captures for ${entry.durationSeconds}s`;
}

export function TransitPage() {
  const [date, setDate] = useState(() => dateKey(new Date()));
  const [trips, setTrips] = useState<BoardTrip[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [audit, setAudit] = useState<DispatchGpsAuditEntry[]>([]);
  const [query, setQuery] = useState("");
  const [exceptionsOnly, setExceptionsOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [auditLoading, setAuditLoading] = useState(false);
  const [error, setError] = useState("");
  const [auditError, setAuditError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      try {
        const params = new URLSearchParams(dayBounds(date));
        const response = await fetch(`/api/dispatch/board?${params}`, {
          credentials: "same-origin",
          signal: controller.signal
        });
        if (!response.ok) throw new Error("Could not load transit history.");
        const data = boardResponseSchema.parse(await response.json());
        setTrips(data.trips);
        setSelectedId((current) =>
          current && data.trips.some((trip) => trip.id === current)
            ? current
            : data.trips[0]?.id ?? null
        );
        setError("");
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "Could not load transit history.");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [date]);

  const selected = trips.find((trip) => trip.id === selectedId) ?? null;

  useEffect(() => {
    if (!selectedId) {
      setAudit([]);
      return;
    }
    const controller = new AbortController();
    async function loadAudit() {
      setAuditLoading(true);
      try {
        const response = await fetch(`/api/dispatch/trips/${selectedId}/gps-audit`, {
          credentials: "same-origin",
          signal: controller.signal
        });
        if (!response.ok) throw new Error("Could not load trip events.");
        const data = dispatchGpsAuditResponseSchema.parse(await response.json());
        setAudit(data.entries);
        setAuditError("");
      } catch (cause) {
        if (!controller.signal.aborted) {
          setAuditError(cause instanceof Error ? cause.message : "Could not load trip events.");
        }
      } finally {
        if (!controller.signal.aborted) setAuditLoading(false);
      }
    }
    void loadAudit();
    return () => controller.abort();
  }, [selectedId]);

  const visibleTrips = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return trips.filter((trip) => {
      const hasException =
        trip.status === "cancelled" ||
        (trip.status === "active" && (!trip.location ||
          Date.now() - Date.parse(trip.location.observedAt) > 60_000));
      if (exceptionsOnly && !hasException) return false;
      if (!needle) return true;
      return [trip.busLabel, trip.routeName, trip.assignedStaff?.displayName ?? "", trip.status]
        .some((value) => value.toLowerCase().includes(needle));
    });
  }, [trips, query, exceptionsOnly]);

  return (
    <section className="transit-page">
      <header className="page-head">
        <div>
          <p className="eyebrow">OPERATIONS / TRANSIT</p>
          <h1>Transit</h1>
          <p className="description">Each trip and every recorded operational event.</p>
        </div>
      </header>

      {error && <p className="auth-error" role="alert">{error}</p>}

      <div className="transit-controls">
        <label>
          Day
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </label>
        <label className="transit-search">
          Search
          <input
            type="search"
            placeholder="Bus, route, driver or status"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label className="transit-check">
          <input
            type="checkbox"
            checked={exceptionsOnly}
            onChange={(event) => setExceptionsOnly(event.target.checked)}
          />
          Exceptions only
        </label>
      </div>

      <div className="transit-split">
        <div className="transit-list" aria-label="Trips">
          {loading ? <p className="transit-empty">Loading trips…</p> :
            visibleTrips.length === 0 ? <p className="transit-empty">No trips match this view.</p> :
            visibleTrips.map((trip) => (
              <button
                key={trip.id}
                type="button"
                className={`transit-trip${trip.id === selectedId ? " is-selected" : ""}`}
                onClick={() => setSelectedId(trip.id)}
              >
                <span className="transit-trip-main">
                  <strong>{trip.busLabel}</strong>
                  <span>{trip.routeName} · {trip.servicePeriod}</span>
                  <small>{time(trip.departureAt)} · {trip.assignedStaff?.displayName ?? "Unassigned"}</small>
                </span>
                <span className={statusClass(trip.status)}>{trip.status}</span>
              </button>
            ))}
        </div>

        <article className="transit-detail">
          {!selected ? (
            <div className="transit-empty-detail">
              <p className="eyebrow">TRANSIT</p>
              <h2>Select a trip</h2>
              <p>Choose a trip to inspect its stops and recorded event history.</p>
            </div>
          ) : (
            <>
              <div className="transit-detail-head">
                <div>
                  <p className="eyebrow">{selected.busLabel} / {selected.servicePeriod}</p>
                  <h2>{selected.routeName}</h2>
                  <p>{time(selected.departureAt)} · {selected.assignedStaff?.displayName ?? "Unassigned"}</p>
                </div>
                <span className={statusClass(selected.status)}>{selected.status}</span>
              </div>

              <dl className="transit-facts">
                <div><dt>Stops</dt><dd>{selected.stops.length}</dd></div>
                <div><dt>Arrived</dt><dd>{selected.stops.filter((stop) => stop.arrivedAt).length}</dd></div>
                <div><dt>Last GPS</dt><dd>{selected.location ? time(selected.location.observedAt) : "—"}</dd></div>
              </dl>

              <section className="transit-section">
                <div className="transit-section-head">
                  <h3>Stops</h3>
                  <span>Recorded truth</span>
                </div>
                <ol className="transit-stops">
                  {selected.stops.map((stop) => (
                    <li key={stop.id} className={stop.arrivedAt ? "is-done" : ""}>
                      <i aria-hidden="true" />
                      <div>
                        <strong>{stop.position}. {stop.label}</strong>
                        <span>
                          {stop.arrivedAt ? `Arrived ${time(stop.arrivedAt)}` : "No arrival recorded"}
                          {stop.departedAt ? ` · departed ${time(stop.departedAt)}` : ""}
                        </span>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>

              <section className="transit-section">
                <div className="transit-section-head">
                  <h3>Event log</h3>
                  <span>{audit.length} entries</span>
                </div>
                {auditError && <p className="auth-error" role="alert">{auditError}</p>}
                {auditLoading ? <p>Loading events…</p> :
                  audit.length === 0 ? <p>No GPS or journey events recorded.</p> :
                  <ol className="transit-events">
                    {audit.map((entry) => (
                      <li key={entry.id}>
                        <time dateTime={eventTime(entry)}>{time(eventTime(entry))}</time>
                        <div>
                          <strong>{eventLabel(entry)}</strong>
                          <span>{eventDetail(entry)}</span>
                        </div>
                      </li>
                    ))}
                  </ol>}
              </section>
            </>
          )}
        </article>
      </div>
    </section>
  );
}

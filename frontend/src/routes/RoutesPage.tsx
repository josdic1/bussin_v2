import { useEffect, useState, type FormEvent } from "react";
import {
  createRouteSchema,
  routeSchema,
  routesResponseSchema,
  type Coordinate,
  type Route
} from "@bussin/shared";
import { useAuth } from "../auth/AuthProvider";
import { StopPickerMap } from "../maps/StopPickerMap";

type DraftStop = Coordinate & { label: string };

function roundCoordinate(value: number) {
  return Number(value.toFixed(6));
}

export function RoutesPage() {
  const { member } = useAuth();
  const canManage = member?.roles.includes("admin") ?? false;
  const [routes, setRoutes] = useState<Route[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [stopLabel, setStopLabel] = useState("");
  const [stops, setStops] = useState<DraftStop[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const controller = new AbortController();

    async function loadRoutes() {
      try {
        const response = await fetch("/api/routes", {
          credentials: "same-origin",
          signal: controller.signal
        });
        if (!response.ok) throw new Error("Could not load routes.");
        const data = routesResponseSchema.parse(await response.json());
        setRoutes(data.routes);
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "Could not load routes.");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    void loadRoutes();
    return () => controller.abort();
  }, []);

  function pickStop(coordinate: Coordinate) {
    const label = stopLabel.trim();
    if (!label) {
      setError("Name the stop, then click its location on the map.");
      return;
    }

    setStops((current) => [...current, {
      label,
      latitude: roundCoordinate(coordinate.latitude),
      longitude: roundCoordinate(coordinate.longitude)
    }]);
    setStopLabel("");
    setError("");
    setNotice("");
  }

  function moveStop(index: number, coordinate: Coordinate) {
    setStops((current) => current.map((stop, position) =>
      position === index
        ? {
            ...stop,
            latitude: roundCoordinate(coordinate.latitude),
            longitude: roundCoordinate(coordinate.longitude)
          }
        : stop
    ));
  }

  function changeStop(index: number, label: string) {
    setStops((current) => current.map((stop, position) =>
      position === index ? { ...stop, label } : stop
    ));
  }

  function reorderStop(index: number, direction: -1 | 1) {
    setStops((current) => {
      const next = [...current];
      const target = index + direction;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function saveRoute(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice("");

    const parsed = createRouteSchema.safeParse({ name, stops });
    if (!parsed.success) {
      setError("Give the route a name and place at least one named stop.");
      return;
    }

    setSaving(true);
    setError("");

    try {
      const response = await fetch("/api/routes", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data)
      });

      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const message =
          body && typeof body === "object" && "error" in body &&
          typeof body.error === "string"
            ? body.error
            : "Could not save route.";
        throw new Error(message);
      }

      const route = routeSchema.parse(await response.json());
      setRoutes((current) =>
        [...current, route].sort((a, b) => a.name.localeCompare(b.name))
      );
      setName("");
      setStopLabel("");
      setStops([]);
      setNotice(`${route.name} saved with ${route.stops.length} stops.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save route.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <p className="eyebrow">OPERATIONS</p>
      <h1>Routes</h1>
      <p className="description">Set up the stops each bus will visit.</p>

      <section className="fleet-section" aria-label="Saved routes">
        <h2>Saved routes</h2>
        {loading ? (
          <p>Loading routes…</p>
        ) : routes.length === 0 ? (
          <p>No routes added yet.</p>
        ) : (
          <ul className="route-saved-list">
            {routes.map((route) => (
              <li key={route.id}>
                <strong>{route.name}</strong>
                <span>{route.stops.length} stops</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {canManage && (
        <form className="route-form" onSubmit={(event) => void saveRoute(event)}>
          <h2>Add a route</h2>
          <label htmlFor="route-name">Route name</label>
          <input
            id="route-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="For example, Afternoon route"
            maxLength={120}
            required
          />

          <label htmlFor="stop-name">Next stop name</label>
          <input
            id="stop-name"
            value={stopLabel}
            onChange={(event) => setStopLabel(event.target.value)}
            placeholder="Name the stop, then click its location"
            maxLength={120}
          />
          <p className="route-hint">
            Click the map to place a stop. Drag a marker to correct its position.
          </p>

          <StopPickerMap
            stops={stops}
            onPick={pickStop}
            onMove={moveStop}
          />

          {stops.length > 0 && (
            <ol className="route-draft-list">
              {stops.map((stop, index) => (
                <li key={index}>
                  <label htmlFor={`stop-${index}`}>Stop {index + 1}</label>
                  <input
                    id={`stop-${index}`}
                    value={stop.label}
                    onChange={(event) => changeStop(index, event.target.value)}
                    maxLength={120}
                  />
                  <div className="route-stop-actions">
                    <button type="button" disabled={index === 0}
                      onClick={() => reorderStop(index, -1)}>Up</button>
                    <button type="button" disabled={index === stops.length - 1}
                      onClick={() => reorderStop(index, 1)}>Down</button>
                    <button type="button" onClick={() =>
                      setStops((current) => current.filter((_, position) => position !== index))
                    }>Remove</button>
                  </div>
                </li>
              ))}
            </ol>
          )}

          <button className="auth-button" disabled={saving || stops.length === 0}>
            {saving ? "Saving…" : "Save route"}
          </button>
        </form>
      )}

      {error && <p className="auth-error" role="alert">{error}</p>}
      {notice && <p className="route-notice" role="status">{notice}</p>}
    </>
  );
}

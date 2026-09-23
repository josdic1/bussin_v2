import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  addressSearchResponseSchema,
  createRouteSchema,
  routeSchema,
  routesResponseSchema,
  updateRouteSchema,
  type AddressSearchResult,
  type Coordinate,
  type Route
} from "@bussin/shared";
import { useAuth } from "../auth/AuthProvider";
import { StopPickerMap } from "../maps/StopPickerMap";

type DraftStop = Coordinate & { label: string; id?: string };

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
  const [address, setAddress] = useState("");
  const [matches, setMatches] = useState<AddressSearchResult[]>([]);
  const [candidate, setCandidate] = useState<AddressSearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const searchController = useRef<AbortController | null>(null);
  const [saving, setSaving] = useState(false);
  const [editingRouteId, setEditingRouteId] = useState<string | null>(null);
  const [busyRouteId, setBusyRouteId] = useState<string | null>(null);
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

  useEffect(() => () => searchController.current?.abort(), []);

  async function searchAddress() {
    const query = address.trim();
    if (query.length < 5) {
      setSearchError("Enter a full address or place name.");
      return;
    }

    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    setSearching(true);
    setSearchError("");
    setMatches([]);
    setCandidate(null);

    try {
      const response = await fetch(
        `/api/geocode/search?q=${encodeURIComponent(query)}`,
        { credentials: "same-origin", signal: controller.signal }
      );
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const message =
          body && typeof body === "object" && "error" in body &&
          typeof body.error === "string"
            ? body.error
            : "Could not find that address.";
        throw new Error(message);
      }
      const data = addressSearchResponseSchema.parse(await response.json());
      if (!controller.signal.aborted) {
        setMatches(data.results);
        if (data.results.length === 0) setSearchError("No matching locations found.");
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        setSearchError(cause instanceof Error ? cause.message : "Search failed.");
      }
    } finally {
      if (!controller.signal.aborted) setSearching(false);
    }
  }

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
    setAddress("");
    setCandidate(null);
    setMatches([]);
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

  function cancelEdit() {
    setEditingRouteId(null);
    setName("");
    setStops([]);
    setStopLabel("");
    setCandidate(null);
    setAddress("");
    setMatches([]);
  }

  function editRoute(route: Route) {
    setEditingRouteId(route.id);
    setName(route.name);
    setStops(route.stops.map(({ id, label, latitude, longitude }) =>
      ({ id, label, latitude, longitude })));
    setStopLabel("");
    setCandidate(null);
    setAddress("");
    setMatches([]);
    setError("");
    setNotice("");
    document.getElementById("route-name")?.focus();
  }

  async function readError(response: Response): Promise<string> {
    const body: unknown = await response.json().catch(() => null);
    return body && typeof body === "object" && "error" in body &&
      typeof body.error === "string" ? body.error : "Could not change route.";
  }

  async function changeStatus(route: Route) {
    setBusyRouteId(route.id);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/routes/${route.id}/status`, {
        method: "PATCH", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !route.active })
      });
      if (!response.ok) throw new Error(await readError(response));
      const status: unknown = await response.json();
      if (!status || typeof status !== "object" || !("active" in status) ||
          typeof status.active !== "boolean") throw new Error("Invalid route status.");
      setRoutes((current) => current.map((item) => item.id === route.id
        ? { ...item, active: status.active as boolean } : item));
      setNotice(`${route.name} ${status.active ? "reactivated" : "deactivated"}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change route.");
    } finally {
      setBusyRouteId(null);
    }
  }

  async function deleteRoute(route: Route) {
    if (!window.confirm(`Delete ${route.name} and all its stops? This cannot be undone.`)) return;
    setBusyRouteId(route.id);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/routes/${route.id}`, {
        method: "DELETE", credentials: "same-origin"
      });
      if (!response.ok) throw new Error(await readError(response));
      setRoutes((current) => current.filter((item) => item.id !== route.id));
      if (editingRouteId === route.id) cancelEdit();
      setNotice(`${route.name} deleted.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete route.");
    } finally {
      setBusyRouteId(null);
    }
  }

  async function saveRoute(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice("");

    const parsed = editingRouteId
      ? updateRouteSchema.safeParse({ name, stops })
      : createRouteSchema.safeParse({ name, stops });
    if (!parsed.success) {
      setError("Give the route a name and place at least one named stop.");
      return;
    }

    setSaving(true);
    setError("");

    try {
      const response = await fetch(editingRouteId ? `/api/routes/${editingRouteId}` : "/api/routes", {
        method: editingRouteId ? "PUT" : "POST",
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
        [...current.filter((item) => item.id !== route.id), route]
          .sort((a, b) => a.name.localeCompare(b.name))
      );
      cancelEdit();
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
                <div className="route-saved-details">
                  <strong>{route.name}</strong>
                  <span>{route.stops.length} stops · {route.active ? "Active" : "Inactive"}</span>
                </div>
                {canManage && <div className="route-saved-actions">
                  <button type="button" disabled={!!busyRouteId || saving}
                    onClick={() => editRoute(route)}>Edit</button>
                  <button type="button" disabled={!!busyRouteId || saving}
                    onClick={() => void changeStatus(route)}>
                    {route.active ? "Deactivate" : "Reactivate"}
                  </button>
                  <button type="button" disabled={!!busyRouteId || saving}
                    onClick={() => void deleteRoute(route)}>Delete</button>
                </div>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {canManage && (
        <form className="route-form" onSubmit={(event) => void saveRoute(event)}>
          <h2>{editingRouteId ? "Edit route" : "Add a route"}</h2>
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
          <label htmlFor="route-address">Find an address or place</label>
          <div className="route-address-row">
            <input
              id="route-address"
              type="search"
              value={address}
              placeholder="Street address, town, state"
              onChange={(event) => {
                setAddress(event.target.value);
                searchController.current?.abort();
                setSearching(false);
                setMatches([]);
                setCandidate(null);
                setSearchError("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void searchAddress();
                }
              }}
            />
            <button
              className="auth-button"
              type="button"
              disabled={searching}
              onClick={() => void searchAddress()}
            >
              {searching ? "Finding…" : "Find address"}
            </button>
          </div>
          {searchError && <p className="auth-error" role="alert">{searchError}</p>}
          {matches.length > 0 && (
            <ul className="route-address-results" aria-label="Address matches">
              {matches.map((match, index) => (
                <li key={`${match.label}-${index}`}>
                  <button type="button" onClick={() => {
                    setCandidate(match);
                    setMatches([]);
                    setSearchError("");
                  }}>
                    {match.label}
                    {match.locationType === "place" && (
                      <span> · approximate location</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {candidate && (
            <div className="route-address-selected">
              <p><strong>Selected:</strong> {candidate.label}</p>
              <p>Drag the orange pin to the pickup point. Name the stop above, then add it.</p>
              <button type="button" onClick={() => pickStop(candidate)}>
                Add stop at this location
              </button>
            </div>
          )}
          <p className="route-hint">
            You can also click the map to place a stop. Drag a saved marker to correct it.
            {" "}Address search by <a href="https://www.geoapify.com/"
              target="_blank" rel="noreferrer">Geoapify</a>.
          </p>

          <StopPickerMap
            focus={candidate}
            onFocusMove={(coordinate) => setCandidate((current) =>
              current ? { ...current, ...coordinate } : null
            )}
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
            {saving ? "Saving…" : editingRouteId ? "Save changes" : "Save route"}
          </button>
          {editingRouteId && <button type="button" className="route-cancel"
            disabled={saving} onClick={cancelEdit}>Cancel editing</button>}
        </form>
      )}

      {error && <p className="auth-error" role="alert">{error}</p>}
      {notice && <p className="route-notice" role="status">{notice}</p>}
    </>
  );
}

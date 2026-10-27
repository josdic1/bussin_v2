import { useState, type FormEvent } from "react";
import { updatePlannedTripSchema, type BoardTrip, type Bus, type Route } from "@bussin/shared";
import { message, send } from "../ops/api";
import { ErrorNote } from "../ops/ui";

function localDeparture(value: string) {
  const date = new Date(value);
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 19);
}

export function EditTripForm({ trip, buses, routes, onSaved, onClose }: {
  trip: BoardTrip; buses: Bus[]; routes: Route[];
  onSaved: (departureAt: string) => void; onClose: () => void;
}) {
  // Keep the plan shown when the editor opened, even if the board polls meanwhile.
  const [original] = useState(() => ({ routeId: trip.routeId, busId: trip.busId, departureAt: trip.departureAt }));
  const [routeId, setRouteId] = useState(original.routeId);
  const [busId, setBusId] = useState(original.busId);
  const [departure, setDeparture] = useState(() => localDeparture(original.departureAt));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const availableBuses = buses.filter((bus) => bus.active || bus.id === original.busId);
  const availableRoutes = routes.filter((route) => (route.active && route.stops.length) || route.id === original.routeId);

  async function save(event: FormEvent) {
    event.preventDefault();
    const date = new Date(departure);
    const departureAt = departure === localDeparture(original.departureAt)
      ? original.departureAt : Number.isFinite(date.getTime()) ? date.toISOString() : "";
    const input = updatePlannedTripSchema.safeParse({ routeId, busId, departureAt, expected: original });
    if (!input.success) { setError("Select a bus, route and departure time."); return; }
    setSaving(true);
    setError("");
    try {
      await send("PUT", `/api/dispatch/trips/${trip.id}`, input.data, "Could not save the trip.");
      onSaved(input.data.departureAt);
    } catch (cause) {
      setError(message(cause, "Could not save the trip."));
    } finally {
      setSaving(false);
    }
  }

  return <form className="planf dblock" aria-label="Edit planned trip" onSubmit={(event) => void save(event)}>
    <h3>Edit trip</h3>
    <div className="ctl-row"><label htmlFor={`edit-bus-${trip.id}`}>Bus</label>
      <select id={`edit-bus-${trip.id}`} value={busId} disabled={saving} onChange={(event) => setBusId(event.target.value)}>
        {availableBuses.map((bus) => <option key={bus.id} value={bus.id}>{bus.label}</option>)}
      </select></div>
    <div className="ctl-row"><label htmlFor={`edit-route-${trip.id}`}>Route</label>
      <select id={`edit-route-${trip.id}`} value={routeId} disabled={saving} onChange={(event) => setRouteId(event.target.value)}>
        {!availableRoutes.some((route) => route.id === original.routeId) && <option value={original.routeId}>{trip.routeName} · {trip.servicePeriod}</option>}
        {availableRoutes.map((route) => <option key={route.id} value={route.id}>{route.name} · {route.servicePeriod}</option>)}
      </select></div>
    <div className="ctl-row"><label htmlFor={`edit-departure-${trip.id}`}>Departure</label>
      <input id={`edit-departure-${trip.id}`} type="datetime-local" step="1" required value={departure}
        disabled={saving} onChange={(event) => setDeparture(event.target.value)} /></div>
    <p className="hint">Changing the route replaces its stops and expected riders. Trips with recorded rider checks keep their route.</p>
    <ErrorNote text={error} />
    <div className="acts">
      <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Saving…" : "Save changes"}</button>
      <button type="button" className="btn" disabled={saving} onClick={onClose}>Close editor</button>
    </div>
  </form>;
}

import { useState } from "react";
import { useDemo } from "./useDemo";
import "./demo.css";

/** Demo only: remove one ride and everything recorded on it. Hidden on the real app. */
export function DemoDeleteRide({ tripId, onDeleted }: { tripId: string; onDeleted: () => void }) {
  const info = useDemo();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!info?.demo) return null;

  async function remove() {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/demo/trips/${tripId}`, { method: "DELETE", credentials: "same-origin", headers: { "Content-Type": "application/json" } });
      if (!response.ok) throw new Error("Could not delete the ride.");
      onDeleted();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not delete the ride."); setBusy(false); }
  }

  return <div className="demo-del">
    {asking
      ? <><span>Delete this ride? Its GPS, check-ins and messages go too.</span>
        <button type="button" className="demo-del-yes" disabled={busy} onClick={() => void remove()}>{busy ? "Deleting…" : "Delete ride"}</button>
        <button type="button" disabled={busy} onClick={() => setAsking(false)}>Keep it</button></>
      : <button type="button" onClick={() => setAsking(true)}>Delete this ride <small>DEMO</small></button>}
    {error && <p className="demo-error" role="alert">{error}</p>}
  </div>;
}

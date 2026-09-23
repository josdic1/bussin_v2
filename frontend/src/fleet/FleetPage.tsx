import { useEffect, useState, type FormEvent } from "react";
import {
  busSchema,
  busesResponseSchema,
  createBusSchema,
  type Bus
} from "@bussin/shared";
import { useAuth } from "../auth/AuthProvider";

export function FleetPage() {
  const { member } = useAuth();
  const [buses, setBuses] = useState<Bus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const canManage = member?.roles.includes("admin") ?? false;

  useEffect(() => {
    const controller = new AbortController();

    async function loadBuses() {
      try {
        const response = await fetch("/api/fleet/buses", {
          credentials: "same-origin",
          signal: controller.signal
        });
        if (!response.ok) throw new Error("Could not load buses.");

        const data = busesResponseSchema.parse(await response.json());
        setBuses(data.buses);
        setError("");
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "Could not load buses.");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    void loadBuses();
    return () => controller.abort();
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
        const message =
          body && typeof body === "object" && "error" in body &&
          typeof body.error === "string"
            ? body.error
            : "Could not add bus.";
        throw new Error(message);
      }

      const bus = busSchema.parse(await response.json());
      setBuses((current) =>
        [...current, bus].sort((a, b) => a.label.localeCompare(b.label))
      );
      setLabel("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add bus.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <p className="eyebrow">OPERATIONS</p>
      <h1>Fleet</h1>
      <p className="description">The buses available for JCC trips.</p>

      {canManage && (
        <form className="fleet-form" onSubmit={(event) => void addBus(event)}>
          <label htmlFor="bus-label">Add a bus</label>
          <div className="fleet-form-row">
            <input
              id="bus-label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="For example, Bus 1"
              maxLength={80}
              disabled={saving}
              required
            />
            <button className="auth-button" type="submit" disabled={saving}>
              {saving ? "Adding…" : "Add bus"}
            </button>
          </div>
        </form>
      )}

      {error && <p className="auth-error" role="alert">{error}</p>}

      <section className="fleet-section" aria-label="Buses">
        <h2>Buses</h2>
        {loading ? (
          <p>Loading buses…</p>
        ) : buses.length === 0 ? (
          <p>No buses added yet.</p>
        ) : (
          <ul className="fleet-list">
            {buses.map((bus) => (
              <li key={bus.id} className="fleet-item">
                <strong>{bus.label}</strong>
                <span>{bus.active ? "Available" : "Inactive"}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

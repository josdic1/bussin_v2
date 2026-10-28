import { useState, type FormEvent } from "react";
import { dataEditResponseSchema, type DataRow } from "@bussin/shared";
import { message, send } from "../ops/api";
import { tidyPhone } from "../ops/contact";

// Inline "add a driver" form for the Drivers table in Data mode.
// Drivers are names on a trip, not logins: just a name and an optional phone.
export function AddDriver({ onAdded }: { onAdded: (row: DataRow) => void }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) { setError("Enter the driver's name."); return; }
    setBusy(true);
    setError("");
    try {
      const body = await send("POST", "/api/data/drivers", { name, phone }, "Couldn't add that driver.");
      onAdded(dataEditResponseSchema.parse(body).row);
      setName("");
      setPhone("");
    } catch (cause) {
      setError(message(cause, "Couldn't add that driver."));
    } finally {
      setBusy(false);
    }
  }

  return <form className="dm-add" onSubmit={(event) => void submit(event)}>
    <input aria-label="Driver name" placeholder="Driver name" value={name} maxLength={120}
      onChange={(event) => setName(event.target.value)} />
    <input aria-label="Driver phone" placeholder="Phone (optional)" type="tel" value={phone} maxLength={40}
      onChange={(event) => setPhone(event.target.value)} onBlur={() => setPhone(tidyPhone(phone))} />
    <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Adding…" : "Add driver"}</button>
    {error && <span className="dm-add-err" role="alert">{error}</span>}
  </form>;
}

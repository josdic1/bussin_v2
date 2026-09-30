import { useEffect, useState } from "react";
import { adminResetCountsSchema, RESET_CONFIRMATION, type AdminResetCounts } from "@bussin/shared";
import { getJson, message, send } from "./api";
import { Overlay } from "./OpsShell";

const ROWS: [keyof AdminResetCounts, string][] = [
  ["buses", "Buses"],
  ["routes", "Routes and their stops"],
  ["trips", "Trips, with every stop event, GPS fix and ride check"],
  ["riders", "Riders"],
  ["guardians", "Guardians and family logins"],
  ["members", "Staff and dispatch logins"]
];

/** Admin-only: wipe everything except admin logins, behind a typed confirmation. */
export function DangerZone({ compact }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className={compact ? "danger-link" : "danger-zone"} onClick={() => setOpen(true)}>
      {compact ? "Danger zone" : <><b>Danger zone</b><small>Reset all data except admins</small></>}
    </button>
    {open && <ResetDialog onClose={() => setOpen(false)} />}
  </>;
}

function ResetDialog({ onClose }: { onClose: () => void }) {
  const [counts, setCounts] = useState<AdminResetCounts | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    getJson("/api/admin/reset", adminResetCountsSchema, controller.signal)
      .then(setCounts)
      .catch((cause) => { if (!controller.signal.aborted) setError(message(cause, "Could not load current totals.")); });
    return () => controller.abort();
  }, []);

  async function reset() {
    setBusy(true);
    setError("");
    try {
      await send("POST", "/api/admin/reset", { confirm: RESET_CONFIRMATION }, "Reset failed. Nothing was deleted.");
      window.location.assign("/");
    } catch (cause) {
      setError(message(cause, "Reset failed. Nothing was deleted."));
      setBusy(false);
    }
  }

  const ready = typed.trim() === RESET_CONFIRMATION;

  return <Overlay onClose={busy ? () => undefined : onClose}>
    <p className="eyebrow" style={{ color: "var(--bad)" }}>Danger zone</p>
    <h2 className="dt">Reset everything except admins</h2>
    <p className="hint" style={{ fontSize: 13, lineHeight: 1.5 }}>
      This permanently deletes the data below and starts Bussin fresh. Admin logins stay, and you stay signed in.
      There is no undo, so back up the database first if you might need any of it.
    </p>
    <div className="reset-list">
      {ROWS.map(([key, label]) => <div key={key}>
        <span>{label}</span><b>{counts ? counts[key] : "…"}</b>
      </div>)}
      <div className="keep"><span>Admin logins kept</span><b>{counts ? counts.keptAdmins : "…"}</b></div>
    </div>
    <div className="ctl-row" style={{ marginTop: 14 }}>
      <label htmlFor="reset-confirm">Type {RESET_CONFIRMATION} to confirm</label>
      <input id="reset-confirm" autoComplete="off" autoCapitalize="characters" spellCheck={false}
        value={typed} disabled={busy} onChange={(event) => setTyped(event.target.value)} />
    </div>
    {error && <p className="err" role="alert">{error}</p>}
    <div className="acts">
      <button type="button" className="btn reset-go" disabled={!ready || busy || !counts} onClick={() => void reset()}>
        {busy ? "Resetting…" : "Reset all data except admins"}
      </button>
      <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
    </div>
  </Overlay>;
}

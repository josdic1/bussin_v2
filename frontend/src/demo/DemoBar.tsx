import { useState } from "react";
import { fillHistory, resetDemo, signInAs, useDemo, type HistorySpan, type Who } from "./useDemo";
import "./demo.css";

/** A small DEMO button on every screen of the demo copy: switch person, or start the run over. */
export function DemoBar() {
  const info = useDemo();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  if (!info?.demo || !info.ready) return null;

  async function run(task: () => Promise<void>) {
    setBusy(true); setError("");
    try { await task(); } catch (cause) { setError(cause instanceof Error ? cause.message : "That didn't work."); setBusy(false); }
  }
  const people: [Who, string][] = [["office", "Office"], ["counselor", "Counselor"], ["parent", "Parent"]];

  return <div className={`demo-bar${open ? " open" : ""}`}>
    {open && <div className="demo-panel" role="dialog" aria-label="Demo controls">
      <p className="demo-tag">DEMO · MADE-UP CAMP</p>
      <h3>Switch to</h3>
      <div className="demo-row">{people.map(([who, label]) => <button key={who} type="button" disabled={busy || !info.people[who]}
        onClick={() => void run(() => signInAs(who))}>{label}<small>{info.people[who] ?? "None"}</small></button>)}</div>
      <h3>Start over</h3>
      <div className="demo-row">
        <button type="button" disabled={busy} onClick={() => void run(() => resetDemo("AM"))}>Morning run<small>Buses leave in 3 min</small></button>
        <button type="button" disabled={busy} onClick={() => void run(() => resetDemo("PM"))}>Afternoon run<small>Buses leave in 3 min</small></button>
      </div>
      <h3>Fill in the past</h3>
      <div className="demo-row">{([["day", "A day"], ["week", "A week"], ["month", "A month"], ["season", "Season"]] as [HistorySpan, string][]).map(([span, label]) =>
        <button key={span} type="button" disabled={busy} onClick={() => void run(async () => {
          const result = await fillHistory(span);
          setNote(result.trips ? `Added ${result.trips} past trips.` : "Those days are already filled in.");
          setBusy(false);
        })}>{label}</button>)}</div>
      {note && <p className="demo-note" role="status">{note}</p>}
      <p className="demo-note">Start over clears every trip, check and message for everyone using the demo.</p>
      {error && <p className="demo-error" role="alert">{error}</p>}
    </div>}
    <button type="button" className="demo-btn" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Close" : "DEMO"}</button>
  </div>;
}

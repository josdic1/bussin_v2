import { useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { clearDemo, drive, resetDemo, signInAs, useDemo, type Keep, type Who } from "./useDemo";
import "./demo.css";

/*
 * The DEMO button on every screen of the demo copy: switch person, start the run over,
 * fill in past days, wipe parts of the camp, or build a different camp. Never on the real app.
 */

const KEEP_LABELS: [keyof Keep, string, string][] = [
  ["setup", "Camp setup", "Lines, stops, buses, schedule"],
  ["team", "Team", "Counselors and drivers"],
  ["kids", "Kids and parents", "Riders, parents, parent logins"],
  ["history", "Trips", "Past and upcoming rides, GPS, check-ins"],
  ["messages", "Messages", "Messages to families, alerts from buses"]
];

/** What a choice really keeps: trips need the setup, team and kids; messages need trips and kids. */
function effective(keep: Keep): Keep {
  const history = keep.history && keep.setup && keep.team && keep.kids;
  return { ...keep, history, messages: keep.messages && history && keep.kids };
}

export function DemoBar() {
  const info = useDemo();
  const { member } = useAuth();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [wiping, setWiping] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [speed, setSpeed] = useState<number | null>(null);
  const [keep, setKeep] = useState<Keep>({ setup: true, team: true, kids: true, history: true, messages: true });
  // Before a camp exists the welcome page is the whole demo; only a signed-in admin needs the button then.
  if (!info?.demo || (!info.ready && !member)) return null;

  async function run(task: () => Promise<void>) {
    setBusy(true); setError(""); setNote("");
    try { await task(); } catch (cause) { setError(cause instanceof Error ? cause.message : "That didn't work."); setBusy(false); }
  }
  const people: [Who, string][] = [["office", "Office"], ["counselor", "Counselor"], ["parent", "Parent"]];
  const real = effective(keep);
  const gone = KEEP_LABELS.filter(([key]) => !real[key]).map(([, label]) => label.toLowerCase());

  return <div className={`demo-bar${open ? " open" : ""}`}>
    {open && <div className="demo-panel" role="dialog" aria-label="Demo controls">
      <p className="demo-tag">DEMO · {info.camp.toUpperCase()}</p>

      {!info.ready ? <>
        <h3>No camp yet</h3>
        <button type="button" className="demo-wide" disabled={busy}
          onClick={() => void run(() => clearDemo({ setup: false, team: false, kids: false, history: false, messages: false }))}>Build a camp</button>
      </> : wiping ? <>
        <h3>Keep</h3>
        <div className="demo-keep">{KEEP_LABELS.map(([key, label, sub]) => {
          const forced = keep[key] && !real[key];
          return <label key={key} className={forced ? "forced" : ""}>
            <input type="checkbox" checked={real[key]} disabled={busy || forced}
              onChange={(event) => { setKeep({ ...keep, [key]: event.target.checked }); setConfirming(false); }} />
            <span><b>{label}</b><small>{forced ? "Goes too: it needs what you're wiping" : sub}</small></span>
          </label>;
        })}
          <label className="forced"><input type="checkbox" checked disabled /><span><b>Office login</b><small>Always kept</small></span></label>
        </div>
        {!gone.length ? <p className="demo-note">Untick what you want wiped.</p>
          : confirming
            ? <div className="demo-row"><button type="button" className="demo-danger" disabled={busy} onClick={() => void run(() => clearDemo(keep))}>Yes, wipe it</button>
              <button type="button" disabled={busy} onClick={() => setConfirming(false)}>Go back</button></div>
            : <button type="button" className="demo-wide demo-danger" disabled={busy} onClick={() => setConfirming(true)}>Wipe {gone.join(", ")}</button>}
        {!real.setup && gone.length > 0 && <p className="demo-note">Without the camp setup, the demo goes back to the welcome page to build a new camp.</p>}
        <button type="button" className="demo-link" onClick={() => { setWiping(false); setConfirming(false); }}>Back</button>
      </> : <>
        <h3>Switch to</h3>
        <div className="demo-row">{people.map(([who, label]) => <button key={who} type="button" disabled={busy || !info.people[who]}
          onClick={() => void run(() => signInAs(who))}>{label}<small>{info.people[who] ?? "None"}</small></button>)}</div>
        <h3>Drive the buses</h3>
        <div className="demo-row demo-speed" role="radiogroup" aria-label="Robot driver">{([[0, "Off"], [1, "Real speed"], [5, "5x"], [15, "15x"]] as [0 | 1 | 5 | 15, string][]).map(([value, label]) =>
          <button key={value} type="button" role="radio" aria-checked={(speed ?? info.driving.speed) === value} className={(speed ?? info.driving.speed) === value ? "on" : ""}
            disabled={busy} onClick={() => void run(async () => { const state = await drive(value); setSpeed(state.speed); setBusy(false); })}>{label}</button>)}</div>
        <p className="demo-note">{(speed ?? info.driving.speed) ? "Buses leave when their run is due and drive the route by themselves. To really drive one, tap Start on the counselor screen first." : "Off: buses only move when someone drives with the counselor screen open."}</p>
        <h3>Start over</h3>
        <div className="demo-row">
          <button type="button" disabled={busy} onClick={() => void run(() => resetDemo("AM"))}>Morning run<small>Leaves in 3 min</small></button>
          <button type="button" disabled={busy} onClick={() => void run(() => resetDemo("PM"))}>Afternoon run<small>Leaves in 3 min</small></button>
        </div>
        <h3>Wipe</h3>
        <div className="demo-row">
          <button type="button" disabled={busy} onClick={() => { setKeep({ setup: true, team: true, kids: true, history: true, messages: true }); setWiping(true); }}>Choose what to keep<small>The rest is wiped</small></button>
          <button type="button" disabled={busy} onClick={() => { setKeep({ setup: false, team: false, kids: false, history: false, messages: false }); setWiping(true); }}>
            Different camp<small>Back to the welcome page</small></button>
        </div>
        {note && <p className="demo-note" role="status">{note}</p>}
        <p className="demo-note">Start over replaces today&rsquo;s and upcoming rides. Past days stay.</p>
      </>}
      {error && <p className="demo-error" role="alert">{error}</p>}
    </div>}
    <button type="button" className="demo-btn" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Close" : "DEMO"}</button>
  </div>;
}

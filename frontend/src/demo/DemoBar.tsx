import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { clearDemo, drive, loadDemo, refreshDemo, resetDemo, signInAs, useDemo, type DemoInfo, type Keep, type Who } from "./useDemo";
import "./demo.css";

/*
 * The DEMO button. Up front: who you are, who to switch to, and what the buses are doing.
 * Everything else (speed, wipe, different camp) waits in a closed "Admin tools" section.
 * Never shown on the real app.
 */

const KEEP_LABELS: [keyof Keep, string, string][] = [
  ["setup", "Camp setup", "Lines, stops, buses, schedule"],
  ["team", "Team", "Counselors and drivers"],
  ["kids", "Kids and parents", "Riders, parents, parent logins"],
  ["history", "Trips", "Past and upcoming rides, GPS, check-ins"],
  ["messages", "Messages", "Messages to families, alerts from buses"]
];

function effective(keep: Keep): Keep {
  const history = keep.history && keep.setup && keep.team && keep.kids;
  return { ...keep, history, messages: keep.messages && history && keep.kids };
}

/** One plain sentence about what the demo buses are doing right now. */
function happening(info: Extract<DemoInfo, { demo: true }>, now: number) {
  const d = info.driving;
  if (!d.speed) return "The robot driver is off. Buses only move if someone really drives one.";
  if (d.buses) return `${d.buses} ${d.buses === 1 ? "bus is" : "buses are"} driving their routes right now. Watch them on Today.`;
  if (d.nextRun) {
    const secs = Math.max(0, Math.round((Date.parse(d.nextRun.at) - now) / 1000));
    return `The ${d.nextRun.period === "AM" ? "morning" : "afternoon"} run leaves in about ${secs < 60 ? `${secs} seconds` : `${Math.round(secs / 60)} min`}.`;
  }
  return "The next run is about to leave.";
}

export function DemoBar() {
  const first = useDemo();
  const [info, setInfo] = useState<DemoInfo | null>(null);
  const { member } = useAuth();
  const [open, setOpen] = useState(false);
  const [tools, setTools] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [wiping, setWiping] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [keep, setKeep] = useState<Keep>({ setup: true, team: true, kids: true, history: true, messages: true });
  const current = info ?? first;

  // While the panel is open, keep its one line about the buses fresh.
  useEffect(() => {
    if (!open) return;
    const tick = () => { setNow(Date.now()); void refreshDemo().then(setInfo); };
    tick();
    const timer = window.setInterval(tick, 5_000);
    return () => window.clearInterval(timer);
  }, [open]);

  if (!current?.demo || (!current.ready && !member)) return null;

  async function run(task: () => Promise<void>) {
    setBusy(true); setError("");
    try { await task(); } catch (cause) { setError(cause instanceof Error ? cause.message : "That didn't work."); setBusy(false); }
  }
  const people: [Who, string][] = [["office", "Office"], ["counselor", "Counselor"], ["parent", "Parent"]];
  const real = effective(keep);
  const gone = KEEP_LABELS.filter(([key]) => !real[key]).map(([, label]) => label.toLowerCase());
  const you = member?.roles.includes("admin") ? "office" : member?.roles.includes("staff") ? "counselor" : member?.roles.includes("family") ? "parent" : null;

  return <div className={`demo-bar${open ? " open" : ""}`}>
    {open && <div className="demo-panel" role="dialog" aria-label="Demo controls">
      <p className="demo-tag">DEMO · {current.camp.toUpperCase()}</p>

      {!current.ready ? <>
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
        <p className="demo-now">{happening(current, now)}</p>
        <h3>See it as</h3>
        <div className="demo-row">{people.map(([who, label]) => <button key={who} type="button" className={you === who ? "on" : ""}
          disabled={busy || !current.people[who] || you === who}
          onClick={() => void run(() => signInAs(who))}>{label}<small>{you === who ? "You are here" : current.people[who] ?? "None"}</small></button>)}</div>

        <button type="button" className="demo-link" aria-expanded={tools} onClick={() => setTools(!tools)}>{tools ? "Hide admin tools" : "Admin tools"}</button>
        {tools && <div className="demo-tools">
          <h3>Robot driver</h3>
          <div className="demo-row demo-speed">{([[0, "Off"], [1, "Real speed"], [10, "Fast"]] as [0 | 1 | 10, string][]).map(([value, label]) =>
            <button key={value} type="button" className={current.driving.speed === value || (value === 10 && current.driving.speed > 1) ? "on" : ""} disabled={busy}
              onClick={() => void run(async () => { await drive(value); setInfo(await loadDemo()); setBusy(false); })}>{label}</button>)}</div>
          <h3>Send buses out now</h3>
          <div className="demo-row">
            <button type="button" disabled={busy} onClick={() => void run(() => resetDemo("AM"))}>Morning run</button>
            <button type="button" disabled={busy} onClick={() => void run(() => resetDemo("PM"))}>Afternoon run</button>
          </div>
          <h3>Wipe</h3>
          <div className="demo-row">
            <button type="button" disabled={busy} onClick={() => { setKeep({ setup: true, team: true, kids: true, history: true, messages: true }); setWiping(true); }}>Choose what to keep</button>
            <button type="button" disabled={busy} onClick={() => { setKeep({ setup: false, team: false, kids: false, history: false, messages: false }); setWiping(true); }}>Different camp</button>
          </div>
        </div>}
      </>}
      {error && <p className="demo-error" role="alert">{error}</p>}
    </div>}
    <button type="button" className="demo-btn" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Close" : "DEMO"}</button>
  </div>;
}

import { useState } from "react";
import { signInAs, type DemoInfo, type Who } from "./useDemo";
import "./demo.css";

/** On the demo's sign-in screen: one tap to see Bussin as each person. */
export function DemoLogin({ info }: { info: Extract<DemoInfo, { demo: true }> }) {
  const [busy, setBusy] = useState<Who | null>(null);
  const [error, setError] = useState("");
  const options: [Who, string, string][] = [
    ["office", "The camp office", "Every bus on one screen, live."],
    ["counselor", "A counselor on the bus", "Start the trip, check kids on and off."],
    ["parent", "A parent", "Where the bus is and when it gets to you."]
  ];
  async function go(who: Who) {
    setBusy(who); setError("");
    try { await signInAs(who); } catch (cause) { setError(cause instanceof Error ? cause.message : "That didn't work."); setBusy(null); }
  }
  return <div className="dm-login">
    <p className="dm-tag">DEMO · MADE-UP CAMP · NOTHING HERE IS REAL</p>
    <h2>See Bussin as</h2>
    {options.map(([who, title, sub]) => <button key={who} type="button" className="dm-pick" disabled={!!busy || !info.people[who]} onClick={() => void go(who)}>
      <b>{title}</b><span>{info.people[who] ? `${info.people[who]} · ${sub}` : "Nobody set up for this yet"}</span>
      <i aria-hidden="true">{busy === who ? "…" : "›"}</i>
    </button>)}
    {error && <p className="dm-error" role="alert">{error}</p>}
    <p className="dm-tip">Tip: open the office on a laptop and a parent on your phone. Run the bus and watch both.</p>
  </div>;
}

import { useState, type FormEvent } from "react";
import { buildCamp, type HistorySpan } from "./useDemo";
import "./demo.css";

/*
 * The first thing a visitor to the demo sees. Tells them plainly that this is the real
 * app, then sets up a camp: the standard one in one tap, or one sized like theirs.
 */

const STANDARD = { campName: "Camp Bussin", buses: 5, kids: 120 };
const PAST: [HistorySpan | "none", string, string][] = [
  ["none", "Just today", "Fresh start"], ["week", "A week", "Recommended"], ["month", "A month", "About 20 seconds"], ["season", "A whole season", "Up to a minute"]
];

export function DemoWelcome() {
  const [campName, setCampName] = useState("");
  const [buses, setBuses] = useState("");
  const [kids, setKids] = useState("");
  const [busy, setBusy] = useState<"standard" | "mine" | null>(null);
  const [history, setHistory] = useState<HistorySpan | "none">("week");
  const [error, setError] = useState("");

  async function build(kind: "standard" | "mine", input: { campName: string; buses: number; kids: number }) {
    setBusy(kind); setError("");
    try { await buildCamp({ ...input, history }); location.assign("/"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "That didn't work. Try again."); setBusy(null); }
  }
  function mine(event: FormEvent) {
    event.preventDefault();
    const b = Number(buses), k = Number(kids);
    if (!Number.isInteger(b) || b < 1 || b > 16) { setError("Buses: a number from 1 to 16."); return; }
    if (!Number.isInteger(k) || k < 1 || k > 600) { setError("Kids: a number from 1 to 600."); return; }
    void build("mine", { campName: campName.trim() || "My Camp", buses: b, kids: k });
  }

  return <main className="demo-welcome">
    <div className="demo-wl">
      <div className="demo-mark" aria-hidden="true">B</div>
      <p className="demo-tag">BUSSIN · LIVE DEMO</p>
      <h1>This is the real Bussin.</h1>
      <p className="demo-lede">Not a video, not a mockup. It&rsquo;s the same app camps run every day, live. Set up a camp below and
        everything works: buses move on the map, parents see them coming, counselors check kids on and off.
        Only the people are made up.</p>

      <section className="demo-choice">
        <div><h2>How much has already happened?</h2><p>Past days fill History and Reports with finished trips, GPS trails and kid check-ins.</p></div>
        <div className="demo-past" role="radiogroup" aria-label="How much history">{PAST.map(([value, label, sub]) =>
          <button key={value} type="button" role="radio" aria-checked={history === value} className={history === value ? "on" : ""}
            disabled={!!busy} onClick={() => setHistory(value)}><b>{label}</b><small>{sub}</small></button>)}</div>
      </section>

      <section className="demo-choice">
        <div><h2>Standard camp</h2><p>5 buses · 120 kids · 10 counselors · 5 lines</p></div>
        <button type="button" className="demo-go" disabled={!!busy} onClick={() => void build("standard", STANDARD)}>
          {busy === "standard" ? "Building…" : "Use this camp"}</button>
      </section>

      <form className="demo-choice demo-mine" onSubmit={mine}>
        <div><h2>Match my camp</h2><p>Your numbers. We make the lines, counselors and parents to fit.</p></div>
        <label>Camp name<input value={campName} maxLength={60} placeholder="Camp Wildwood" onChange={(event) => setCampName(event.target.value)} /></label>
        <div className="demo-two">
          <label>Buses<input inputMode="numeric" value={buses} placeholder="8" onChange={(event) => setBuses(event.target.value.replace(/\D/g, ""))} /></label>
          <label>Kids riding<input inputMode="numeric" value={kids} placeholder="250" onChange={(event) => setKids(event.target.value.replace(/\D/g, ""))} /></label>
        </div>
        <button type="submit" className="demo-go" disabled={!!busy}>{busy === "mine" ? "Building…" : "Build my camp"}</button>
      </form>

      {error && <p className="demo-error" role="alert">{error}</p>}
      <p className="demo-fine">{busy ? "Building your camp. Keep this page open." : "Takes a few seconds, longer with more history."} You can start over or build a different camp any time from the DEMO button.</p>
    </div>
  </main>;
}

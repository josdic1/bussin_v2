import { useEffect, useRef, useState } from "react";
import {
  clock, clockSeconds, distanceMeters, mmss, useTerminalTrip,
  EARLY_START_WARNING_MS, MANUAL_DEPART_AFTER_MS, type Fix, type TerminalMode
} from "./useTerminalTrip";
import { TerminalMap } from "./TerminalMap";
import "./terminal.css";

const LOCKED_TEXT = "Stop the bus to tap";

/* Rough drive time to the next stop, worked out on the tablet: roads are about a third longer
 * than a straight line, at the bus's recent average speed. Always shown as "about". */
const ROAD_FACTOR = 1.35;
const DEFAULT_SPEED_MPS = 8;      // about 18 mph, town driving with stops
const SPEED_WINDOW_MS = 120_000;
const ARRIVING_M = 120;

function etaMinutes(meters: number, history: Fix[]): number {
  let speed = DEFAULT_SPEED_MPS;
  if (history.length >= 2) {
    let traveled = 0;
    for (let i = 1; i < history.length; i++) traveled += distanceMeters(history[i - 1], history[i]);
    const seconds = (history.at(-1)!.observedAt - history[0].observedAt) / 1000;
    if (seconds >= 30) speed = Math.min(15, Math.max(4, traveled / seconds));
  }
  return Math.max(1, Math.round(meters * ROAD_FACTOR / speed / 60));
}

const miles = (meters: number) => meters < 160 ? `${Math.round(meters * 3.281 / 10) * 10} ft` : `${(meters / 1609.34).toFixed(1)} mi`;

const ICONS = {
  refresh: "M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 14 6M4 12a8 8 0 0 0 14 6",
  screen: "M3 4h18v13H3V4Zm5 17h8m-4-4v4"
};
function Icon({ name }: { name: keyof typeof ICONS }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={ICONS[name]} /></svg>;
}

/**
 * The cab terminal for docked tablets, at /terminal. Staff accounts only.
 * One status line, a map, the next stop, one button. The phone screen (StaffTripPage) is separate and unchanged.
 */
export function DriverTerminal({ mode, deviceBus }: { mode?: TerminalMode; deviceBus?: string } = {}) {
  const t = useTerminalTrip(mode);
  const device = t.device;
  const { trip, now, fix, locked, pending, nextStop, nextIndex, status, problem } = t;
  const [details, setDetails] = useState(false);

  // Recent fixes for the drive-time estimate.
  const history = useRef<Fix[]>([]);
  useEffect(() => {
    if (!fix) return;
    const list = history.current;
    if (list.at(-1)?.observedAt !== fix.observedAt) list.push(fix);
    history.current = list.filter((item) => fix.observedAt - item.observedAt <= SPEED_WINDOW_MS);
  }, [fix]);

  const busLabel = trip ? `${trip.busLabel} · ${trip.routeName} · ${trip.servicePeriod}` : device ? deviceBus ?? "Bus" : t.member?.display_name ?? "Driver";
  const fresh = fix && now - fix.observedAt <= 20_000 ? fix : null;

  // ---------- right panel: one state at a time ----------
  let kicker = "";
  let title = "";
  let big: React.ReactNode = null;
  let sub: React.ReactNode = null;
  let action: React.ReactNode = null;
  let upcoming: { id: string; position: number; label: string }[] = [];

  if (trip === undefined) {
    kicker = "LOADING"; title = "Your trip"; sub = "Checking with Dispatch…";
  } else if (trip === null) {
    kicker = t.justCompleted ? "TRIP COMPLETE" : "NO TRIP";
    title = t.justCompleted ? "Nice work." : "Nothing assigned";
    sub = t.justCompleted ? "Dispatch can assign your next trip. Keep this screen on." : device
      ? "This screen updates by itself when this bus has a trip."
      : "This screen updates by itself when Dispatch assigns a trip.";
  } else if (trip.status === "planned") {
    const until = Date.parse(trip.departureAt) - now;
    kicker = `NEXT TRIP · ${trip.servicePeriod}`;
    title = trip.routeName;
    big = until > 0 ? mmss(until) : `${Math.floor(-until / 60_000)} min late`;
    sub = <>Leaves {clock(trip.departureAt)} · first stop {trip.stops[0]?.label ?? ""}</>;
    if (device) sub = <>Leaves {clock(trip.departureAt)} · the lead counselor starts the trip on their phone</>;
    action = device ? null : t.confirming === "start"
      ? <div className="term-confirm"><p>Scheduled for {clock(trip.departureAt)}. Start {Math.ceil(until / 60_000)} minutes early?</p>
        <div><button type="button" className="term-btn ghost" onClick={() => t.setConfirming(null)}>Go back</button>
          <button type="button" className="term-btn go" disabled={pending} onClick={() => void t.act("start")}>Start now</button></div></div>
      : <button type="button" className="term-btn go big" disabled={pending || locked}
        onClick={() => until > EARLY_START_WARNING_MS ? t.setConfirming("start") : void t.act("start")}>
        {locked ? LOCKED_TEXT : pending ? "Starting…" : "Start trip"}</button>;
  } else if (t.readyToComplete) {
    kicker = `LAST STOP · ${trip.stops.length} OF ${trip.stops.length}`;
    title = t.finalStop!.label;
    big = "Arrived";
    sub = device
      ? <>at {clock(t.finalStop!.arrivedAt!)} · the lead counselor finishes the trip, or it finishes itself in 10 minutes</>
      : <>at {clock(t.finalStop!.arrivedAt!)} · everyone off? Finish to free the bus.</>;
    action = device ? null : <button type="button" className="term-btn go big" disabled={pending || locked} onClick={() => void t.act("complete")}>
      {locked ? LOCKED_TEXT : pending ? "Finishing…" : "Finish trip"}</button>;
  } else if (nextStop?.arrivedAt) {
    const dwell = now - Date.parse(nextStop.arrivedAt);
    const departing = t.progress && t.progress.stopId === nextStop.id && t.progress.phase === "confirming_departure" ? t.progress : null;
    kicker = `AT STOP · ${nextIndex + 1} OF ${trip.stops.length}`;
    title = nextStop.label;
    big = mmss(dwell);
    sub = departing ? <>Checking departure · {miles(departing.distanceM)} out</> : "Departure records itself when you drive off.";
    action = t.confirming === "undo"
      ? <div className="term-confirm"><p>Undo arrival at {nextStop.label}? The original stays in the log as corrected.</p>
        <div><button type="button" className="term-btn ghost" onClick={() => t.setConfirming(null)}>Go back</button>
          <button type="button" className="term-btn warn" disabled={pending} onClick={() => void t.act("undo_arrival", nextStop.id)}>Undo arrival</button></div></div>
      : <><button type="button" className="term-btn go big" disabled={pending || locked || dwell < MANUAL_DEPART_AFTER_MS}
          onClick={() => void t.act("depart", nextStop.id)}>
          {locked ? LOCKED_TEXT : dwell < MANUAL_DEPART_AFTER_MS ? `Leaving now (in ${Math.ceil((MANUAL_DEPART_AFTER_MS - dwell) / 1000)}s)` : "Leaving now"}</button>
        {!locked && <button type="button" className="term-link" onClick={() => t.setConfirming("undo")}>Not here yet? Undo arrival</button>}</>;
  } else if (nextStop) {
    const confirming = t.confirmingArrival;
    const meters = fresh ? distanceMeters(fresh, nextStop) : null;
    kicker = `NEXT STOP · ${nextIndex + 1} OF ${trip.stops.length}`;
    title = nextStop.label;
    big = confirming ? "Arriving" : meters === null ? "…" : meters <= ARRIVING_M ? "Arriving" : `about ${etaMinutes(meters, history.current)} min`;
    sub = confirming
      ? <>Checking arrival · {miles(confirming.distanceM)}</>
      : meters === null ? "Waiting for GPS" : <>{miles(meters)} · arrival records itself when you stop</>;
    action = <button type="button" className="term-btn go big" disabled={pending || locked} onClick={() => void t.act("arrive", nextStop.id)}>
      {locked ? LOCKED_TEXT : pending ? "Saving…" : "Arrived"}</button>;
    upcoming = trip.stops.slice(nextIndex + 1, nextIndex + 3);
  }

  const checking = t.confirmingArrival ?? (nextStop && t.progress?.stopId === nextStop.id && t.progress.phase === "confirming_departure" ? t.progress : null);
  const pct = checking ? Math.round(Math.min(1, checking.qualifyingSpanSeconds / checking.requiredSpanSeconds) * 100) : null;
  const toast = t.error || (t.autoPaused && t.active ? "Auto-detect is paused. Tap Arrived and Leaving now yourself." : "");

  return <main className="term">
    <header className={`term-status ${status.tone}`}>
      <button type="button" className="term-status-main" onClick={() => setDetails(true)} aria-label="Tracking details">
        <span className="term-dot" aria-hidden="true" />
        <span className="term-status-title" aria-live="polite">{status.title}</span>
        {status.tone !== "good" && status.detail && <span className="term-status-detail">{status.detail}</span>}
      </button>
      {problem
        ? <button type="button" className="term-status-fix" onClick={problem.run}>{problem.button}</button>
        : <span className="term-status-bus">{busLabel}</span>}
      <span className="term-clock">{clock(now)}</span>
    </header>

    {(toast || t.notice) && <div className="term-toast" role="status">
      {toast || <>{t.notice!.action === "arrived" ? "Arrived at" : "Left"} {t.notice!.stopLabel} automatically
        <button type="button" onClick={() => t.setNotice(null)}>OK</button></>}
    </div>}

    <div className="term-body">
      <TerminalMap trip={trip ?? null} bus={fix}
        nextStopId={nextStop?.id ?? (trip?.status === "planned" ? trip.stops[0]?.id ?? null : null)} />
      <section className="term-panel" aria-label="Current trip">
        <div className="term-kicker">{kicker}</div>
        <h1 className="term-title">{title}</h1>
        {big !== null && <div className="term-big">{big}</div>}
        {sub && <p className="term-sub">{sub}</p>}
        {pct !== null && <div className="term-progress" aria-hidden="true"><b style={{ width: `${pct}%` }} /></div>}
        {upcoming.length > 0 && <ol className="term-after">{upcoming.map((stop) =>
          <li key={stop.id}><span>{stop.position}</span>{stop.label}</li>)}</ol>}
        <div className="term-actions">{action}</div>
      </section>
    </div>

    {details && <div className="term-drawer-backdrop" onClick={() => setDetails(false)}>
      <aside className="term-drawer" role="dialog" aria-modal="true" aria-label="Tracking details" onClick={(event) => event.stopPropagation()}>
        <div className="term-drawer-top"><h2>{status.title}</h2><button type="button" className="term-btn ghost" onClick={() => setDetails(false)}>Close</button></div>
        {status.detail && <p className="term-drawer-detail">{status.detail}</p>}
        <dl>
          {device ? <><dt>Bus tracker</dt><dd>{deviceBus ?? "Bus"}</dd></>
            : <><dt>Driver</dt><dd>{t.member?.display_name ?? "Driver"}{t.tenant ? ` · ${t.tenant.name}` : ""}</dd></>}
          <dt>Trip</dt><dd>{trip ? `${trip.busLabel} · ${trip.status === "active" ? "Running" : "Not started"}` : trip === undefined ? "Checking…" : "None assigned"}</dd>
          <dt>GPS</dt><dd>{fix ? `${Math.max(0, Math.round(t.fixAge / 1000))}s ago · within ${Math.round(fix.accuracy * 3.281)} ft` : t.gps === "denied" ? "Location permission off" : "Finding location"}</dd>
          <dt>Dispatch got it</dt><dd>{t.dispatch.at ? `${Math.max(0, Math.round((now - t.dispatch.at) / 1000))}s ago` : "Not yet"}{!t.online ? " · internet offline" : t.dispatch.queued ? ` · ${t.dispatch.queued} saved on tablet` : ""}</dd>
          <dt>Screen</dt><dd>{t.awake === "yes" ? "Staying on" : "May turn off"}</dd>
          {fix && <><dt>Last fix</dt><dd>{clockSeconds(fix.observedAt)} · {fix.latitude.toFixed(5)}, {fix.longitude.toFixed(5)}</dd></>}
          {t.dispatch.note && <><dt>Note</dt><dd>{t.dispatch.note}</dd></>}
        </dl>
        {trip && trip.stops.length > 0 && <ol className="term-stops">{trip.stops.map((stop, index) => {
          const last = index === trip.stops.length - 1;
          const done = !!stop.departedAt || (last && !!stop.arrivedAt);
          return <li key={stop.id} className={done ? "done" : nextStop?.id === stop.id ? "cur" : ""}>
            <span>{stop.position}</span>{stop.label}
            <em>{stop.arrivedAt ? `${stop.arrivalMethod === "automatic" ? "Auto" : "Tapped"} ${clock(stop.arrivedAt)}` : nextStop?.id === stop.id ? "Next" : ""}</em></li>;
        })}</ol>}
        <div className="term-drawer-actions">
          <button type="button" className="term-btn ghost" disabled={locked || pending} onClick={t.refresh}><Icon name="refresh" />Check trip with Dispatch</button>
          {t.awake !== "yes" && <button type="button" className="term-btn ghost" onClick={() => void t.requestWake()}><Icon name="screen" />Keep screen on</button>}
          <button type="button" className="term-btn ghost" disabled={locked || pending}
            onClick={() => { if (window.confirm(device ? "Unpair this phone from the bus? You'll need a new code from Fleet." : "Sign out of this driver terminal?")) void t.signOut(); }}>
            {device ? "Unpair this phone" : "Sign out"}</button>
        </div>
      </aside>
    </div>}
  </main>;
}

import { useCallback, useEffect, useRef, useState } from "react";
import { staffCheckResponseSchema, type CheckRider, type CheckTrip, type RiderCheckAction } from "@bussin/shared";
import { ChangeMyPassword } from "../auth/ChangeMyPassword";
import { clock, EARLY_START_WARNING_MS, mmss, useTerminalTrip } from "../terminal/useTerminalTrip";
import "./crew.css";

/*
 * The counselor phone. Everyone on the crew does Ride Check for their trip.
 * The lead also starts and finishes the trip; their phone sends GPS only when the
 * bus's own phone is not reporting. Other counselors' phones never ask for location.
 * Two phones tapping the same kid: the second tap is refused and the list refreshes.
 */

const STATE_LABEL: Record<CheckRider["state"], string> = {
  expected: "Waiting", aboard: "On bus", dropped: "Dropped off", no_show: "No-show", not_riding: "Not riding"
};

async function readError(response: Response, fallback: string) {
  const body: unknown = await response.json().catch(() => null);
  return body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : fallback;
}

/** Ride Check for this phone's trip, kept live by the same stream the trip uses. */
function useRideCheck() {
  const [trip, setTrip] = useState<CheckTrip | null | undefined>();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const response = await fetch("/api/check/mine", { credentials: "same-origin" });
      if (!response.ok) return;
      const data = staffCheckResponseSchema.parse(await response.json());
      if (mine === seq.current) setTrip(data.trip);
    } catch {
      // Connection trouble shows in the trip status; the list keeps its last state.
    }
  }, []);

  useEffect(() => {
    void load();
    const source = new EventSource("/api/staff/live");
    source.addEventListener("trip", () => void load());
    source.addEventListener("ready", () => void load());
    const poll = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 20_000);
    return () => { source.close(); window.clearInterval(poll); };
  }, [load]);

  async function post(path: string, body: unknown, key: string) {
    if (busy) return;
    setBusy(key); setMessage("");
    try {
      const response = await fetch(path, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      if (!response.ok) setMessage(await readError(response, "That didn't save. Tap again."));
    } catch {
      setMessage("No signal, so that tap didn't save. Tap again when you have signal.");
    } finally {
      setBusy(null);
      await load();
    }
  }

  const tap = (rider: CheckRider, type: RiderCheckAction["type"]) =>
    trip && post(`/api/check/trips/${trip.id}/riders/${rider.riderId}`, { type, expected: rider.state }, `${rider.riderId}:${type}`);
  const bulk = (stopId: string, type: "board_waiting" | "drop_aboard") =>
    trip && post(`/api/check/trips/${trip.id}/bulk`, { type, stopId }, `bulk:${stopId}`);
  const sweep = () => trip && post(`/api/check/trips/${trip.id}/sweep`, {}, "sweep");
  return { trip, busy, message, setMessage, tap, bulk, sweep };
}

function RiderRow({ rider, tripStatus, busy, tap }: {
  rider: CheckRider; tripStatus: CheckTrip["status"]; busy: string | null;
  tap: (rider: CheckRider, type: RiderCheckAction["type"]) => void;
}) {
  const running = tripStatus === "active";
  const state = rider.state;
  const pending = busy?.startsWith(rider.riderId) ?? false;
  const buttons: [RiderCheckAction["type"], string, string][] = running
    ? state === "expected" ? [["board", "On bus", "go"], ["no_show", "No-show", "warn"]]
      : state === "aboard" ? [["drop", "Dropped off", "go"]]
        : state === "no_show" ? [["board", "On bus", "go"], ["undo", "Undo", "plain"]]
          : [["undo", "Undo", "plain"]]
    : state === "expected" ? [["not_riding", "Not riding today", "plain"]]
      : state === "not_riding" ? [["undo", "Undo", "plain"]] : [];
  return <li className={`cr-rider s-${state}`}>
    <div className="cr-who"><b>{rider.givenName} {rider.familyName}</b>
      <span className="cr-state">{STATE_LABEL[state]}{rider.stateBy && state !== "expected" ? ` · ${rider.stateBy}` : ""}{rider.stateAt && state !== "expected" ? ` · ${clock(rider.stateAt)}` : ""}</span></div>
    <div className="cr-btns">{buttons.map(([type, label, tone]) =>
      <button key={type} type="button" className={`cr-btn ${tone}`} disabled={!!busy} onClick={() => tap(rider, type)}>
        {pending && busy === `${rider.riderId}:${type}` ? "…" : label}</button>)}</div>
  </li>;
}

export function StaffTripPage() {
  const t = useTerminalTrip({ kind: "staff" });
  const check = useRideCheck();
  const [changingPassword, setChangingPassword] = useState(false);
  const { trip, now, pending } = t;
  const lead = trip?.crewRole === "lead";
  const ride = check.trip && trip && check.trip.id === trip.id ? check.trip : null;

  if (changingPassword) {
    return <main className="field crew"><header className="ftop"><div className="wm">BUSSIN<span>Change my password</span></div></header>
      <ChangeMyPassword onCancel={() => setChangingPassword(false)} /></main>;
  }

  const riders = ride?.riders ?? [];
  const onBus = riders.filter((r) => r.state === "aboard").length;
  const rode = riders.filter((r) => r.state === "aboard" || r.state === "dropped").length;
  const finalStop = trip?.stops.at(-1);
  const atEnd = !!(trip?.status === "active" && finalStop?.arrivedAt);
  const until = trip ? Date.parse(trip.departureAt) - now : 0;

  // ---------- GPS line: who is tracking this bus ----------
  const gpsLine = !trip ? null
    : trip.busPhoneLive ? { tone: "good", text: "The bus phone is tracking this bus." }
      : !lead ? { tone: "", text: "The lead's phone tracks the bus. Yours just does Ride Check." }
        : { tone: t.status.tone === "good" || t.status.tone === "ready" ? "good" : "warn", text: `${t.status.title}${t.status.detail ? `. ${t.status.detail}` : ""}` };

  // ---------- Lead's trip controls ----------
  let control: React.ReactNode = null;
  if (trip && lead && trip.status === "planned") {
    control = t.confirming === "start"
      ? <div className="cr-confirm"><p>Scheduled for {clock(trip.departureAt)}. Start {Math.ceil(until / 60_000)} minutes early?</p>
        <div><button type="button" className="cr-btn plain" onClick={() => t.setConfirming(null)}>Go back</button>
          <button type="button" className="cr-btn go" disabled={pending} onClick={() => void t.act("start")}>Start now</button></div></div>
      : <button type="button" className="cr-main" disabled={pending}
        onClick={() => until > EARLY_START_WARNING_MS ? t.setConfirming("start") : void t.act("start")}>{pending ? "Starting…" : "Start trip"}</button>;
  } else if (trip && lead && trip.status === "active") {
    const next = t.nextStop;
    control = <>
      {t.readyToComplete
        ? <button type="button" className="cr-main" disabled={pending} onClick={() => void t.act("complete")}>{pending ? "Finishing…" : "Finish trip"}</button>
        : next && <div className="cr-next">
          <span>{next.arrivedAt ? "At stop" : "Next stop"} · {t.nextIndex + 1} of {trip.stops.length}</span><b>{next.label}</b>
          <small>{trip.busPhoneLive || t.wantsGps ? "Arrive and depart record themselves from GPS." : ""}</small>
          {/* Backup if GPS can't tell: tap it yourself. */}
          <div className="cr-backup">{next.arrivedAt
            ? <button type="button" className="cr-btn plain" disabled={pending} onClick={() => void t.act("depart", next.id)}>Leaving now</button>
            : <button type="button" className="cr-btn plain" disabled={pending} onClick={() => void t.act("arrive", next.id)}>Arrived</button>}</div>
        </div>}
    </>;
  }

  // ---------- Ride Check, grouped by stop in route order ----------
  const stops = ride?.stops ?? [];
  const byStop = stops.map((stop) => ({ stop, riders: riders.filter((r) => r.stopId === stop.id) })).filter((g) => g.riders.length);
  const am = trip?.servicePeriod === "AM";

  return <main className="field crew">
    <header className="ftop">
      <div className="wm">BUSSIN<span>{t.member?.display_name ?? ""}{t.tenant ? ` · ${t.tenant.name}` : ""}</span></div>
      <div className="cr-top-acts">
        <button type="button" onClick={() => setChangingPassword(true)}>Password</button>
        <button type="button" onClick={() => void t.signOut()}>Sign out</button>
      </div>
    </header>

    {trip === undefined && <section className="cr-card"><p className="cr-muted">Checking with Dispatch…</p></section>}
    {trip === null && <section className="cr-card"><span className="cr-eyebrow">{t.justCompleted ? "Trip complete" : "No trip yet"}</span>
      <h1>{t.justCompleted ? "Nice work." : "Nothing assigned"}</h1>
      <p className="cr-muted">This screen updates by itself when Dispatch puts you on a trip.</p></section>}

    {trip && <section className="cr-card">
      <span className="cr-eyebrow">{trip.busLabel} · {trip.servicePeriod} · {trip.status === "active" ? "Running" : until > 0 ? `Leaves in ${mmss(until)}` : `${Math.floor(-until / 60_000)} min late`}</span>
      <h1>{trip.routeName}</h1>
      <p className="cr-muted">Departs {clock(trip.departureAt)}</p>
      <div className="cr-crew">
        {ride?.assignedStaff && <span className="cr-pill lead"><b>Lead</b>{ride.assignedStaff.displayName}{lead ? " (you)" : ""}</span>}
        {!lead && <span className="cr-pill"><b>You</b>Counselor</span>}
      </div>
      {gpsLine && <p className={`cr-gps ${gpsLine.tone}`}><i />{gpsLine.text}
        {lead && !trip.busPhoneLive && t.problem && <button type="button" onClick={t.problem.run}>{t.problem.button}</button>}</p>}
    </section>}

    {(t.error || check.message) && <p className="cr-alert" role="alert">{check.message || t.error}
      <button type="button" onClick={() => check.setMessage("")}>OK</button></p>}
    {control}

    {trip && <section className="cr-check">
      <div className="cr-check-head"><h2>Ride Check</h2>
        <span>{trip.status === "active" ? `${onBus} on bus · ${rode} of ${riders.length} rode` : `${riders.length} kids expected`}</span></div>
      {!ride && <p className="cr-muted">Loading the kids…</p>}
      {/* Afternoon: everyone boards at camp, the first stop. */}
      {trip.status === "active" && !am && stops[0] && riders.some((r) => r.state === "expected") &&
        <button type="button" className="cr-main ghost" disabled={!!check.busy} onClick={() => check.bulk(stops[0]!.id, "board_waiting")}>
          Everyone waiting is on the bus ({riders.filter((r) => r.state === "expected").length})</button>}
      {ride && !riders.length && <p className="cr-muted">No kids are scheduled on this trip.</p>}
      {byStop.map(({ stop, riders: list }) => {
        const waiting = list.filter((r) => r.state === "expected").length;
        const aboard = list.filter((r) => r.state === "aboard").length;
        const here = stop.arrivedAt && !stop.departedAt;
        return <div key={stop.id} className={`cr-stop${here ? " here" : ""}`}>
          <div className="cr-stop-head"><span className="cr-num">{stop.position}</span><b>{stop.label}</b>
            {here && <em>Bus is here</em>}
            {trip.status === "active" && am && waiting > 1 && <button type="button" className="cr-btn go small" disabled={!!check.busy}
              onClick={() => check.bulk(stop.id, "board_waiting")}>All {waiting} on bus</button>}
            {trip.status === "active" && !am && aboard > 1 && <button type="button" className="cr-btn go small" disabled={!!check.busy}
              onClick={() => check.bulk(stop.id, "drop_aboard")}>All {aboard} off here</button>}
          </div>
          <ul>{list.map((rider) => <RiderRow key={rider.riderId} rider={rider} tripStatus={ride!.status} busy={check.busy} tap={check.tap} />)}</ul>
        </div>;
      })}
      {/* Morning: everyone gets off at camp, the last stop. */}
      {trip.status === "active" && am && atEnd && onBus > 0 && stops.at(-1) &&
        <button type="button" className="cr-main" disabled={!!check.busy} onClick={() => check.bulk(stops.at(-1)!.id, "drop_aboard")}>
          Everyone off at {stops.at(-1)!.label} ({onBus})</button>}
      {trip.status === "active" && atEnd && ride && !ride.sweep && onBus === 0 && riders.length > 0 &&
        <button type="button" className="cr-main ghost" disabled={!!check.busy} onClick={() => check.sweep()}>Walked the bus: it's empty</button>}
      {ride?.sweep && <p className="cr-done">Bus checked empty by {ride.sweep.confirmedBy} at {clock(ride.sweep.confirmedAt)}</p>}
    </section>}
  </main>;
}

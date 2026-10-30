import { useCallback, useEffect, useRef, useState } from "react";
import { staffCheckResponseSchema, type CheckRider, type CheckTrip, type RiderCheckAction } from "@bussin/shared";
import { ChangeMyPassword } from "../auth/ChangeMyPassword";
import { clock, EARLY_START_WARNING_MS, mmss, PREVIEW_NOTE, useTerminalTrip } from "../terminal/useTerminalTrip";
import { missed, nameList } from "../check/checkModel";
import { bulkTargets, loadQueue, newId, resultOf, saveQueue, withQueue, type QueuedTap } from "./tapQueue";
import { AlertSheet, CrewHelp, useCrewAlerts } from "./CrewAlerts";
import type { TripAlertKind } from "@bussin/shared";
import "./crew.css";
import { InstallBanner } from "../install/InstallGuide";
import { useDemo } from "../demo/useDemo";

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

/**
 * Ride Check for this phone's trip, kept live by the same stream the trip uses. In preview: read-only, polled.
 * Every tap goes into a queue on the phone first, so the screen updates at once and a tap made with
 * no signal is kept and sent (with its real time) as soon as signal returns.
 */
function useRideCheck(previewId?: string) {
  const url = previewId ? `/api/preview/counselor/${previewId}/check` : "/api/check/mine";
  const [trip, setTrip] = useState<CheckTrip | null | undefined>();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [online, setOnline] = useState(() => navigator.onLine);
  const [queue, setQueueState] = useState<QueuedTap[]>(() => previewId ? [] : loadQueue());
  const queueRef = useRef(queue);
  const setQueue = useCallback((next: QueuedTap[]) => { queueRef.current = next; setQueueState(next); saveQueue(next); }, []);
  const flushing = useRef(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const response = await fetch(url, { credentials: "same-origin" });
      if (!response.ok) return;
      const data = staffCheckResponseSchema.parse(await response.json());
      if (mine === seq.current) setTrip(data.trip);
    } catch {
      // Connection trouble shows in the trip status; the list keeps its last state.
    }
  }, [url]);

  /** Send saved taps in order. Stops at the first one that can't reach the server and tries again later. */
  const flush = useCallback(async () => {
    if (previewId || flushing.current || !queueRef.current.length) return;
    flushing.current = true;
    const refused: string[] = [];
    try {
      while (queueRef.current.length) {
        const item = queueRef.current[0]!;
        let response: Response;
        try {
          response = item.kind === "sweep"
            ? await fetch(`/api/check/trips/${item.tripId}/sweep`, {
              method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}" })
            : await fetch(`/api/check/trips/${item.tripId}/riders/${item.riderId}`, {
              method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ type: item.type, expected: item.expected, occurredAt: item.at }) });
        } catch {
          break; // still no signal: keep it for the next try
        }
        if (response.status >= 500) break;
        if (!response.ok) {
          const body: unknown = await response.json().catch(() => null);
          const serverState = body && typeof body === "object" && "state" in body ? body.state : null;
          // Already where this tap meant to put them (someone else got there first): nothing lost.
          const landed = item.kind === "tap" && item.result !== null && serverState === item.result;
          if (!landed && item.kind === "tap") {
            refused.push(body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "A saved tap couldn't be applied.");
          }
        }
        setQueue(queueRef.current.filter((queued) => queued.id !== item.id));
      }
    } finally {
      flushing.current = false;
      await load();
      if (refused.length) setMessage(refused.length === 1 ? refused[0]! : `${refused.length} saved taps didn't apply. First: ${refused[0]}`);
    }
  }, [load, previewId, setQueue]);

  useEffect(() => {
    void load();
    if (previewId) {
      const poll = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 5_000);
      return () => window.clearInterval(poll);
    }
    void flush();
    const source = new EventSource("/api/staff/live");
    source.addEventListener("trip", () => void load());
    source.addEventListener("ready", () => { void load(); void flush(); });
    const poll = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 20_000);
    const retry = window.setInterval(() => { if (queueRef.current.length) void flush(); }, 8_000);
    const up = () => { setOnline(true); void flush(); };
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      source.close(); window.clearInterval(poll); window.clearInterval(retry);
      window.removeEventListener("online", up); window.removeEventListener("offline", down);
    };
  }, [load, flush, previewId]);

  const shown = trip ? withQueue(trip, queue) : null;
  const view = trip === undefined ? undefined : shown ? shown.trip : null;

  function enqueue(items: QueuedTap[]) {
    setMessage("");
    setQueue([...queueRef.current, ...items]);
    void flush();
  }

  const tap = (rider: CheckRider, type: RiderCheckAction["type"]) => {
    if (!view) return;
    if (previewId) { setMessage(PREVIEW_NOTE); return; }
    // Undo of a tap still waiting on the phone: just take it back.
    if (type === "undo") {
      let index = -1;
      queueRef.current.forEach((item, i) => { if (item.kind === "tap" && item.riderId === rider.riderId && item.tripId === view.id) index = i; });
      // (A tap already on its way to the server can't be pulled back; it gets a real undo instead.)
      if (index >= 0 && !(flushing.current && index === 0)) { setQueue(queueRef.current.filter((_, i) => i !== index)); return; }
    }
    enqueue([{ id: newId(), kind: "tap", tripId: view.id, riderId: rider.riderId, type, expected: rider.state,
      result: resultOf(type, rider.state), at: new Date().toISOString() }]);
  };

  async function bulk(stopId: string, type: "board_waiting" | "drop_aboard") {
    if (!view || busy) return;
    if (previewId) { setMessage(PREVIEW_NOTE); return; }
    const kids = bulkTargets(view, stopId, type);
    const asTaps = () => enqueue(kids.map((rider) => ({ id: newId(), kind: "tap" as const, tripId: view.id, riderId: rider.riderId,
      type: type === "board_waiting" ? "board" as const : "drop" as const, expected: rider.state,
      result: type === "board_waiting" ? "aboard" as const : "dropped" as const, at: new Date().toISOString() })));
    // With signal and nothing waiting, one request does the whole stop; otherwise each kid is saved on the phone.
    if (!navigator.onLine || queueRef.current.length) { asTaps(); return; }
    setBusy(`bulk:${stopId}`); setMessage("");
    try {
      const response = await fetch(`/api/check/trips/${view.id}/bulk`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, stopId }) });
      if (!response.ok) setMessage(await readError(response, "That didn't save. Tap again."));
      await load();
    } catch {
      asTaps();
    } finally {
      setBusy(null);
    }
  }

  const sweep = () => {
    if (!view) return;
    if (previewId) { setMessage(PREVIEW_NOTE); return; }
    enqueue([{ id: newId(), kind: "sweep", tripId: view.id, at: new Date().toISOString() }]);
  };
  return { trip: view, pending: shown?.pending ?? new Set<string>(), queued: queue.length, online, busy, message, setMessage, tap, bulk, sweep };
}

function RiderRow({ rider, tripStatus, busy, saved, tap }: {
  rider: CheckRider; tripStatus: CheckTrip["status"]; busy: string | null; saved: boolean;
  tap: (rider: CheckRider, type: RiderCheckAction["type"]) => void;
}) {
  const [open, setOpen] = useState(false);
  const running = tripStatus === "active";
  const state = rider.state;
  const calls = [...rider.guardians.filter((g) => g.phone).map((g) => ({ label: g.name, phone: g.phone! })),
    ...(rider.emergency?.phone ? [{ label: `${rider.emergency.name} (emergency)`, phone: rider.emergency.phone }] : [])];
  const buttons: [RiderCheckAction["type"], string, string][] = running
    ? state === "expected" ? [["board", "On bus", "go"], ["no_show", "No-show", "warn"]]
      : state === "aboard" ? [["drop", "Dropped off", "go"]]
        : state === "no_show" ? [["board", "On bus", "go"], ["undo", "Undo", "plain"]]
          : [["undo", "Undo", "plain"]]
    : state === "expected" ? [["not_riding", "Not riding today", "plain"]]
      : state === "not_riding" ? [["undo", "Undo", "plain"]] : [];
  return <li className={`cr-rider s-${state}${open ? " open" : ""}`}>
    <div className="cr-who"><button type="button" className="cr-name" aria-expanded={open} onClick={() => setOpen(!open)}>
      {rider.givenName} {rider.familyName}{rider.careNotes && <span className="cr-care-tag" aria-label="Has care notes">CARE</span>}</button>
      <span className="cr-state">{STATE_LABEL[state]}{rider.stateBy && state !== "expected" ? ` · ${rider.stateBy}` : ""}{rider.stateAt && state !== "expected" ? ` · ${clock(rider.stateAt)}` : ""}</span>
      {saved && <span className="cr-saved">Saved on phone, sending</span>}</div>
    <div className="cr-btns">{buttons.map(([type, label, tone]) =>
      <button key={type} type="button" className={`cr-btn ${tone}`} disabled={!!busy} onClick={() => tap(rider, type)}>{label}</button>)}</div>
    {open && <div className="cr-info">
      {rider.careNotes ? <p className="cr-care"><b>Care notes</b>{rider.careNotes}</p> : <p className="cr-muted">No care notes.</p>}
      {calls.length ? <div className="cr-calls">{calls.map((call) =>
        <a key={`${call.label}-${call.phone}`} className="cr-call" href={`tel:${call.phone.replace(/[^\d+]/g, "")}`}>
          <span>Call {call.label}</span><small>{call.phone}</small></a>)}</div>
        : <p className="cr-muted">No phone numbers on file. Ask Dispatch.</p>}
    </div>}
  </li>;
}

/** preview: the admin's View as, showing this counselor's phone. Nothing tapped here saves. */
export function StaffTripPage({ preview }: { preview?: { memberId: string; name: string } } = {}) {
  const demo = useDemo();
  const t = useTerminalTrip(preview
    ? { kind: "preview", as: "staff", tripUrl: `/api/preview/counselor/${preview.memberId}/trip` } : { kind: "staff" });
  const check = useRideCheck(preview?.memberId);
  const crewAlerts = useCrewAlerts(!preview && !!t.trip);
  const [sheet, setSheet] = useState<TripAlertKind | null>(null);
  const [changingPassword, setChangingPassword] = useState(false);
  const { trip, now, pending } = t;
  const lead = trip?.crewRole === "lead";
  const ride = check.trip && trip && check.trip.id === trip.id ? check.trip : null;
  // Buzz the phone when a kid gets left behind (vibration is Android only; the red banner shows everywhere).
  const leftCount = ride ? ride.riders.filter((rider) => missed(ride, rider)).length : 0;
  const lastLeft = useRef(0);
  useEffect(() => {
    if (leftCount > lastLeft.current && !preview) navigator.vibrate?.([400, 200, 400, 200, 400]);
    lastLeft.current = leftCount;
  }, [leftCount, preview]);

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

  // ---------- Nobody left behind ----------
  const fullName = (rider: CheckRider) => `${rider.givenName} ${rider.familyName}`;
  const leftBehind = ride ? riders.filter((rider) => missed(ride, rider)) : [];
  const unaccounted = riders.filter((rider) => rider.state === "expected" || rider.state === "aboard");
  const firstStop = ride?.stops[0];
  // Before leaving where kids get on: camp in the afternoon, the stop the bus is at in the morning.
  const boardingHere = ride?.status === "active"
    ? ride.servicePeriod === "PM"
      ? firstStop && !firstStop.departedAt ? { label: firstStop.label, kids: riders.filter((r) => r.state === "expected") } : null
      : (() => { const at = ride.stops.find((stop) => stop.arrivedAt && !stop.departedAt);
          return at ? { label: at.label, kids: riders.filter((r) => r.state === "expected" && r.stopId === at.id) } : null; })()
    : null;

  // ---------- GPS line: who is tracking this bus ----------
  const gpsLine = !trip ? null
    : trip.busPhoneLive ? { tone: "good", text: demo?.demo && demo.driving.speed ? "Demo: the robot is driving this bus, so your phone's location isn't used." : "The bus phone is tracking this bus." }
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
    const waitingNames = unaccounted.filter((r) => r.state === "expected").map(fullName);
    const aboardNames = unaccounted.filter((r) => r.state === "aboard").map(fullName);
    control = <>
      {t.readyToComplete
        ? unaccounted.length
          ? <div className="cr-locked"><b>Finish is locked</b>
            {waitingNames.length > 0 && <p>{waitingNames.length} not checked: {nameList(waitingNames)}.</p>}
            {aboardNames.length > 0 && <p>{aboardNames.length} still on the bus: {nameList(aboardNames)}.</p>}
            <small>Mark every kid below, then Finish unlocks.</small></div>
          : <button type="button" className="cr-main" disabled={pending} onClick={() => void t.act("complete")}>{pending ? "Finishing…" : "Finish trip"}</button>
        : next && <div className="cr-next">
          <span>{next.arrivedAt ? "At stop" : "Next stop"} · {t.nextIndex + 1} of {trip.stops.length}</span><b>{next.label}</b>
          <small>{trip.busPhoneLive || t.wantsGps ? "Arrive and depart record themselves from GPS." : ""}</small>
          {/* Backup if GPS can't tell: tap it yourself. GPS gets a say first (see the prompt below). */}
          {t.farPrompt?.stopId === next.id && !next.arrivedAt
            ? <div className="cr-far"><p>{t.farPrompt.message}</p>
              <div><button type="button" className="cr-btn plain" onClick={() => t.setFarPrompt(null)}>Not yet</button>
                <button type="button" className="cr-btn warn" disabled={pending} onClick={() => void t.act("arrive", next.id, true)}>I'm here anyway</button></div></div>
            : <div className="cr-backup">{next.arrivedAt
              ? <>{t.confirming === "undo"
                ? <><button type="button" className="cr-btn plain" onClick={() => t.setConfirming(null)}>Keep it</button>
                  <button type="button" className="cr-btn warn" disabled={pending} onClick={() => void t.act("undo_arrival", next.id)}>Undo arrival</button></>
                : <><button type="button" className="cr-btn plain" disabled={pending} onClick={() => void t.act("depart", next.id)}>Leaving now</button>
                  <button type="button" className="cr-link" onClick={() => t.setConfirming("undo")}>Not here yet? Undo</button></>}</>
              : <button type="button" className="cr-btn plain" disabled={pending} onClick={() => void t.act("arrive", next.id)}>Arrived</button>}</div>}
        </div>}
    </>;
  }

  // ---------- Ride Check, grouped by stop in route order ----------
  const stops = ride?.stops ?? [];
  const byStop = stops.map((stop) => ({ stop, riders: riders.filter((r) => r.stopId === stop.id) })).filter((g) => g.riders.length);
  const am = trip?.servicePeriod === "AM";

  // Morning and afternoon look different on purpose: light going to camp, dark coming home.
  const pm = trip?.servicePeriod === "PM";
  const from = trip?.stops[0]?.label ?? "";
  const to = trip?.stops.at(-1)?.label ?? "";
  return <main className={`field crew ${pm ? "pm" : "am"}`}>
    <header className="ftop">
      <div className="wm">BUSSIN<span>{preview ? preview.name : t.member?.display_name ?? ""}{t.tenant ? ` · ${t.tenant.name}` : ""}</span></div>
      {!preview && <div className="cr-top-acts">
        <button type="button" onClick={() => setChangingPassword(true)}>Password</button>
        <button type="button" onClick={() => void t.signOut()}>Sign out</button>
      </div>}
    </header>
    {!preview && <InstallBanner who="counselor" />}

    {trip === undefined && <section className="cr-card"><p className="cr-muted">Checking with Dispatch…</p></section>}
    {trip === null && <section className="cr-card"><span className="cr-eyebrow">{t.justCompleted ? "Trip complete" : "No trip yet"}</span>
      <h1>{t.justCompleted ? "Nice work." : "Nothing assigned"}</h1>
      <p className="cr-muted">This screen updates by itself when Dispatch puts you on a trip.</p></section>}

    {trip && <section className="cr-card">
      <div className={`cr-dir ${pm ? "pm" : "am"}`}><span>{pm ? "Afternoon" : "Morning"}</span>
        {from && to && <b>{from} → {to}</b>}</div>
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

    {leftBehind.length > 0 && <section className="cr-danger" role="alert">
      <b>{trip?.status === "active" ? `Left ${ride?.servicePeriod === "PM" ? firstStop?.label ?? "camp" : "a stop"} with ${leftBehind.length} not checked` : `${leftBehind.length} never checked`}</b>
      <p>{nameList(leftBehind.map(fullName))}. Find each one: On bus if they're here, No-show if they're not. If you don't know where a kid is, call Dispatch now.</p>
    </section>}
    {!leftBehind.length && boardingHere && boardingHere.kids.length > 0 && <section className="cr-warnbox">
      <b>{boardingHere.kids.length} not checked yet at {boardingHere.label}</b>
      <p>Before you leave: On bus or No-show for each kid.</p>
    </section>}
    {check.queued > 0 && <p className={`cr-queue${check.online ? "" : " off"}`} role="status"><i />
      {check.online ? `Sending ${check.queued} saved ${check.queued === 1 ? "tap" : "taps"}…`
        : `No signal. ${check.queued === 1 ? "1 tap is saved on this phone. It sends" : `${check.queued} taps are saved on this phone. They send`} when signal is back.`}</p>}
    {(t.error || check.message) && <p className="cr-alert" role="alert">{check.message || t.error}
      <button type="button" onClick={() => check.setMessage("")}>OK</button></p>}
    {trip && <CrewHelp alerts={crewAlerts.alerts} onOpen={setSheet} />}
    {control}

    {trip && <section className="cr-check">
      <div className="cr-check-head"><h2>Ride Check</h2>
        <span>{trip.status === "active" ? `${onBus} on bus · ${rode} of ${riders.length} rode` : `${riders.length} kids expected`}</span></div>
      {!ride && <p className="cr-muted">Loading the kids…</p>}
      {/* Afternoon: everyone boards at camp, the first stop. */}
      {trip.status === "active" && !am && stops[0] && !stops[0].departedAt && riders.some((r) => r.state === "expected") &&
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
          <ul>{list.map((rider) => <RiderRow key={rider.riderId} rider={rider} tripStatus={ride!.status} busy={check.busy}
            saved={check.pending.has(rider.riderId)} tap={check.tap} />)}</ul>
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
    {sheet && <AlertSheet kind={sheet} fix={t.fix} preview={!!preview} onClose={() => setSheet(null)}
      onSent={(alert) => { crewAlerts.add(alert); void crewAlerts.reload(); }} />}
  </main>;
}

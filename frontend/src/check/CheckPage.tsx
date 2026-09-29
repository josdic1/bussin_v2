import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useNavigate } from "react-router";
import {
  busesResponseSchema, checkBoardResponseSchema, type CheckRider, type CheckTrip, type RiderCheckAction
} from "@bussin/shared";
import { getJson, message, send } from "../ops/api";
import { dayBounds, localDate, plural, time, routeWithPeriod } from "../ops/format";
import { busColors } from "../ops/fleetModel";
import { Overlay, useOps } from "../ops/OpsShell";
import { Avatar, Dot, ErrorNote, Head, LivePill, NoMatch, SRow, Swatch, Tile } from "../ops/ui";
import { useNow } from "../ops/useBoard";
import {
  alerts, counts, headcount, missed, pillClass, pillWord, stopIndex, stopLabel, stopPassed, unconfirmed,
  type CheckAlert
} from "./checkModel";

type Act = (tripId: string, riderId: string, type: RiderCheckAction["type"]) => void;
type Ctx = {
  act: Act; bulk: (tripId: string, type: "board_waiting" | "drop_aboard") => void; sweep: (tripId: string) => void;
  openManifest: (tripId: string) => void; openDispatch: (tripId: string) => void; busy: boolean;
  colorOf: (busId: string) => string;
};

function useCheckBoard() {
  const [trips, setTrips] = useState<CheckTrip[]>([]);
  const [colorOf, setColorOf] = useState<(id: string) => string>(() => () => "#17382c");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [live, setLive] = useState<"live" | "reconnecting">("live");
  useEffect(() => {
    const controller = new AbortController();
    const load = () => Promise.all([
      getJson(`/api/check/board?${new URLSearchParams(dayBounds(localDate(new Date())))}`, checkBoardResponseSchema, controller.signal),
      getJson("/api/fleet/buses", busesResponseSchema, controller.signal)
    ]).then(([board, buses]) => {
      setTrips(board.trips);
      setColorOf(() => busColors(buses.buses));
      setError("");
      setLive("live");
    }).catch((cause) => {
      if (controller.signal.aborted) return;
      setError(message(cause, "Could not load Ride Check."));
      setLive("reconnecting");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    void load();
    const timer = window.setInterval(() => void load(), 8_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [revision]);
  return { trips, colorOf, loading, error, live, reload: useCallback(() => setRevision((value) => value + 1), []) };
}

function HeadRing({ trip, color, size = 84 }: { trip: CheckTrip; color: string; size?: number }) {
  const head = headcount(trip);
  const percent = head.of ? Math.round(head.n / head.of * 100) : 0;
  return <span className="hc" style={{ "--s": `${size}px`, "--p": percent, "--c": color } as CSSProperties}>
    <span style={{ position: "relative", textAlign: "center" }}><b>{head.n}<span style={{ fontSize: ".55em", color: "var(--muted)" }}>/{head.of}</span></b></span>
  </span>;
}

function riderButtons(trip: CheckTrip, rider: CheckRider, ctx: Ctx) {
  const am = trip.servicePeriod === "AM";
  const buttons: ReactNode[] = [];
  const button = (type: RiderCheckAction["type"], label: string, cls = "") =>
    buttons.push(<button key={type} type="button" className={`btn sm${cls ? ` ${cls}` : ""}`} disabled={ctx.busy}
      onClick={() => ctx.act(trip.id, rider.riderId, type)}>{label}</button>);
  if (trip.status === "cancelled") return null;
  if (trip.status === "planned") {
    if (rider.state === "expected") button("not_riding", "Not riding");
    else if (rider.state === "not_riding") button("undo", "Undo");
    return buttons;
  }
  switch (rider.state) {
    case "expected":
      button("board", "Boarded", "btn-primary");
      if (am) button("no_show", "No-show", "btn-danger");
      else if (trip.status === "active") button("not_riding", "Not riding");
      break;
    case "aboard":
      button("drop", am ? "At camp" : "Dropped off", "btn-primary");
      if (unconfirmed(trip, rider)) button("handled", "Handled");
      button("undo", "Undo");
      break;
    case "no_show":
      button("board", "Boarded late");
      if (!rider.handled) button("handled", "Handled");
      button("undo", "Undo");
      break;
    default:
      button("undo", "Undo");
  }
  return buttons;
}

function RiderRow({ trip, rider, ctx }: { trip: CheckTrip; rider: CheckRider; ctx: Ctx }) {
  const flag = unconfirmed(trip, rider) || missed(trip, rider);
  const name = `${rider.givenName} ${rider.familyName}`;
  return <li className={`rr${flag ? " flag" : ""}`}>
    <Avatar name={name} color={ctx.colorOf(trip.busId)} size={34} />
    <div className="rn"><b>{name}</b><small>{trip.servicePeriod === "AM" ? "Pick-up " : "Drop-off "}{stopLabel(trip, rider.stopId)}
      {rider.stateAt && rider.state !== "expected" ? ` · ${time(rider.stateAt)}${rider.stateBy ? ` · ${rider.stateBy}` : ""}` : ""}</small></div>
    <div>{flag ? <span className="rs rs-noshow">CHECK</span> : <span className={`rs rs-${pillClass(rider.state)}`}>{pillWord(rider.state)}</span>}</div>
    <div className="ra">{riderButtons(trip, rider, ctx)}</div>
  </li>;
}

function Chips({ trip }: { trip: CheckTrip }) {
  const c = counts(trip);
  return <div className="cc"><span><b>{c.aboard}</b> aboard</span><span><b>{c.dropped}</b> off</span><span><b>{c.expected}</b> waiting</span>
    {c.no_show > 0 && <span className="bad"><b>{c.no_show}</b> no-show</span>}
    {c.not_riding > 0 && <span><b>{c.not_riding}</b> not riding</span>}</div>;
}

function Sweep({ trip, ctx }: { trip: CheckTrip; ctx: Ctx }) {
  const c = counts(trip);
  if (trip.status === "planned" || trip.status === "cancelled") return <div className="sweep"><b>End of trip check</b><span>Available once the trip is running.</span></div>;
  if (trip.sweep) return <div className="sweep ok"><b>Bus checked empty</b><span>{trip.sweep.confirmedBy} · {time(trip.sweep.confirmedAt)}</span></div>;
  const atEnd = trip.status === "completed" || !!trip.stops.at(-1)?.arrivedAt;
  const can = c.aboard === 0 && atEnd;
  return <div className={`sweep${trip.status === "completed" ? " bad" : ""}`}><b>End of trip check</b>
    <span>{c.aboard > 0 ? `${c.aboard} still marked aboard. Resolve them first.` : can ? "Nobody is marked aboard. Walk the bus, then confirm." : "Available at the last stop."}</span>
    <button type="button" className="btn sm btn-primary" disabled={!can || ctx.busy} onClick={() => ctx.sweep(trip.id)}>Confirm bus is empty</button></div>;
}

function Manifest({ trip, now, ctx }: { trip: CheckTrip; now: number; ctx: Ctx }) {
  const c = counts(trip);
  const tripAlerts = alerts(trip, now);
  const am = trip.servicePeriod === "AM";
  const running = trip.status === "active";
  const groups = trip.stops.map((stop, index) => ({
    stop, index, riders: trip.riders.filter((rider) => rider.stopId === stop.id)
  })).filter((group) => group.riders.length || (am ? group.index === trip.stops.length - 1 : group.index === 0));
  const current = trip.stops.findIndex((stop) => !stop.departedAt);
  return <>
    <p className="eyebrow">MANIFEST</p>
    <h2 className="dt">{trip.busLabel} <span className="per">{trip.servicePeriod}</span></h2>
    <p className="muted" style={{ margin: "0 0 12px" }}>{trip.routeName} &middot; {time(trip.departureAt)} &middot; {trip.assignedStaff ? `Monitor: ${trip.assignedStaff.displayName}` : "No monitor assigned"}</p>
    <Chips trip={trip} />
    {tripAlerts.length > 0 && <div className="surface" style={{ marginTop: 14 }}><AlertRows list={tripAlerts.map((alert) => ({ trip, alert }))} ctx={ctx} /></div>}
    {running && (c.expected > 0 || c.aboard > 0) && <div className="acts">
      {c.expected > 0 && <button type="button" className="btn" disabled={ctx.busy} onClick={() => ctx.bulk(trip.id, "board_waiting")}>
        Everyone waiting boarded ({c.expected})</button>}
      {c.aboard > 0 && <button type="button" className="btn" disabled={ctx.busy} onClick={() => ctx.bulk(trip.id, "drop_aboard")}>
        Everyone aboard got off ({c.aboard})</button>}
    </div>}
    <Sweep trip={trip} ctx={ctx} />
    <div className="sec-h"><h2>Riders by stop</h2><span>{am ? "Pick-ups" : "Drop-offs"}</span></div>
    {!trip.riders.length && <p className="muted">No riders are assigned to this route.</p>}
    {groups.map((group) => {
      const passed = stopPassed(trip, group.stop.id);
      const extra = !am && group.index === 0 ? "All board here" : am && group.index === trip.stops.length - 1 ? "All get off here" : "";
      return <div key={group.stop.id} className="sg">
        <div className="sgh"><i style={{ "--c": ctx.colorOf(trip.busId) } as CSSProperties} /><b>{group.index + 1}. {group.stop.label}</b>
          <span>{passed ? "Passed" : group.index === current && running ? "Next" : ""}{extra ? `${passed || (group.index === current && running) ? " · " : ""}${extra}` : ""}</span></div>
        {group.riders.length > 0 && <ul className="rl">{group.riders.map((rider) => <RiderRow key={rider.riderId} trip={trip} rider={rider} ctx={ctx} />)}</ul>}
      </div>;
    })}
    <div className="sec-h"><h2>Check log</h2><span>Newest first</span></div>
    {trip.events.length ? <ul className="nl">{trip.events.slice(0, 40).map((event) => <li key={`${event.id}-${event.kind}`}>
      <time>{time(event.occurredAt)}</time>
      <div><b>{event.kind === "bus_checked_empty" ? "Bus checked empty" : `${event.riderName ?? "Rider"}: ${{
        boarded: "boarded", dropped_off: am ? "at camp" : "dropped off", no_show: "no-show", not_riding: "not riding",
        undone: "check undone", handled: "follow-up handled" }[event.kind]}`}</b></div>
      <span className="n">By {event.recordedBy}</span>
    </li>)}</ul> : <p className="muted">No checks recorded yet.</p>}
    <p className="hint" style={{ marginTop: 12 }}>Guardian notifications are not connected yet. Use the guardian&rsquo;s phone number to reach them.</p>
  </>;
}

function AlertButtons({ trip, alert, ctx, big }: { trip: CheckTrip; alert: CheckAlert; ctx: Ctx; big?: boolean }) {
  const cls = (primary: boolean) => big ? `bigbtn${primary ? "" : " out"}` : `btn sm${primary ? " btn-primary" : ""}`;
  const rider = alert.rider;
  const phone = rider?.guardians.find((guardian) => guardian.phone);
  switch (alert.key) {
    case "unconf":
      return <>
        <button type="button" className={cls(true)} disabled={ctx.busy} onClick={() => ctx.act(trip.id, rider!.riderId, "drop")}>
          {big ? `${rider!.givenName} got off` : "Mark dropped off"}</button>
        <button type="button" className={cls(false)} disabled={ctx.busy} onClick={() => ctx.act(trip.id, rider!.riderId, "handled")}>
          {big ? `${rider!.givenName} is still on` : "Still aboard, handled"}</button></>;
    case "missed":
      return <>
        <button type="button" className={cls(true)} disabled={ctx.busy} onClick={() => ctx.act(trip.id, rider!.riderId, "board")}>
          {big ? `${rider!.givenName} got on` : "Boarded"}</button>
        <button type="button" className={cls(false)} disabled={ctx.busy} onClick={() => ctx.act(trip.id, rider!.riderId, "no_show")}>
          {big ? `${rider!.givenName} was not there` : "No-show"}</button></>;
    case "noshow":
      return <>
        {phone?.phone && <a className={cls(false)} href={`tel:${phone.phone}`}>{big ? `Call ${phone.name.split(" ")[0]}` : "Call guardian"}</a>}
        <button type="button" className={cls(true)} disabled={ctx.busy} onClick={() => ctx.act(trip.id, rider!.riderId, "handled")}>Mark handled</button></>;
    case "sweep":
      return counts(trip).aboard > 0
        ? <button type="button" className={cls(false)} onClick={() => ctx.openManifest(trip.id)}>Open manifest</button>
        : <button type="button" className={cls(true)} disabled={ctx.busy} onClick={() => ctx.sweep(trip.id)}>{big ? "The bus is empty" : "Confirm bus is empty"}</button>;
    case "nomon":
      return <button type="button" className={cls(true)} onClick={() => ctx.openDispatch(trip.id)}>Assign staff</button>;
    case "stale":
      return <>
        <button type="button" className={cls(true)} onClick={() => ctx.openDispatch(trip.id)}>Open in Dispatch</button>
        {!big && <button type="button" className={cls(false)} onClick={() => ctx.openManifest(trip.id)}>Open manifest</button>}</>;
    default:
      return <button type="button" className={cls(true)} onClick={() => ctx.openManifest(trip.id)}>{big ? "Open the list" : "Open manifest"}</button>;
  }
}

function AlertRows({ list, ctx }: { list: { trip: CheckTrip; alert: CheckAlert }[]; ctx: Ctx }) {
  return <>{list.map(({ trip, alert }, index) => <div key={`${trip.id}-${alert.key}-${alert.rider?.riderId ?? index}`} className={`ax sev-${alert.sev}`}>
    <span className="sv">{alert.sev === "high" ? "URGENT" : "FOLLOW UP"}</span>
    <div className="at"><b>{alert.text}</b><small><Swatch color={ctx.colorOf(trip.busId)} />{trip.busLabel} · {routeWithPeriod(trip.routeName, trip.servicePeriod)}</small></div>
    <div className="ab2"><AlertButtons trip={trip} alert={alert} ctx={ctx} /></div>
  </div>)}</>;
}

function simpleTitle(trip: CheckTrip, alert: CheckAlert) {
  const name = alert.rider?.givenName;
  switch (alert.key) {
    case "unconf": return `${name} may still be on ${trip.busLabel}`;
    case "missed": return `${name} was not checked`;
    case "noshow": return `${name} was not at the stop`;
    case "sweep": return `${trip.busLabel} was not checked`;
    case "nomon": return `${trip.busLabel} has no monitor`;
    case "stale": return `${trip.busLabel} lost contact`;
    default: return `${trip.busLabel}: ${alert.short}`;
  }
}

function TripCard({ trip, now, ctx }: { trip: CheckTrip; now: number; ctx: Ctx }) {
  const tripAlerts = alerts(trip, now);
  const head = headcount(trip);
  return <button type="button" className="tripcard" style={{ "--c": ctx.colorOf(trip.busId) } as CSSProperties} onClick={() => ctx.openManifest(trip.id)}>
    <HeadRing trip={trip} color={ctx.colorOf(trip.busId)} size={74} />
    <div className="m"><strong>{trip.busLabel} <span className="per">{trip.servicePeriod}</span></strong>
      <small>{trip.routeName} &middot; {time(trip.departureAt)} &middot; {trip.status}</small>
      <small>{head.label} {head.n} of {head.of}</small>
      {tripAlerts.length > 0 && <div className="ch">{tripAlerts.map((alert, index) =>
        <span key={`${alert.key}-${index}`} className={`od${alert.sev === "med" ? " med" : ""}`}>{alert.short.toUpperCase()}</span>)}</div>}
    </div>
  </button>;
}

export function CheckPage() {
  const { mode, toast } = useOps();
  const navigate = useNavigate();
  const board = useCheckBoard();
  const now = useNow();
  const [manifestId, setManifestId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (url: string, body: unknown, done?: string) => {
    setBusy(true);
    try {
      await send("POST", url, body, "Could not record the check.");
      if (done) toast(done);
      board.reload();
    } catch (cause) {
      toast(message(cause, "Could not record the check."));
    } finally { setBusy(false); }
  }, [board, toast]);

  const ctx: Ctx = {
    busy, colorOf: board.colorOf,
    act: (tripId, riderId, type) => void run(`/api/check/trips/${tripId}/riders/${riderId}`, { type }),
    bulk: (tripId, type) => void run(`/api/check/trips/${tripId}/bulk`, { type }, type === "board_waiting" ? "Everyone waiting is checked on." : "Everyone aboard is checked off."),
    sweep: (tripId) => void run(`/api/check/trips/${tripId}/sweep`, undefined, "Bus checked empty."),
    openManifest: setManifestId,
    openDispatch: (tripId) => navigate(`/?trip=${tripId}`)
  };

  const order = { active: 0, planned: 1, completed: 2, cancelled: 3 };
  const trips = useMemo(() => [...board.trips].filter((trip) => trip.status !== "cancelled")
    .sort((a, b) => order[a.status] - order[b.status] || Date.parse(a.departureAt) - Date.parse(b.departureAt)), [board.trips]);
  const all = trips.flatMap((trip) => alerts(trip, now).map((alert) => ({ trip, alert })))
    .sort((a, b) => (a.alert.sev === "high" ? 0 : 1) - (b.alert.sev === "high" ? 0 : 1));
  const urgent = all.filter((item) => item.alert.sev === "high").length;
  const aboard = trips.filter((trip) => trip.status === "active").reduce((sum, trip) => sum + counts(trip).aboard, 0);
  const waiting = trips.filter((trip) => trip.status === "planned").reduce((sum, trip) => sum + counts(trip).expected, 0);
  const checks = trips.reduce((sum, trip) => sum + trip.events.length, 0);

  const manifestTrip = manifestId ? board.trips.find((trip) => trip.id === manifestId) : null;
  const overlayView = manifestId && <Overlay onClose={() => setManifestId(null)}>
    {manifestTrip ? <Manifest trip={manifestTrip} now={now} ctx={ctx} /> : <NoMatch>Trip not found.</NoMatch>}
  </Overlay>;
  const status = <><ErrorNote text={board.error} />{board.loading && <p className="hint">Loading trips…</p>}</>;
  const none = !board.loading && !trips.length;

  if (mode === "desktop") {
    return <>
      <Head eyebrow="RIDE CHECK" title="Ride Check" sub="Every child accounted for, on every trip." actions={<LivePill state={board.live} />} />
      {status}
      <div className="tiles">
        <Tile label="Aboard right now" value={aboard} sub="Children on running buses" />
        <Tile label="Waiting to ride" value={waiting} sub="On planned trips" />
        <Tile label="Needs a decision" value={all.length} sub={`${urgent} urgent`} className="bad" />
        <Tile label="Checks recorded" value={checks} sub="Today, all trips" />
      </div>
      <div className="sec-h"><h2>Needs a decision</h2><span>{all.length} open</span></div>
      <section className="surface">{all.length ? <AlertRows list={all} ctx={ctx} /> : <p className="nomatch">Everyone is accounted for.</p>}</section>
      <div className="sec-h"><h2>Trips today</h2><span>Tap a trip to open its manifest</span></div>
      {none ? <NoMatch>No trips today.</NoMatch> : <div className="grid3">{trips.map((trip) => <TripCard key={trip.id} trip={trip} now={now} ctx={ctx} />)}</div>}
      {overlayView}
    </>;
  }

  if (mode === "adv") {
    return <>
      <Head eyebrow="RIDE CHECK" title="Inbox" sub="Things that need a decision" actions={<LivePill state={board.live} />} />
      {status}
      <div className="darkcard"><div><strong>{all.length}</strong><small>{urgent} urgent, {all.length - urgent} follow up</small></div>
        <div><strong>{aboard}</strong><small>children aboard</small></div></div>
      {all.length ? <AlertRows list={all} ctx={ctx} /> : <p className="nomatch">Everyone is accounted for.</p>}
      <div className="sec-h"><h2>Trips today</h2><span>Tap for the list</span></div>
      {none ? <NoMatch>No trips today.</NoMatch> : <div className="cards">{trips.map((trip) => <TripCard key={trip.id} trip={trip} now={now} ctx={ctx} />)}</div>}
      {overlayView}
    </>;
  }

  return <>
    <h1 className="sh1">Anyone missing?</h1>
    {status}
    {all.length ? <p className="sline bad">{all.length} {plural(all.length, "thing needs you.", "things need you.")}</p>
      : !board.loading && <p className="sline ok">Everyone is accounted for.</p>}
    {all.map(({ trip, alert }, index) => <div key={`${trip.id}-${alert.key}-${alert.rider?.riderId ?? index}`} className="scard">
      <h2><Dot tone={alert.sev === "high" ? "bad" : "warn"} />{simpleTitle(trip, alert)}</h2>
      <p>{alert.text}</p>
      <AlertButtons trip={trip} alert={alert} ctx={ctx} big />
    </div>)}
    <h2 className="sh2">All trips</h2>
    <div className="sl">{trips.map((trip) => {
      const head = headcount(trip);
      const tripAlerts = alerts(trip, now);
      return <SRow key={trip.id} tone={tripAlerts.length ? "bad" : trip.status === "active" ? "ok" : ""} smallTone={tripAlerts.length ? "bad" : ""}
        onClick={() => setManifestId(trip.id)}
        small={`${head.n} of ${head.of} ${head.label}. ${trip.status === "planned" ? "Not started." : trip.status === "completed" ? "Finished." : "Running."}${tripAlerts.length ? ` ${tripAlerts.length} to check.` : ""}`}>
        <b>{trip.busLabel}</b> {routeWithPeriod(trip.routeName, trip.servicePeriod)}.</SRow>;
    })}{none && <NoMatch>No trips today.</NoMatch>}</div>
    {overlayView}
  </>;
}


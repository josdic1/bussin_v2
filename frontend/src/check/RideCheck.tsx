import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { CheckRider, CheckTrip, RiderCheckAction } from "@bussin/shared";
import { message, send } from "../ops/api";
import { time, routeWithPeriod } from "../ops/format";
import { Swatch } from "../ops/ui";
import {
  alerts, counts, headcount, missed, pillWord, stopPassed, unconfirmed,
  type CheckAlert
} from "./checkModel";

/*
 * Ride Check for one bus, shown in the bus drawer on Dispatch. Who's on, who's missing,
 * who isn't riding, with one tap to fix each. There is no separate Ride Check page:
 * with a handful of buses on the same run, each bus's kids belong with that bus.
 */

type Act = (tripId: string, riderId: string, type: RiderCheckAction["type"]) => void;
type Ctx = {
  act: Act; bulk: (tripId: string, type: "board_waiting" | "drop_aboard", stopId: string) => void; sweep: (tripId: string) => void;
  busy: boolean;
  colorOf: (busId: string) => string;
};

/** What a check does to the rider right away, before the server confirms. */
function optimistic(rider: CheckRider, type: RiderCheckAction["type"]): CheckRider {
  const at = new Date().toISOString();
  switch (type) {
    case "board": return { ...rider, state: "aboard", stateAt: at, boardedAt: at, handled: false };
    case "drop": return { ...rider, state: "dropped", stateAt: at, handled: false };
    case "no_show": return { ...rider, state: "no_show", stateAt: at, handled: false };
    case "not_riding": return { ...rider, state: "not_riding", stateAt: at, handled: false };
    case "handled": return { ...rider, handled: true };
    default: return rider;
  }
}

function HeadRing({ trip, color, size = 84 }: { trip: CheckTrip; color: string; size?: number }) {
  const head = headcount(trip);
  const percent = head.of ? Math.round(head.n / head.of * 100) : 0;
  return <span className="hc" style={{ "--s": `${size}px`, "--p": percent, "--c": color } as CSSProperties}>
    <b>{head.n}<small>of {head.of}</small></b>
  </span>;
}

function riderButtons(trip: CheckTrip, rider: CheckRider, ctx: Ctx) {
  const am = trip.servicePeriod === "AM";
  const buttons: ReactNode[] = [];
  const phone = rider.guardians.find((guardian) => guardian.phone);
  const button = (type: RiderCheckAction["type"], label: string, cls = "") =>
    buttons.push(<button key={type} type="button" className={cls} disabled={ctx.busy}
      onClick={() => ctx.act(trip.id, rider.riderId, type)}>{label}</button>);
  if (trip.status === "cancelled") return null;
  if (trip.status === "planned") {
    if (rider.state === "expected") button("not_riding", "Not riding", "q");
    else if (rider.state === "not_riding") button("undo", "Undo", "q");
    return buttons;
  }
  switch (rider.state) {
    case "expected":
      button("board", "On");
      if (am) button("no_show", "No-show", "ns");
      else if (trip.status === "active") button("not_riding", "Not riding", "q");
      break;
    case "aboard":
      button("drop", am ? "At camp" : "Off");
      if (unconfirmed(trip, rider)) button("handled", "Still on", "q");
      button("undo", "Undo", "q");
      break;
    case "no_show":
      if (phone?.phone && !rider.handled) buttons.push(<a key="call" href={`tel:${phone.phone}`}>Call</a>);
      button("board", "Boarded late");
      if (!rider.handled) button("handled", "Handled", "q");
      button("undo", "Undo", "q");
      break;
    default:
      button("undo", "Undo", "q");
  }
  return buttons;
}

function RiderRow({ trip, rider, ctx }: { trip: CheckTrip; rider: CheckRider; ctx: Ctx }) {
  const flag = unconfirmed(trip, rider) || missed(trip, rider);
  const status = flag
    ? trip.servicePeriod === "AM" ? "Bus left without a check" : "Still marked aboard after this stop"
    : `${pillWord(rider.state).toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}${rider.stateAt && rider.state !== "expected" ? ` ${time(rider.stateAt)}${rider.stateBy ? ` · ${rider.stateBy}` : ""}` : ""}`;
  return <div className={`rider${flag ? " flag" : ""}`}>
    <div><b>{rider.givenName} {rider.familyName}</b><small>{status}</small></div>
    <div className="rbt">{riderButtons(trip, rider, ctx)}</div>
  </div>;
}

function Sweep({ trip, ctx }: { trip: CheckTrip; ctx: Ctx }) {
  const c = counts(trip);
  if (trip.status === "planned" || trip.status === "cancelled") return null;
  if (trip.sweep) return <div className="sweep ok"><b>Bus checked empty</b><span>{trip.sweep.confirmedBy} · {time(trip.sweep.confirmedAt)}</span></div>;
  const atEnd = trip.status === "completed" || !!trip.stops.at(-1)?.arrivedAt;
  const can = c.aboard === 0 && atEnd;
  return <div className={`sweep${trip.status === "completed" ? " bad" : ""}`}><b>End of trip check</b>
    <span>{c.aboard > 0 ? `${c.aboard} still marked aboard. Resolve them first.` : can ? "Nobody is marked aboard. Walk the bus, then confirm." : "Available at the last stop."}</span>
    <button type="button" className="btn sm btn-primary" disabled={!can || ctx.busy} onClick={() => ctx.sweep(trip.id)}>Confirm bus is empty</button></div>;
}

/**
 * The manifest follows the route: passed stops collapse to a line of names
 * (and stay open if someone was missed), the stop the bus is at is highlighted
 * with its own bulk action, and upcoming stops wait below.
 */
function Manifest({ trip, now, ctx }: { trip: CheckTrip; now: number; ctx: Ctx }) {
  const tripAlerts = alerts(trip, now);
  const am = trip.servicePeriod === "AM";
  const running = trip.status === "active";
  const current = running ? trip.stops.findIndex((stop) => !stop.departedAt) : -1;
  const lastIndex = trip.stops.length - 1;
  const currentRef = useRef<HTMLDivElement>(null);
  useEffect(() => { currentRef.current?.scrollIntoView({ block: "center" }); }, [trip.id]);
  const color = ctx.colorOf(trip.busId);
  const head = headcount(trip);

  const groups = trip.stops.map((stop, index) => ({
    stop, index, riders: trip.riders.filter((rider) => rider.stopId === stop.id)
  })).filter((group) => group.riders.length || (am ? group.index === lastIndex : group.index === 0));

  return <>
    <div className="dblock rc-head" style={{ display: "flex", gap: 14, alignItems: "center" }}>
      <HeadRing trip={trip} color={color} size={64} />
      <div><h3 style={{ margin: 0 }}>Kids on this bus</h3>
        <p className="muted" style={{ margin: "4px 0 0" }}>{head.n} of {head.of} {head.label}{counts(trip).not_riding ? ` · ${counts(trip).not_riding} not riding` : ""}</p></div>
    </div>
    {tripAlerts.length > 0 && <div className="surface" style={{ marginBottom: 12 }}><AlertRows list={tripAlerts.map((alert) => ({ trip, alert }))} ctx={ctx} /></div>}
    <Sweep trip={trip} ctx={ctx} />
    {!trip.riders.length && <p className="muted">No riders are assigned to this route.</p>}
    {groups.map((group) => {
      const passed = stopPassed(trip, group.stop.id);
      const here = group.index === current;
      const flagged = group.riders.filter((rider) => unconfirmed(trip, rider) || missed(trip, rider));
      const boardsHere = am ? group.riders : group.index === 0 ? trip.riders : [];
      const leavesHere = am ? (group.index === lastIndex ? trip.riders : []) : group.riders;
      const waiting = boardsHere.filter((rider) => rider.state === "expected").length;
      const onboard = leavesHere.filter((rider) => rider.state === "aboard").length;
      const collapsed = passed && !flagged.length && !here;
      const label = here ? "Bus is here" : flagged.length ? "Check needed" : passed ? "Passed" : "Upcoming";
      const extra = !am && group.index === 0 ? " · everyone boards here" : am && group.index === lastIndex ? " · everyone gets off here" : "";
      return <div key={group.stop.id} ref={here ? currentRef : undefined}
        className={`stopg${here ? " cur" : ""}${flagged.length ? " flag" : ""}`} style={{ "--c": color } as CSSProperties}>
        <div className="sgh"><b><i />{group.index + 1}. {group.stop.label}</b><span>{label}{extra}</span></div>
        {collapsed
          ? group.riders.length > 0 && <div className="passedline">{group.riders.map((rider) =>
            `${rider.givenName} ${rider.familyName}${rider.state === "no_show" ? " (no-show)" : rider.state === "not_riding" ? " (not riding)" : ""}`).join(", ")}</div>
          : group.riders.map((rider) => <RiderRow key={rider.riderId} trip={trip} rider={rider} ctx={ctx} />)}
        {running && here && waiting > 0 && <button type="button" className="bulkb" disabled={ctx.busy}
          onClick={() => ctx.bulk(trip.id, "board_waiting", group.stop.id)}>Everyone at {group.stop.label} boarded ({waiting})</button>}
        {running && here && onboard > 0 && group.stop.arrivedAt && <button type="button" className="bulkb" disabled={ctx.busy}
          onClick={() => ctx.bulk(trip.id, "drop_aboard", group.stop.id)}>Everyone for {group.stop.label} got off ({onboard})</button>}
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
  </>;
}

function AlertButtons({ trip, alert, ctx }: { trip: CheckTrip; alert: CheckAlert; ctx: Ctx }) {
  const cls = (primary: boolean) => `btn sm${primary ? " btn-primary" : ""}`;
  const rider = alert.rider;
  const phone = rider?.guardians.find((guardian) => guardian.phone);
  switch (alert.key) {
    case "unconf":
      return <>
        <button type="button" className={cls(true)} disabled={ctx.busy} onClick={() => ctx.act(trip.id, rider!.riderId, "drop")}>{rider!.givenName} got off</button>
        <button type="button" className={cls(false)} disabled={ctx.busy} onClick={() => ctx.act(trip.id, rider!.riderId, "handled")}>Still aboard, handled</button></>;
    case "missed":
      return <>
        <button type="button" className={cls(true)} disabled={ctx.busy} onClick={() => ctx.act(trip.id, rider!.riderId, "board")}>{rider!.givenName} got on</button>
        <button type="button" className={cls(false)} disabled={ctx.busy} onClick={() => ctx.act(trip.id, rider!.riderId, "no_show")}>Not at the stop</button>
        {phone?.phone && <a className={cls(false)} href={`tel:${phone.phone}`}>Call {phone.name.split(" ")[0]}</a>}</>;
    case "noshow":
      return <>
        {phone?.phone && <a className={cls(false)} href={`tel:${phone.phone}`}>Call {phone.name.split(" ")[0]}</a>}
        <button type="button" className={cls(true)} disabled={ctx.busy} onClick={() => ctx.act(trip.id, rider!.riderId, "handled")}>Mark handled</button></>;
    case "sweep":
      return counts(trip).aboard > 0 ? null
        : <button type="button" className={cls(true)} disabled={ctx.busy} onClick={() => ctx.sweep(trip.id)}>Confirm bus is empty</button>;
    default:
      return null;
  }
}

function AlertRows({ list, ctx }: { list: { trip: CheckTrip; alert: CheckAlert }[]; ctx: Ctx }) {
  return <>{list.map(({ trip, alert }, index) => <div key={`${trip.id}-${alert.key}-${alert.rider?.riderId ?? index}`} className={`ax sev-${alert.sev}`}>
    <span className="sv">{alert.sev === "high" ? "URGENT" : "FOLLOW UP"}</span>
    <div className="at"><b>{alert.text}</b><small><Swatch color={ctx.colorOf(trip.busId)} />{trip.busLabel} · {routeWithPeriod(trip.routeName, trip.servicePeriod)}</small></div>
    <div className="ab2"><AlertButtons trip={trip} alert={alert} ctx={ctx} /></div>
  </div>)}</>;
}

/** Ride Check for one trip. Taps show at once and save in the background; the board refreshes after. */
export function RideCheck({ trip, now, color, onChanged, toast }: {
  trip: CheckTrip; now: number; color: string; onChanged: () => void; toast: (text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(trip);
  useEffect(() => setShown(trip), [trip]);

  async function run(url: string, body: unknown, done?: string) {
    setBusy(true);
    try {
      await send("POST", url, body, "Could not record the check.");
      if (done) toast(done);
    } catch (cause) {
      toast(message(cause, "Could not record the check."));
      setShown(trip);
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  const ctx: Ctx = {
    busy, colorOf: () => color,
    act: (tripId, riderId, type) => {
      setShown((current) => ({ ...current, riders: current.riders.map((rider) => rider.riderId === riderId ? optimistic(rider, type) : rider) }));
      void run(`/api/check/trips/${tripId}/riders/${riderId}`, { type });
    },
    bulk: (tripId, type, stopId) => void run(`/api/check/trips/${tripId}/bulk`, { type, stopId },
      type === "board_waiting" ? "Everyone waiting here is checked on." : "Everyone for this stop is checked off."),
    sweep: (tripId) => void run(`/api/check/trips/${tripId}/sweep`, undefined, "Bus checked empty.")
  };
  return <section className="rc"><Manifest trip={shown} now={now} ctx={ctx} /></section>;
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { familyMessagesResponseSchema, familyPortalResponseSchema, type FamilyMessage, type FamilyPortalRide } from "@bussin/shared";
import { useAuth } from "../auth/AuthProvider";
import { BusAlerts } from "./BusAlerts";

const clock = (value: string | number) => new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function sentWhen(value: string) {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const day = date.toDateString() === today.toDateString() ? "Today"
    : date.toDateString() === yesterday.toDateString() ? "Yesterday"
      : date.toLocaleDateString([], { month: "short", day: "numeric" });
  return `${day} ${clock(value)}`;
}

const DAY = 86_400_000;

function MessageItem({ item, isNew }: { item: FamilyMessage; isNew: boolean }) {
  return <article className={`fmsg${isNew ? " new" : ""}`}>
    <div className="fmsg-top"><span>{isNew ? "New · " : ""}{item.audienceLabel}</span><time dateTime={item.sentAt}>{sentWhen(item.sentAt)}</time></div>
    <p>{item.body}</p>
  </article>;
}

/** New and last-24-hour messages sit above the bus; anything older waits below it, folded away. */
function splitMessages(messages: FamilyMessage[], fresh: Set<string>, now: number) {
  const recent = messages.filter((item) => fresh.has(item.id) || now - Date.parse(item.sentAt) < DAY);
  const top = recent.slice(0, Math.max(2, recent.filter((item) => fresh.has(item.id)).length));
  return { top, earlier: messages.filter((item) => !top.includes(item)) };
}

function EarlierMessages({ messages }: { messages: FamilyMessage[] }) {
  const [open, setOpen] = useState(false);
  if (!messages.length) return null;
  return <section className="fmsgs earlier" aria-label="Earlier messages">
    <button type="button" className="fmsgs-more" aria-expanded={open} onClick={() => setOpen(!open)}>
      {open ? "Hide earlier messages" : `Earlier messages (${messages.length})`}</button>
    {open && messages.map((item) => <MessageItem key={item.id} item={item} isNew={false} />)}
  </section>;
}

/** Siblings on the same trip and stop share one card. Each kid keeps their own ride (riding or not). */
type RideGroup = { key: string; riders: string[]; ride: FamilyPortalRide; kids: FamilyPortalRide[] };

function groupRides(rides: FamilyPortalRide[]): RideGroup[] {
  const groups = new Map<string, RideGroup>();
  for (const ride of rides) {
    const key = `${ride.tripId}:${ride.stop.id}`;
    const group = groups.get(key);
    if (group) { group.kids.push(ride); if (ride.riding) group.riders.push(ride.riderName); }
    else groups.set(key, { key, riders: ride.riding ? [ride.riderName] : [], ride, kids: [ride] });
  }
  return [...groups.values()];
}

type SetRiding = (ride: FamilyPortalRide, riding: boolean) => void;
const rideKey = (ride: FamilyPortalRide) => `${ride.tripId}:${ride.riderId}`;
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
function dayWords(value: string) {
  const day = new Date(value);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return sameDay(day, tomorrow) ? `Tomorrow, ${day.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}`
    : day.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
}

/** One kid on one bus: riding, or not, with the switch while it can still change. */
function RidingRow({ ride, busy, setRiding, label }: { ride: FamilyPortalRide; busy: boolean; setRiding: SetRiding; label: string }) {
  return <div className={`frow${ride.riding ? "" : " off"}`}>
    <div><b>{label}</b><small>{ride.riding ? "Riding" : ride.ridingNote ?? "Not riding"}</small></div>
    {ride.canChange && <button type="button" className={ride.riding ? "" : "back"} disabled={busy}
      onClick={() => setRiding(ride, !ride.riding)}>{busy ? "Saving…" : ride.riding ? "Not riding" : "Riding after all"}</button>}
  </div>;
}

/** Later days: one line per bus per kid, so a parent can mark days off ahead of time. */
function ComingUp({ groups, busy, setRiding }: { groups: RideGroup[]; busy: Set<string>; setRiding: SetRiding }) {
  const [all, setAll] = useState(false);
  const days = new Map<string, RideGroup[]>();
  for (const group of groups) {
    const key = new Date(group.ride.departureAt).toDateString();
    days.set(key, [...(days.get(key) ?? []), group]);
  }
  if (!days.size) return null;
  return <section className="fcoming" aria-label="Coming up">
    <h2>Coming up</h2>
    <p className="fsub">Kid staying home? Mark it here and the counselors on the bus see it.</p>
    {[...days.values()].slice(0, all ? undefined : 5).map((list) => <div key={list[0]!.key} className="fday">
      <h3>{dayWords(list[0]!.ride.departureAt)}</h3>
      {list.flatMap((group) => group.kids.map((ride) => <RidingRow key={rideKey(ride)} ride={ride} busy={busy.has(rideKey(ride))} setRiding={setRiding}
        label={`${clock(ride.departureAt)} · ${ride.servicePeriod === "AM" ? "To camp" : "Home"} · ${ride.riderName.split(" ")[0]}`} />))}
    </div>)}
    {!all && days.size > 5 && <button type="button" className="fmsgs-more" onClick={() => setAll(true)}>Show {days.size - 5} more days</button>}
  </section>;
}

function initials(name: string) {
  const words = name.trim().split(/\s+/);
  return ((words[0]?.[0] ?? "") + (words.length > 1 ? words.at(-1)![0] : "")).toUpperCase();
}

function names(list: string[]) {
  const first = list.map((name) => name.split(" ")[0]);
  return first.length <= 1 ? first[0] ?? "" : `${first.slice(0, -1).join(", ")} and ${first.at(-1)}`;
}

function MiniMap({ ride }: { ride: FamilyPortalRide }) {
  const stops = ride.routeStops;
  const bus = ride.tripStatus === "active" && ride.location ? ride.location : null;
  const project = useMemo(() => {
    const points = [...stops.map((stop) => [stop.longitude, stop.latitude]), ...(bus ? [[bus.longitude, bus.latitude]] : [])];
    if (!points.length) return null;
    const xs = points.map((point) => point[0]);
    const ys = points.map((point) => point[1]);
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const scaleX = Math.cos((minY + maxY) / 2 * Math.PI / 180);
    const width = Math.max((maxX - minX) * scaleX, 0.002);
    const height = Math.max(maxY - minY, 0.002);
    const k = Math.min(330 / width, 120 / height);
    const ox = (380 - width * k) / 2;
    const oy = (160 - height * k) / 2;
    return (lng: number, lat: number) => [ox + (lng - minX) * scaleX * k, 160 - (oy + (lat - minY) * k)] as const;
  }, [stops, bus]);
  if (!project || stops.length < 2) return null;
  const line = stops.map((stop) => project(stop.longitude, stop.latitude).map((value) => value.toFixed(1)).join(",")).join(" ");
  const mine = stops.find((stop) => stop.id === ride.stop.id);
  const mineXY = mine ? project(mine.longitude, mine.latitude) : null;
  const busXY = bus ? project(bus.longitude, bus.latitude) : null;
  return <div className="fmap"><svg viewBox="0 0 380 160" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Route with the bus and your stop">
    <rect width="380" height="160" fill="#eef1ea" />
    <polyline points={line} fill="none" stroke="#28704c" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" opacity=".85" />
    {stops.map((stop) => {
      const [x, y] = project(stop.longitude, stop.latitude);
      const me = stop.id === ride.stop.id;
      return <circle key={stop.id} cx={x} cy={y} r={me ? 9 : 5} fill={stop.passed ? "#28704c" : "#fff"}
        stroke={me ? "#17382c" : "#28704c"} strokeWidth={me ? 4 : 3} />;
    })}
    {mineXY && <text x={Math.min(300, Math.max(6, mineXY[0] - 28))} y={mineXY[1] > 120 ? mineXY[1] - 16 : mineXY[1] + 28}
      fontSize="12" fontWeight="800" fill="#17382c">Your stop</text>}
    {busXY && <g transform={`translate(${busXY[0].toFixed(1)},${busXY[1].toFixed(1)})`}>
      <circle r="18" fill="#28704c" opacity=".18" />
      <rect x="-20" y="-12" width="40" height="24" rx="8" fill="#17211b" stroke="#fff" strokeWidth="2" />
      <text y="4" textAnchor="middle" fontSize="10" fontWeight="900" fill="#fff">BUS</text></g>}
  </svg></div>;
}

function Card({ group, now, buffer, setBuffer, busy, setRiding }: {
  group: RideGroup; now: number; buffer: number; setBuffer: (minutes: number) => void; busy: Set<string>; setRiding: SetRiding;
}) {
  const { ride, riders } = group;
  const nobody = riders.length === 0;
  const who = names(riders);
  const stopEta = ride.eta?.stopEtaAt ?? null;
  const live = ride.tripStatus === "active" && !!stopEta;
  const leaveAt = stopEta ? Date.parse(stopEta) - buffer * 60_000 : null;
  const myIndex = ride.routeStops.findIndex((stop) => stop.id === ride.stop.id);
  const passedCount = ride.routeStops.filter((stop) => stop.passed).length;
  const away = myIndex >= 0 ? Math.max(0, myIndex - passedCount) : null;
  const picked = !!(ride.stop.arrivedAt || ride.stop.departedAt);
  const am = ride.servicePeriod === "AM";

  let banner: React.ReactNode;
  if (nobody) {
    banner = <div className="leave idle"><span className="ov">NOT RIDING</span>
      <div className="cd small">{ride.servicePeriod === "AM" ? "No pickup" : "No drop-off"}</div>
      <p>{group.kids.length > 1 ? "None of your kids are" : `${names(group.kids.map((kid) => kid.riderName))} isn't`} on this bus. The counselors know.</p></div>;
  } else if (ride.tripStatus === "planned") {
    banner = <div className="leave idle"><span className="ov">{new Date(ride.departureAt).toDateString() === new Date().toDateString() ? "LATER TODAY" : "NEXT TRIP"}</span>
      <div className="cd small">Leaves {clock(ride.departureAt)}</div><p>Live times start when the driver starts the trip.</p></div>;
  } else if (picked) {
    banner = <div className="leave aboard"><span className="ov">{am ? "ON THE BUS" : "DROPPED OFF"}</span>
      <div className="cd small">{am ? "Picked up" : "Arrived"} {clock(ride.stop.arrivedAt ?? ride.stop.departedAt!)}</div>
      <p>{am ? `${who} ${riders.length > 1 ? "are" : "is"} on ${ride.busLabel}.` : `${ride.busLabel} reached ${ride.stop.label}.`}</p></div>;
  } else if (live && leaveAt !== null && am) {
    const left = leaveAt - now;
    banner = left > 0
      ? <div className="leave"><span className="ov">LEAVE HOME IN</span>
        <div className="cd">{Math.floor(left / 60_000)}:{String(Math.floor(left / 1000) % 60).padStart(2, "0")}</div>
        <p>{ride.busLabel} reaches {ride.stop.label} about {clock(stopEta!)}</p></div>
      : <div className="leave now"><span className="ov">LEAVE NOW</span><div className="cd">Go</div>
        <p>{ride.busLabel} reaches {ride.stop.label} about {clock(stopEta!)}</p></div>;
  } else if (live) {
    banner = <div className="leave"><span className="ov">BUS ARRIVES ABOUT</span><div className="cd">{clock(stopEta!)}</div>
      <p>{ride.busLabel} at {ride.stop.label}</p></div>;
  } else {
    banner = <div className="leave idle"><span className="ov">ON THE WAY</span><div className="cd small">Live arrival paused</div>
      <p>{ride.busLabel} is running. Times come back as soon as its location updates.</p></div>;
  }

  return <section className="fcard">
    {banner}
    {ride.crewNotice && !picked && !nobody && <p className="fnotice"><b>From the bus · {clock(ride.crewNotice.at)}</b>{ride.crewNotice.text}</p>}
    {ride.tripStatus === "active" && !nobody && <MiniMap ride={ride} />}
    <div className="inner">
      <div className="kids">{group.kids.map((kid) => <span key={kid.riderId} className={`kid${kid.riding ? "" : " off"}`}><span>{initials(kid.riderName)}</span>{kid.riderName}</span>)}</div>
      <p className="fline">{ride.tripStatus === "planned" ? `${ride.busLabel} · ${ride.routeName}`
        : picked ? (am ? "Heading to camp" : "Home stop reached")
          : away === 0 ? "Your stop is next" : away !== null ? `${away} ${away === 1 ? "stop" : "stops"} away` : ride.routeName}</p>
      <p className="fsub">{ride.tripStatus === "active" && ride.location ? `Live · updated ${clock(ride.location.observedAt)}` : ride.routeName}</p>
      {ride.tripStatus === "active" && myIndex >= 0 && <div className="away" aria-hidden="true">
        {ride.routeStops.map((stop) => <i key={stop.id} className={stop.id === ride.stop.id ? "me" : stop.passed ? "on" : ""} />)}</div>}
    </div>
    <dl className="ffacts">
      <div><dt>Your stop</dt><dd>{ride.stop.label}</dd></div>
      <div><dt>Bus</dt><dd>{ride.busLabel} · {ride.servicePeriod}</dd></div>
    </dl>
    {group.kids.some((kid) => kid.canChange) && <div className="frows">{group.kids.map((kid) =>
      <RidingRow key={rideKey(kid)} ride={kid} busy={busy.has(rideKey(kid))} setRiding={setRiding} label={kid.riderName} />)}</div>}
    {am && !picked && !nobody && <div className="buf">
      <div><b>Warn me before the bus</b><small>Your walk to the stop</small></div>
      <div className="step">
        <button type="button" aria-label="Less time" onClick={() => setBuffer(Math.max(0, buffer - 1))}>&minus;</button>
        <span>{buffer} min</span>
        <button type="button" aria-label="More time" onClick={() => setBuffer(Math.min(60, buffer + 1))}>+</button>
      </div>
    </div>}
  </section>;
}

/**
 * preview: the admin's View as. Reads this parent's screen every few seconds and changes nothing:
 * messages are never marked read and the warning time is never saved.
 */
export function FamilyPortalPage({ preview }: { preview?: { memberId: string } } = {}) {
  const { logout, tenant } = useAuth();
  const portalUrl = preview ? `/api/preview/parent/${preview.memberId}/portal` : "/api/families/portal";
  const inboxUrl = preview ? `/api/preview/parent/${preview.memberId}/messages` : "/api/messages/mine";
  const [rides, setRides] = useState<FamilyPortalRide[]>([]);
  const [buffer, setBufferState] = useState(5);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const saveTimer = useRef<number | undefined>(undefined);
  const editing = useRef(false);
  const [messages, setMessages] = useState<FamilyMessage[]>([]);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const marking = useRef(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(portalUrl, { credentials: "same-origin", signal });
      if (!response.ok) throw new Error("Could not load your bus information.");
      const body = familyPortalResponseSchema.parse(await response.json());
      if (signal?.aborted) return;
      setRides(body.rides);
      if (!editing.current) setBufferState(body.leaveBufferMinutes);
      setError("");
      // Messages are extra: if they fail to load, the bus information still shows.
      const inbox = await fetch(inboxUrl, { credentials: "same-origin", signal })
        .then(async (reply) => reply.ok ? familyMessagesResponseSchema.parse(await reply.json()).messages : null)
        .catch(() => null);
      if (inbox && !signal?.aborted) {
        setMessages(inbox);
        const unread = inbox.filter((item) => !item.read).map((item) => item.id);
        if (unread.length) setFresh((current) => new Set([...current, ...unread]));
      }
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : "Could not load your bus information.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [portalUrl, inboxUrl]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const tick = () => { if (document.visibilityState === "visible") void load(controller.signal); };
    const timer = window.setInterval(tick, preview ? 5_000 : 15_000);
    document.addEventListener("visibilitychange", tick);
    return () => { controller.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
  }, [load, preview]);

  // Seen on screen for a few seconds counts as read; the office sees the read count.
  const unreadIds = messages.filter((item) => !item.read).map((item) => item.id).join(",");
  useEffect(() => {
    if (preview || !unreadIds || marking.current) return;
    const timer = window.setTimeout(() => {
      if (document.visibilityState !== "visible") return;
      marking.current = true;
      void fetch("/api/messages/mine/read", { method: "POST", credentials: "same-origin" })
        .then((reply) => { if (reply.ok) setMessages((list) => list.map((item) => ({ ...item, read: true }))); })
        .catch(() => undefined)
        .finally(() => { marking.current = false; });
    }, 3_000);
    return () => window.clearTimeout(timer);
  }, [unreadIds, preview]);

  const newCount = fresh.size;
  useEffect(() => {
    if (preview) return;
    const base = "Bussin";
    document.title = newCount ? `(${newCount}) ${base}` : base;
    return () => { document.title = base; };
  }, [newCount, preview]);

  function setBuffer(minutes: number) {
    setBufferState(minutes);
    if (preview) return;
    editing.current = true;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void fetch("/api/families/me/leave-buffer", {
        method: "PUT", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ minutes })
      }).then((response) => { if (!response.ok) setError("Could not save your warning time."); })
        .catch(() => setError("Could not save your warning time."))
        .finally(() => { editing.current = false; });
    }, 600);
  }

  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const setRiding: SetRiding = (ride, riding) => {
    if (preview) { setError("Preview only. Nothing is saved."); return; }
    const key = rideKey(ride);
    setBusy((current) => new Set(current).add(key));
    void fetch(`/api/families/rides/${ride.tripId}/riders/${ride.riderId}`, {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ riding })
    }).then(async (response) => {
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        setError(body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "That didn't save. Try again.");
      } else setError("");
      await load();
    }).catch(() => setError("No connection, so that didn't save. Try again."))
      .finally(() => setBusy((current) => { const next = new Set(current); next.delete(key); return next; }));
  };

  // Today's buses get full cards; later days are a list where kids can be marked off ahead of time.
  const all = groupRides(rides);
  const today = new Date(now);
  const groups = all.filter((group) => group.ride.tripStatus === "active" || sameDay(new Date(group.ride.departureAt), today));
  const later = all.filter((group) => !groups.includes(group));
  const split = splitMessages(messages, fresh, now);

  return <main className="field">
    <header className="ftop">
      <div className="wm">BUSSIN<span>Family · {tenant?.name ?? ""}</span></div>
      {!preview && <button type="button" onClick={() => void logout()}>Sign out</button>}
    </header>
    <h1 className="fh1">Your bus</h1>
    {error && <p className="ferror" role="alert">{error}</p>}
    {split.top.length > 0 && <section className="fmsgs" aria-label="Messages">
      {split.top.map((item) => <MessageItem key={item.id} item={item} isNew={fresh.has(item.id)} />)}</section>}
    {loading ? <p className="fsub">Loading your bus…</p>
      : groups.length === 0 ? <section className="fcard"><div className="inner">
        <p className="fline">No bus today</p><p className="fsub">{later.length ? "The next bus is listed below." : "There is no running or upcoming trip for your riders. This page updates by itself."}</p></div></section>
        : groups.map((group) => <Card key={group.key} group={group} now={now} buffer={buffer} setBuffer={setBuffer} busy={busy} setRiding={setRiding} />)}
    <BusAlerts preview={!!preview} />
    {!loading && <ComingUp groups={later} busy={busy} setRiding={setRiding} />}
    <EarlierMessages messages={split.earlier} />
  </main>;
}

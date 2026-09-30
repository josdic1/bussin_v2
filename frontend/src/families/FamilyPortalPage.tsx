import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { familyPortalResponseSchema, type FamilyPortalRide } from "@bussin/shared";
import { useAuth } from "../auth/AuthProvider";

const clock = (value: string | number) => new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** Siblings on the same trip and stop share one card. */
type RideGroup = { key: string; riders: string[]; ride: FamilyPortalRide };

function groupRides(rides: FamilyPortalRide[]): RideGroup[] {
  const groups = new Map<string, RideGroup>();
  for (const ride of rides) {
    const key = `${ride.tripId}:${ride.stop.id}`;
    const group = groups.get(key);
    if (group) group.riders.push(ride.riderName);
    else groups.set(key, { key, riders: [ride.riderName], ride });
  }
  return [...groups.values()];
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

function Card({ group, now, buffer, setBuffer }: { group: RideGroup; now: number; buffer: number; setBuffer: (minutes: number) => void }) {
  const { ride, riders } = group;
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
  if (ride.tripStatus === "planned") {
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
    {ride.tripStatus === "active" && <MiniMap ride={ride} />}
    <div className="inner">
      <div className="kids">{riders.map((name) => <span key={name} className="kid"><span>{initials(name)}</span>{name}</span>)}</div>
      <p className="fline">{ride.tripStatus === "planned" ? `${ride.busLabel} · ${ride.routeName}`
        : picked ? (am ? "Heading to school" : "Home stop reached")
          : away === 0 ? "Your stop is next" : away !== null ? `${away} ${away === 1 ? "stop" : "stops"} away` : ride.routeName}</p>
      <p className="fsub">{ride.tripStatus === "active" && ride.location ? `Live · updated ${clock(ride.location.observedAt)}` : ride.routeName}</p>
      {ride.tripStatus === "active" && myIndex >= 0 && <div className="away" aria-hidden="true">
        {ride.routeStops.map((stop) => <i key={stop.id} className={stop.id === ride.stop.id ? "me" : stop.passed ? "on" : ""} />)}</div>}
    </div>
    <dl className="ffacts">
      <div><dt>Your stop</dt><dd>{ride.stop.label}</dd></div>
      <div><dt>Bus</dt><dd>{ride.busLabel} · {ride.servicePeriod}</dd></div>
    </dl>
    {am && !picked && <div className="buf">
      <div><b>Warn me before the bus</b><small>Your walk to the stop</small></div>
      <div className="step">
        <button type="button" aria-label="Less time" onClick={() => setBuffer(Math.max(0, buffer - 1))}>&minus;</button>
        <span>{buffer} min</span>
        <button type="button" aria-label="More time" onClick={() => setBuffer(Math.min(60, buffer + 1))}>+</button>
      </div>
    </div>}
  </section>;
}

export function FamilyPortalPage() {
  const { logout, tenant } = useAuth();
  const [rides, setRides] = useState<FamilyPortalRide[]>([]);
  const [buffer, setBufferState] = useState(5);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const saveTimer = useRef<number | undefined>(undefined);
  const editing = useRef(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch("/api/families/portal", { credentials: "same-origin", signal });
      if (!response.ok) throw new Error("Could not load your bus information.");
      const body = familyPortalResponseSchema.parse(await response.json());
      if (signal?.aborted) return;
      setRides(body.rides);
      if (!editing.current) setBufferState(body.leaveBufferMinutes);
      setError("");
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : "Could not load your bus information.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const tick = () => { if (document.visibilityState === "visible") void load(controller.signal); };
    const timer = window.setInterval(tick, 15_000);
    document.addEventListener("visibilitychange", tick);
    return () => { controller.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
  }, [load]);

  function setBuffer(minutes: number) {
    setBufferState(minutes);
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

  const groups = groupRides(rides);

  return <main className="field">
    <header className="ftop">
      <div className="wm">BUSSIN<span>Family · {tenant?.name ?? ""}</span></div>
      <button type="button" onClick={() => void logout()}>Sign out</button>
    </header>
    <h1 className="fh1">Your bus</h1>
    {error && <p className="ferror" role="alert">{error}</p>}
    {loading ? <p className="fsub">Loading your bus…</p>
      : groups.length === 0 ? <section className="fcard"><div className="inner">
        <p className="fline">No bus today</p><p className="fsub">There is no running or upcoming trip for your riders. This page updates by itself.</p></div></section>
        : groups.map((group) => <Card key={group.key} group={group} now={now} buffer={buffer} setBuffer={setBuffer} />)}
  </main>;
}

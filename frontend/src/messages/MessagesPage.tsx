import { useEffect, useMemo, useState } from "react";
import {
  boardResponseSchema, MESSAGE_MAX_LENGTH, messageReachSchema, rosterResponseSchema, routesResponseSchema,
  sentMessagesResponseSchema, type BoardTrip, type MessageAudience, type MessageReach, type MessageTarget,
  type Rider, type SentMessage
} from "@bussin/shared";
import { getJson, message, send } from "../ops/api";
import { dayBounds, dayName, localDate, plural, time } from "../ops/format";
import { useOps } from "../ops/OpsShell";
import { Confirm, ErrorNote, Head, NoMatch, Seg } from "../ops/ui";
import { usePolling } from "../ops/useBoard";

const AUDIENCES: [MessageAudience, string][] = [["all", "Everyone"], ["route", "A route"], ["trip", "A trip"], ["rider", "One child"]];

const QUICK = [
  "The bus is running about 10 minutes late.",
  "The bus is running about 20 minutes late.",
  "The bus has a mechanical problem. A replacement is on the way.",
  "No bus service today."
];

function when(value: string) {
  const day = localDate(new Date(value));
  const name = dayName(day);
  const label = name === "Today" || name === "Yesterday" ? name
    : new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${label} ${time(value)}`;
}

function tripLabel(trip: BoardTrip) {
  return `${dayName(localDate(new Date(trip.departureAt)))} ${time(trip.departureAt)} · ${trip.busLabel} · ${trip.routeName}`;
}

type Choice = { audience: MessageAudience; routeFamilyId: string; tripId: string; riderId: string };

function targetOf(choice: Choice): MessageTarget | null {
  if (choice.audience === "all") return { audience: "all" };
  if (choice.audience === "route") return choice.routeFamilyId ? { audience: "route", routeFamilyId: choice.routeFamilyId } : null;
  if (choice.audience === "trip") return choice.tripId ? { audience: "trip", tripId: choice.tripId } : null;
  return choice.riderId ? { audience: "rider", riderId: choice.riderId } : null;
}

function ReachLine({ reach, loading }: { reach: MessageReach | null; loading: boolean }) {
  if (!reach) return <p className="msg-reach">{loading ? "Counting…" : "Choose who it is for."}</p>;
  if (!reach.guardians) return <p className="msg-reach bad">No guardians linked to {reach.label}.</p>;
  const noLogin = reach.guardians - reach.withLogin;
  return <p className={`msg-reach${reach.withLogin ? "" : " bad"}`}>
    <b>{reach.withLogin} of {reach.guardians}</b> can read it{noLogin ? ` · ${noLogin} ${plural(noLogin, "has", "have")} no login yet` : ""}
  </p>;
}

function Compose({ onSent }: { onSent: () => void }) {
  const { toast } = useOps();
  const [choice, setChoice] = useState<Choice>({ audience: "all", routeFamilyId: "", tripId: "", riderId: "" });
  const [body, setBody] = useState("");
  const [routes, setRoutes] = useState<{ id: string; name: string }[]>([]);
  const [trips, setTrips] = useState<BoardTrip[]>([]);
  const [riders, setRiders] = useState<Rider[]>([]);
  const [riderQuery, setRiderQuery] = useState("");
  const [reach, setReach] = useState<MessageReach | null>(null);
  const [reachLoading, setReachLoading] = useState(false);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const today = localDate(new Date());
    Promise.all([
      getJson("/api/routes", routesResponseSchema, controller.signal),
      getJson(`/api/dispatch/board?${new URLSearchParams(dayBounds(today, 2))}`, boardResponseSchema, controller.signal),
      getJson("/api/families/roster", rosterResponseSchema, controller.signal)
    ]).then(([routeData, board, roster]) => {
      const families = new Map<string, string>();
      for (const route of routeData.routes) families.set(route.routeFamilyId, route.routeFamilyName);
      setRoutes([...families].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)));
      setTrips(board.trips.filter((trip) => trip.status !== "cancelled")
        .sort((a, b) => Date.parse(a.departureAt) - Date.parse(b.departureAt)));
      setRiders(roster.riders);
    }).catch((cause) => { if (!controller.signal.aborted) setError(message(cause, "Could not load routes, trips and riders.")); });
    return () => controller.abort();
  }, []);

  const target = targetOf(choice);
  const targetKey = JSON.stringify(target);

  useEffect(() => {
    setReach(null);
    if (!target) return;
    const controller = new AbortController();
    setReachLoading(true);
    const timer = window.setTimeout(() => {
      fetch("/api/messages/preview", {
        method: "POST", credentials: "same-origin", signal: controller.signal,
        headers: { "Content-Type": "application/json" }, body: targetKey
      }).then(async (response) => {
        if (!response.ok) throw new Error("Could not count who gets this.");
        setReach(messageReachSchema.parse(await response.json()));
      }).catch((cause) => { if (!controller.signal.aborted) setError(message(cause, "Could not count who gets this.")); })
        .finally(() => { if (!controller.signal.aborted) setReachLoading(false); });
    }, 200);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [targetKey]);

  const needle = riderQuery.trim().toLowerCase();
  const riderMatches = useMemo(() => needle
    ? riders.filter((rider) => `${rider.givenName} ${rider.familyName}`.toLowerCase().includes(needle)).slice(0, 6)
    : [], [riders, needle]);
  const chosenRider = riders.find((rider) => rider.id === choice.riderId);

  async function submit() {
    if (!target || !body.trim()) return;
    setSending(true);
    setError("");
    try {
      await send("POST", "/api/messages", { target, body: body.trim() }, "Could not send the message.");
      toast(`Sent to ${reach?.guardians ?? ""} ${plural(reach?.guardians ?? 0, "guardian", "guardians")}.`);
      setBody("");
      onSent();
    } catch (cause) {
      setError(message(cause, "Could not send the message."));
    } finally { setSending(false); }
  }

  const ready = !!target && !!body.trim() && !!reach?.guardians && !sending;
  const pick = (next: Partial<Choice>) => { setChoice((current) => ({ ...current, ...next })); setError(""); };

  return <section className="panel msg-compose">
    <div className="panel-head"><h3>New message</h3></div>
    <div className="msg-body">
      <div className="msg-field"><b className="lt">Send to</b>
        <Seg label="Send to" value={choice.audience} onChange={(audience) => pick({ audience })} items={AUDIENCES} /></div>

      {choice.audience === "route" && <label className="msg-field"><b className="lt">Route</b>
        <select value={choice.routeFamilyId} onChange={(event) => pick({ routeFamilyId: event.target.value })}>
          <option value="">Choose a route</option>
          {routes.map((route) => <option key={route.id} value={route.id}>{route.name} (AM and PM riders)</option>)}
        </select></label>}

      {choice.audience === "trip" && <label className="msg-field"><b className="lt">Trip</b>
        <select value={choice.tripId} onChange={(event) => pick({ tripId: event.target.value })}>
          <option value="">{trips.length ? "Choose a trip" : "No trips today or tomorrow"}</option>
          {trips.map((trip) => <option key={trip.id} value={trip.id}>{tripLabel(trip)}{trip.status === "active" ? " (running)" : trip.status === "completed" ? " (done)" : ""}</option>)}
        </select></label>}

      {choice.audience === "rider" && <div className="msg-field"><b className="lt">Child</b>
        {chosenRider
          ? <div className="gchips"><span className="gchip">{chosenRider.givenName} {chosenRider.familyName}
            <button type="button" aria-label="Choose a different child" onClick={() => pick({ riderId: "" })}>&times;</button></span></div>
          : <>
            <input type="search" value={riderQuery} placeholder="Search by child's name" autoComplete="off"
              onChange={(event) => setRiderQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && riderMatches[0]) { event.preventDefault(); pick({ riderId: riderMatches[0].id }); setRiderQuery(""); } }} />
            {needle && <div className="gres">
              {riderMatches.map((rider) => <button key={rider.id} type="button" onClick={() => { pick({ riderId: rider.id }); setRiderQuery(""); }}>
                <strong>{rider.givenName} {rider.familyName}</strong>
                <small>{rider.guardians.map((guardian) => guardian.name).join(", ") || "No guardians linked"}</small></button>)}
              {!riderMatches.length && <span className="gres-h">No child matches &ldquo;{riderQuery.trim()}&rdquo;</span>}
            </div>}
          </>}
      </div>}

      <label className="msg-field"><b className="lt">Message</b>
        <textarea value={body} maxLength={MESSAGE_MAX_LENGTH} rows={5} placeholder="Type what families should know"
          onChange={(event) => setBody(event.target.value)} /></label>
      <div className="msg-row">
        <select className="msg-starter" value="" aria-label="Use a starter message"
          onChange={(event) => { if (event.target.value) setBody(event.target.value); }}>
          <option value="">Use a starter…</option>
          {QUICK.map((text) => <option key={text} value={text}>{text}</option>)}
        </select>
        <span className="msg-count">{body.length}/{MESSAGE_MAX_LENGTH}</span>
      </div>
      <ErrorNote text={error} />
      <div className="msg-foot">
        <ReachLine reach={reach} loading={reachLoading} />
        <button type="button" className="btn btn-primary msg-send" disabled={!ready} onClick={() => void submit()}>
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  </section>;
}

function MessageCard({ item, onChanged }: { item: SentMessage; onChanged: () => void }) {
  const { toast } = useOps();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function retract() {
    setBusy(true);
    setError("");
    try {
      await send("POST", `/api/messages/${item.id}/retract`, undefined, "Could not remove the message.");
      toast("Message removed. Families no longer see it.");
      setConfirming(false);
      onChanged();
    } catch (cause) { setError(message(cause, "Could not remove the message.")); } finally { setBusy(false); }
  }

  const noLogin = item.guardians - item.withLogin;
  return <article className={`msg-card${item.retractedAt ? " gone" : ""}`}>
    <div className="msg-top">
      <span className="msg-to">{item.audienceLabel}</span>
      <span className="msg-when">{when(item.sentAt)}</span>
    </div>
    <p className="msg-text">{item.body}</p>
    {item.retractedAt
      ? <p className="msg-meta">Removed {when(item.retractedAt)}</p>
      : <div className="msg-meta">
        <span title={noLogin ? `${noLogin} more ${plural(noLogin, "guardian has", "guardians have")} no login yet` : undefined}>
          Read {item.readBy}/{item.withLogin}{noLogin ? ` · ${noLogin} no login` : ""} · {item.sentBy}</span>
        {!confirming && <button type="button" className="msg-remove" onClick={() => setConfirming(true)}>Remove</button>}
      </div>}
    {confirming && <Confirm text="Remove this message? Families stop seeing it."
      yes={busy ? "Removing…" : "Remove"} busy={busy} danger onYes={() => void retract()} onNo={() => setConfirming(false)} />}
    <ErrorNote text={error} />
  </article>;
}

export function MessagesPage() {
  const { mode } = useOps();
  const [messages, setMessages] = useState<SentMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const reload = () => setRevision((value) => value + 1);

  usePolling(async (signal) => {
    try {
      const data = await getJson("/api/messages", sentMessagesResponseSchema, signal);
      setMessages(data.messages);
      setError("");
    } catch (cause) {
      if (!signal.aborted) setError(message(cause, "Could not load messages."));
    } finally { if (!signal.aborted) setLoading(false); }
  }, 30_000, [revision]);

  const [showRemoved, setShowRemoved] = useState(false);
  const removed = messages.filter((item) => item.retractedAt).length;
  const shown = showRemoved ? messages : messages.filter((item) => !item.retractedAt);
  const stream = <section className="msg-stream">
    <div className="sec-h"><h2>Sent</h2>{removed > 0 && <button type="button" className="linkish"
      onClick={() => setShowRemoved(!showRemoved)}>{showRemoved ? "Hide removed" : `Show removed (${removed})`}</button>}</div>
    <ErrorNote text={error} />
    {loading ? <p className="hint">Loading messages…</p>
      : shown.length ? shown.map((item) => <MessageCard key={item.id} item={item} onChanged={reload} />)
        : <NoMatch>No messages sent yet.</NoMatch>}
  </section>;

  return <>
    <Head eyebrow="Families" title="Messages" />
    <div className={mode === "desktop" ? "msg-grid" : "msg-stack"}>
      <Compose onSent={reload} />
      {stream}
    </div>
  </>;
}

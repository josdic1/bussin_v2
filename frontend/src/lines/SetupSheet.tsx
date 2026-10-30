import { useEffect, useState, type CSSProperties } from "react";
import { Link } from "react-router";
import {
  linesResponseSchema, rosterResponseSchema, timeLabel, weekdaysLabel,
  type Line, type LineDirection, type Rider, type TripSchedule
} from "@bussin/shared";
import { useAuth } from "../auth/AuthProvider";
import { getJson, message } from "../ops/api";
import { dateLabel } from "../ops/format";
import { ErrorNote } from "../ops/ui";
import "./sheet.css";

/*
 * The setup sheet: one printed page per bus, for the first morning and for any morning
 * a phone dies. Hand one to each lead, tape one up in the office. Everything on it comes
 * from Lines, Team and Kids, so fixing a mistake means fixing it there and printing again.
 */

const current = (direction: LineDirection | null): TripSchedule | null =>
  direction?.schedules.find((schedule) => !schedule.stoppedAt) ?? null;

function Run({ label, direction }: { label: string; direction: LineDirection | null }) {
  const schedule = current(direction);
  const from = direction?.stops[0]?.label, to = direction?.stops.at(-1)?.label;
  return <div className="ss-run">
    <small>{label}</small>
    <b>{schedule ? timeLabel(schedule.departTime) : "Not running"}</b>
    {schedule && from && to && <span>{from} to {to}</span>}
  </div>;
}

function Person({ role, name, phone }: { role: string; name: string | null | undefined; phone?: string | null }) {
  return <div className="ss-person"><small>{role}</small><b>{name ?? "Not set"}</b><span>{phone ?? (name ? "No phone on file" : "")}</span></div>;
}

function Page({ line, kids, camp }: { line: Line; kids: Rider[] | null; camp: string }) {
  const am = current(line.am), pm = current(line.pm);
  const any = am ?? pm;
  const counselors = [...new Map([...(am?.counselors ?? []), ...(pm?.counselors ?? [])].map((c) => [c.id, c.displayName])).values()];
  const mine = kids?.filter((kid) => [kid.am, kid.pm].some((a) => a && (a.routeId === line.am?.routeId || a.routeId === line.pm?.routeId)))
    .sort((a, b) => a.familyName.localeCompare(b.familyName) || a.givenName.localeCompare(b.givenName)) ?? null;

  return <section className="ss-page" style={{ "--c": line.color } as CSSProperties}>
    <header className="ss-head">
      <div><small>{camp} · Bus setup sheet</small><h2>{line.name}</h2></div>
      <div className="ss-bus">{any?.busLabel ?? "No bus"}</div>
    </header>

    <div className="ss-grid">
      <Run label="Morning leaves" direction={line.am} />
      <Run label="Afternoon leaves" direction={line.pm} />
      <div className="ss-run"><small>Days</small><b>{any ? weekdaysLabel(any.weekdays) : "Not set"}</b>
        {any && <span>{dateLabel(any.startsOn)} to {dateLabel(any.endsOn)}</span>}</div>
    </div>

    <div className="ss-grid">
      <Person role="Lead counselor" name={any?.lead?.displayName} phone={any?.lead?.phone} />
      <Person role="Driver" name={any?.driver?.name} phone={any?.driver?.phone} />
      <div className="ss-person"><small>Counselors</small><b>{counselors.length ? counselors.join(", ") : "None"}</b></div>
    </div>

    <div className="ss-box">
      <h3>Before the first trip</h3>
      <ul className="ss-checks">
        <li>Bus phone paired: open <b>{location.host}/bus</b> on it and type the code from Buses</li>
        <li>Lead has Bussin on their home screen and can sign in</li>
        <li>Lead&rsquo;s cell number is in Team, so the office can call</li>
      </ul>
      <h3>If something goes wrong</h3>
      <ul className="ss-plain">
        <li><b>Emergency:</b> call 911 first, then the office.</li>
        <li><b>Bus phone dies:</b> keep going. The lead&rsquo;s phone tracks the bus while Bussin is open on it.</li>
        <li><b>All phones down:</b> use the list below. Check each kid on and off by hand.</li>
      </ul>
    </div>

    {mine && <div className="ss-kids">
      <h3>Kids on this bus <span>{mine.length}{line.partWeek ? ` · ${line.partWeek} part of the week` : ""}</span></h3>
      {mine.length ? <table>
        <thead><tr><th className="ss-ck">On</th><th className="ss-ck">Off</th><th>Kid</th><th>Days</th><th>Parent</th><th>Phone</th></tr></thead>
        <tbody>{mine.map((kid) => {
          const parent = kid.guardians[0];
          return <tr key={kid.id}><td className="ss-ck"><i /></td><td className="ss-ck"><i /></td>
            <td><b>{kid.familyName}, {kid.givenName}</b></td>
            <td>{kid.rideDays ? weekdaysLabel(kid.rideDays) : "Every day"}</td>
            <td>{parent?.name ?? "None listed"}</td><td>{parent?.phone ?? ""}</td></tr>;
        })}</tbody>
      </table> : <p className="ss-none">No kids on this line yet.</p>}
    </div>}
  </section>;
}

export function SetupSheet() {
  const { tenant } = useAuth();
  const [lines, setLines] = useState<Line[] | null>(null);
  const [kids, setKids] = useState<Rider[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    getJson("/api/lines", linesResponseSchema, controller.signal)
      .then((data) => setLines(data.lines.filter((line) => current(line.am) || current(line.pm))))
      .catch((cause) => { if (!controller.signal.aborted) setError(message(cause, "Could not load the lines.")); });
    // Kid lists are for admins; dispatchers get the sheet without them.
    getJson("/api/families/roster", rosterResponseSchema, controller.signal)
      .then((data) => setKids(data.riders)).catch(() => setKids(null));
    return () => controller.abort();
  }, []);

  return <div className="ss">
    <div className="ss-bar">
      <Link to="/lines" className="btn">Back to Lines</Link>
      <span>One page per bus. Hand one to each lead and keep one in the office.</span>
      <button type="button" className="btn btn-primary" disabled={!lines?.length} onClick={() => window.print()}>Print</button>
    </div>
    <ErrorNote text={error} />
    {!lines && !error && <p className="hint">Loading…</p>}
    {lines && !lines.length && <p className="hint">No line is set up to run yet. Set one up in Lines first.</p>}
    {lines?.map((line) => <Page key={line.id} line={line} kids={kids} camp={tenant?.name ?? "Bussin"} />)}
  </div>;
}

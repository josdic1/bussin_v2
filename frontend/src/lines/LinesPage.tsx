import { useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { Link } from "react-router";
import {
  busesResponseSchema, dispatchStaffResponseSchema, knownPlacesResponseSchema, LINE_COLORS, lineCreateInputSchema,
  linesResponseSchema, routesResponseSchema, tripSchedulesResponseSchema, WEEKDAY_NAMES, weekdaysLabel,
  type Line, type LineDirection, type TripSchedule
} from "@bussin/shared";
import { getJson, message, send } from "../ops/api";
import { dateLabel, localDate, shiftDay } from "../ops/format";
import { Overlay, useOps } from "../ops/OpsShell";
import { ErrorNote, Head, NoMatch } from "../ops/ui";
import { usePolling } from "../ops/useBoard";
import { parseCoordinates } from "../routes/coords";
import { ScheduleForm, type Data } from "../timetable/TimetablePage";
import "./lines.css";

/*
 * Lines: every bus line on one map. A line is a morning run and an afternoon run between
 * the same places, on one bus, on the same days, with one crew. Most camp lines are
 * shuttles (JCC and Camp, nothing in between). Click a line for its times, crew and kids.
 * Replaces the separate Routes and Timetable pages; both stay one click away.
 */

type Places = { label: string; latitude: number; longitude: number }[];
type Editing = { schedule: TripSchedule | null; preset?: Partial<TripSchedule> };

function clockLabel(hhmm: string) {
  return new Date(`2000-01-01T${hhmm}:00`).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
const letter = (name: string) => name.trim().charAt(0).toUpperCase() || "?";

/** The two ends of a line, read in the morning direction. */
function ends(line: Line) {
  if (line.am?.stops.length) return { from: line.am.stops[0]!.label, to: line.am.stops.at(-1)!.label, middle: line.am.stops.length - 2 };
  if (line.pm?.stops.length) return { from: line.pm.stops.at(-1)!.label, to: line.pm.stops[0]!.label, middle: line.pm.stops.length - 2 };
  return { from: "", to: "", middle: 0 };
}
const firstRun = (direction: LineDirection | null) => direction?.schedules[0] ?? null;

/** What's missing before this line can run tomorrow, in plain words. Empty: ready. */
function problems(line: Line) {
  const list: string[] = [];
  const am = firstRun(line.am);
  const pm = firstRun(line.pm);
  if (!am && !pm) list.push("No times yet");
  else {
    if (line.am && !am) list.push("No morning time");
    if (line.pm && !pm) list.push("No afternoon time");
  }
  if ([am, pm].some((run) => run && !run.lead)) list.push("No lead");
  if ([am, pm].some((run) => run && !run.driver)) list.push("No driver");
  if (!line.kids) list.push("No kids yet");
  return list;
}

export function LinesPage() {
  const { toast } = useOps();
  const [lines, setLines] = useState<Line[] | null>(null);
  const [data, setData] = useState<Data | null>(null);
  const [places, setPlaces] = useState<Places>([]);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [creating, setCreating] = useState(false);

  usePolling(async (signal) => {
    try {
      const [lineData, schedules, buses, routes, staff, placeData] = await Promise.all([
        getJson("/api/lines", linesResponseSchema, signal),
        getJson("/api/schedules", tripSchedulesResponseSchema, signal),
        getJson("/api/fleet/buses", busesResponseSchema, signal),
        getJson("/api/routes", routesResponseSchema, signal),
        getJson("/api/dispatch/staff", dispatchStaffResponseSchema, signal),
        getJson("/api/lines/places", knownPlacesResponseSchema, signal)
      ]);
      if (signal.aborted) return;
      setLines(lineData.lines);
      setData({ schedules: schedules.schedules, buses: buses.buses, routes: routes.routes, staff: staff.staff, drivers: staff.drivers });
      setPlaces(placeData.places);
      setError("");
    } catch (cause) {
      if (!signal.aborted) setError(message(cause, "Could not load the lines."));
    }
  }, 60_000, [revision]);

  const selected = lines?.find((line) => line.id === selectedId) ?? lines?.[0] ?? null;
  const allEnds = useMemo(() => (lines ?? []).map(ends), [lines]);
  const shared = allEnds.length > 0 && allEnds.every((end) => end.from === allEnds[0]!.from && end.to === allEnds[0]!.to) ? allEnds[0]! : null;
  const days = useMemo(() => {
    const runs = (lines ?? []).flatMap((line) => [firstRun(line.am), firstRun(line.pm)]).filter((run): run is TripSchedule => !!run);
    if (!runs.length) return null;
    const first = runs.map((run) => run.startsOn).sort()[0]!;
    const last = runs.map((run) => run.endsOn).sort().at(-1)!;
    const allSame = runs.every((run) => run.weekdays.join() === runs[0]!.weekdays.join());
    return `${allSame ? weekdaysLabel(runs[0]!.weekdays) : "Different days"} · ${dateLabel(first)} to ${dateLabel(last)}`;
  }, [lines]);
  const done = (note: string) => { setEditing(null); setCreating(false); toast(note); setRevision((value) => value + 1); };

  return <div className="ln">
    <Head eyebrow="Planning" title="Lines" sub="Every bus line, both ways, all week."
      actions={<button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>+ New line</button>} />
    <ErrorNote text={error} />
    {!lines && !error && <p className="hint">Loading the lines…</p>}
    {lines && !lines.length && <NoMatch>No lines yet. A line is one bus going between two places in the morning and back in the afternoon. Add the first one.</NoMatch>}

    {lines && lines.length > 0 && <div className="ln-wrap">
      <section className="ln-map" aria-label="Line map">
        <div className="ln-map-head"><h2>Line map</h2>{days && <span>{days}</span>}</div>
        <div className={`ln-grid${shared ? "" : " own"}`}>
          {shared && <div className="ln-end"><b>{shared.from}</b><small>Morning: get on</small></div>}
          <div className="ln-rows">
            {lines.map((line) => {
              const end = ends(line);
              const am = firstRun(line.am);
              const pm = firstRun(line.pm);
              const bus = am?.busLabel ?? pm?.busLabel ?? null;
              const issues = problems(line);
              const on = selected?.id === line.id;
              return <button key={line.id} type="button" className={`ln-row${on ? " on" : ""}`} aria-pressed={on}
                style={{ "--c": line.color } as CSSProperties} onClick={() => setSelectedId(line.id)}>
                <span className="ln-top">
                  <span className="ln-chip">{letter(line.name)}</span><b>{line.name}</b>
                  <small>{bus ?? "No bus"} · {line.kids} {line.kids === 1 ? "kid" : "kids"}</small>
                  {issues.length > 0 && <em>{issues[0]}</em>}
                </span>
                {!shared && <span className="ln-own"><span>{end.from}</span><span>{end.to}</span></span>}
                <span className="ln-track" aria-hidden="true"><i className="dot l" /><i className="bar" />
                  {Array.from({ length: Math.max(0, end.middle) }, (_, index) =>
                    <i key={index} className="dot m" style={{ left: `${((index + 1) / (end.middle + 1)) * 100}%` }} />)}
                  <i className="dot r" /></span>
                <span className="ln-times">
                  <span>{am ? `${clockLabel(am.departTime)} morning` : line.am ? "No morning time" : "No morning run"}</span>
                  <span>{pm ? `${clockLabel(pm.departTime)} afternoon` : line.pm ? "No afternoon time" : "No afternoon run"}</span>
                </span>
              </button>;
            })}
          </div>
          {shared && <div className="ln-end r"><b>{shared.to}</b><small>Morning: get off</small></div>}
        </div>
        <p className="ln-foot">{shared && allEnds.every((end) => end.middle === 0)
          ? `Shuttle lines: everyone gets on at ${shared.from} and off at ${shared.to} in the morning, and the other way in the afternoon.`
          : "Dots on a line are stops between the two ends."}</p>
      </section>

      {selected && data && <LinePanel line={selected} data={data} onEdit={setEditing} onColor={async (color) => {
        try { await send("PATCH", `/api/lines/${selected.id}/color`, { color }, "Could not change the color."); setRevision((value) => value + 1); }
        catch (cause) { toast(message(cause, "Could not change the color.")); }
      }} />}
    </div>}

    {editing && data && <Overlay onClose={() => setEditing(null)}>
      <ScheduleForm data={data} schedule={editing.schedule} preset={editing.preset} onDone={done} />
    </Overlay>}
    {creating && data && <Overlay onClose={() => setCreating(false)}>
      <NewLineForm data={data} places={places} used={(lines ?? []).map((line) => line.color)} onDone={done} />
    </Overlay>}
  </div>;
}

function LinePanel({ line, data, onEdit, onColor }: {
  line: Line; data: Data; onEdit: (editing: Editing) => void; onColor: (color: string) => void;
}) {
  const am = firstRun(line.am);
  const pm = firstRun(line.pm);
  const crewFrom = am ?? pm;
  const end = ends(line);
  const issues = problems(line);
  const presetFrom = (other: TripSchedule | null, direction: LineDirection): Partial<TripSchedule> => ({
    routeId: direction.routeId, busId: other?.busId, weekdays: other?.weekdays, startsOn: other?.startsOn, endsOn: other?.endsOn,
    lead: other?.lead ?? null, counselors: other?.counselors ?? [], driver: other?.driver ?? null
  });
  const run = (label: string, direction: LineDirection | null, schedule: TripSchedule | null, other: TripSchedule | null, from: string, to: string) =>
    <div className="ln-run">
      <span className="lt">{label}</span>
      {schedule ? <><b>{clockLabel(schedule.departTime)}</b><span>{from} to {to}{schedule.weekdays.join() !== other?.weekdays.join() && other ? ` · ${weekdaysLabel(schedule.weekdays)}` : ""}</span>
        <button type="button" className="btn sm" onClick={() => onEdit({ schedule })}>Edit</button></>
        : direction ? <><span className="dim">No time yet</span><span>{from} to {to}</span>
          <button type="button" className="btn sm btn-primary" onClick={() => onEdit({ schedule: null, preset: presetFrom(other, direction) })}>Add time</button></>
          : <><span className="dim">No {label.toLowerCase()} run</span><span /><span /></>}
    </div>;

  return <aside className="ln-panel" style={{ "--c": line.color } as CSSProperties}>
    <div className="ln-panel-head">
      <span className="ln-chip big">{letter(line.name)}</span>
      <div><b>{line.name}</b><small>{end.from} and {end.to}{end.middle > 0 ? ` · ${end.middle} stops between` : " · shuttle"}</small></div>
    </div>
    {issues.length > 0 && <p className="ln-issues">{issues.join(" · ")}</p>}
    {run("Morning", line.am, am, pm, end.from, end.to)}
    {run("Afternoon", line.pm, pm, am, end.to, end.from)}
    <dl className="ln-facts">
      <div><dt>Days</dt><dd>{crewFrom ? weekdaysLabel(crewFrom.weekdays) : "—"}</dd></div>
      <div><dt>Season</dt><dd>{crewFrom ? `${dateLabel(crewFrom.startsOn)} to ${dateLabel(crewFrom.endsOn)}` : "—"}</dd></div>
      <div><dt>Bus</dt><dd>{crewFrom?.busLabel ?? "—"}</dd></div>
      <div><dt>Driver</dt><dd>{crewFrom?.driver?.name ?? <span className="bad">None</span>}</dd></div>
      <div><dt>Lead</dt><dd>{crewFrom?.lead?.displayName ?? <span className="bad">None</span>}</dd></div>
      <div><dt>Counselors</dt><dd>{crewFrom?.counselors.length ? crewFrom.counselors.map((c) => c.displayName).join(", ") : "None"}</dd></div>
      <div><dt>Kids</dt><dd>{line.kids}{line.partWeek ? ` · ${line.partWeek} part of the week` : ""}</dd></div>
    </dl>
    <div className="ln-colors" role="group" aria-label="Line color">{LINE_COLORS.map((color) =>
      <button key={color} type="button" aria-label={`Color ${color}`} aria-pressed={color === line.color}
        className={color === line.color ? "on" : ""} style={{ background: color }} onClick={() => onColor(color)} />)}</div>
    <div className="ln-links">
      <Link to="/families">Kids</Link>
      <Link to="/routes">Edit stops on the map</Link>
      <Link to="/timetable">All repeating trips</Link>
    </div>
    {data.schedules.length === 0 && <p className="hint">Times build the real trips two weeks ahead. Change one day in Dispatch.</p>}
  </aside>;
}

function PlacePicker({ id, label, places, value, onChange }: {
  id: string; label: string; places: Places;
  value: { pick: string; name: string; coords: string }; onChange: (next: { pick: string; name: string; coords: string }) => void;
}) {
  return <div className="ctl-row">
    <label htmlFor={id}>{label}</label>
    <select id={id} value={value.pick} onChange={(event) => onChange({ ...value, pick: event.target.value })}>
      <option value="">Choose a place</option>
      {places.map((place) => <option key={place.label} value={place.label}>{place.label}</option>)}
      <option value="+new">New place…</option>
    </select>
    {value.pick === "+new" && <div className="rf2">
      <input aria-label={`${label}: name`} placeholder="Name, e.g. JCC" value={value.name} maxLength={120}
        onChange={(event) => onChange({ ...value, name: event.target.value })} />
      <input aria-label={`${label}: coordinates`} placeholder="Coordinates, e.g. 40.79, -74.26" value={value.coords}
        onChange={(event) => onChange({ ...value, coords: event.target.value })} />
    </div>}
  </div>;
}

function NewLineForm({ data, places, used, onDone }: { data: Data; places: Places; used: string[]; onDone: (note: string) => void }) {
  const today = localDate(new Date());
  const [name, setName] = useState("");
  const [color, setColor] = useState(() => LINE_COLORS.find((c) => !used.includes(c)) ?? LINE_COLORS[0]);
  const [from, setFrom] = useState({ pick: "", name: "", coords: "" });
  const [to, setTo] = useState({ pick: "", name: "", coords: "" });
  const [busId, setBusId] = useState("");
  const [morningTime, setMorningTime] = useState("08:00");
  const [afternoonTime, setAfternoonTime] = useState("15:30");
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [startsOn, setStartsOn] = useState(today);
  const [endsOn, setEndsOn] = useState(shiftDay(today, 55));
  const [leadId, setLeadId] = useState("");
  const [driverId, setDriverId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [skipped, setSkipped] = useState<{ note: string; list: { day: string; reason: string }[] } | null>(null);

  const place = (value: typeof from) => {
    if (value.pick === "+new") {
      const point = parseCoordinates(value.coords);
      return point ? { label: value.name.trim(), ...point } : null;
    }
    return places.find((p) => p.label === value.pick) ?? null;
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    const a = place(from);
    const b = place(to);
    if (!a || !b) { setError("Pick both places. A new place needs a name and coordinates."); return; }
    const parsed = lineCreateInputSchema.safeParse({
      name, color, from: a, to: b, busId, morningTime: morningTime || null, afternoonTime: afternoonTime || null,
      weekdays, startsOn, endsOn, crew: { leadId: leadId || null, counselorIds: [], driverId: driverId || null }
    });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? "Check the form."); return; }
    setSaving(true); setError("");
    try {
      const body = await send("POST", "/api/lines", parsed.data, "Could not add the line.") as { built: number; skipped: { day: string; reason: string }[] };
      const note = `${parsed.data.name} added. ${body.built} ${body.built === 1 ? "trip" : "trips"} planned.`;
      if (body.skipped.length) setSkipped({ note, list: body.skipped }); else onDone(note);
    } catch (cause) {
      setError(message(cause, "Could not add the line."));
    } finally {
      setSaving(false);
    }
  }

  if (skipped) return <div className="tt-result">
    <p className="eyebrow">Lines</p><h2 className="dt">{skipped.note}</h2>
    <p>Some days weren&rsquo;t planned:</p>
    <ul>{skipped.list.map((skip) => <li key={`${skip.day}-${skip.reason}`}><b>{dateLabel(skip.day)}</b> {skip.reason}</li>)}</ul>
    <button type="button" className="btn btn-primary" onClick={() => onDone(skipped.note)}>Done</button>
  </div>;

  return <form className="planf ln-form" onSubmit={(event) => void submit(event)} noValidate>
    <p className="eyebrow">Lines</p>
    <h2 className="dt">New line</h2>
    <div className="rf2">
      <div className="ctl-row"><label htmlFor="ln-name">Name</label>
        <input id="ln-name" value={name} maxLength={60} placeholder="ALPHA" onChange={(event) => setName(event.target.value)} /></div>
      <div className="ctl-row"><span className="lt">Color</span>
        <div className="ln-colors" role="group" aria-label="Line color">{LINE_COLORS.map((c) =>
          <button key={c} type="button" aria-label={`Color ${c}`} aria-pressed={c === color} className={c === color ? "on" : ""}
            style={{ background: c }} onClick={() => setColor(c)} />)}</div></div>
    </div>
    <div className="rf2">
      <PlacePicker id="ln-from" label="Morning: get on at" places={places} value={from} onChange={setFrom} />
      <PlacePicker id="ln-to" label="Morning: get off at" places={places} value={to} onChange={setTo} />
    </div>
    <p className="hint">The afternoon runs the other way by itself. Need stops in between? Add them later in Edit stops.</p>
    <div className="rf2">
      <div className="ctl-row"><label htmlFor="ln-am">Morning leaves</label>
        <input id="ln-am" type="time" value={morningTime} onChange={(event) => setMorningTime(event.target.value)} /></div>
      <div className="ctl-row"><label htmlFor="ln-pm">Afternoon leaves</label>
        <input id="ln-pm" type="time" value={afternoonTime} onChange={(event) => setAfternoonTime(event.target.value)} /></div>
    </div>
    <div className="ctl-row"><label htmlFor="ln-bus">Bus</label>
      <select id="ln-bus" value={busId} onChange={(event) => setBusId(event.target.value)}>
        <option value="">Choose a bus</option>
        {data.buses.filter((bus) => bus.active).map((bus) => <option key={bus.id} value={bus.id}>{bus.label}</option>)}
      </select></div>
    <div className="ctl-row"><span className="lt">Runs on</span>
      <div className="daypick" role="group" aria-label="Days it runs">{WEEKDAY_NAMES.map((day, index) => {
        const on = weekdays.includes(index + 1);
        return <button key={day} type="button" aria-pressed={on} className={on ? "on" : ""}
          onClick={() => setWeekdays(on ? weekdays.filter((d) => d !== index + 1) : [...weekdays, index + 1].sort((x, y) => x - y))}>{day}</button>;
      })}</div></div>
    <div className="rf2">
      <div className="ctl-row"><label htmlFor="ln-start">First day</label>
        <input id="ln-start" type="date" value={startsOn} onChange={(event) => setStartsOn(event.target.value)} /></div>
      <div className="ctl-row"><label htmlFor="ln-end">Last day</label>
        <input id="ln-end" type="date" value={endsOn} min={startsOn} onChange={(event) => setEndsOn(event.target.value)} /></div>
    </div>
    <div className="rf2">
      <div className="ctl-row"><label htmlFor="ln-lead">Lead counselor</label>
        <select id="ln-lead" value={leadId} onChange={(event) => setLeadId(event.target.value)}>
          <option value="">Pick later</option>
          {data.staff.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
        </select></div>
      <div className="ctl-row"><label htmlFor="ln-driver">Driver</label>
        <select id="ln-driver" value={driverId} onChange={(event) => setDriverId(event.target.value)}>
          <option value="">Pick later</option>
          {data.drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select></div>
    </div>
    <ErrorNote text={error} />
    <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? "Adding…" : "Add line and plan trips"}</button>
  </form>;
}

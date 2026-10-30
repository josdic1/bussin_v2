import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { Link } from "react-router";
import {
  busesResponseSchema, dispatchStaffResponseSchema, knownPlacesResponseSchema, LINE_COLORS, lineCreateInputSchema,
  lineSetupInputSchema, linesResponseSchema, routesResponseSchema, timeLabel, WEEKDAY_NAMES,
  type Bus, type Line, type LineDirection, type Route, type TripDriver, type TripSchedule, type TripStaff
} from "@bussin/shared";
import { getJson, message, send } from "../ops/api";
import { TimeField } from "../ops/TimeField";
import { dateLabel, localDate, shiftDay } from "../ops/format";
import { Overlay, useOps } from "../ops/OpsShell";
import { ErrorNote, Head, NoMatch } from "../ops/ui";
import { usePolling } from "../ops/useBoard";
import { parseCoordinates } from "../routes/coords";
import "./lines.css";

/*
 * Lines: the list on the left, the line you picked on the right. A line is one bus going
 * between two places in the morning and back in the afternoon, on the same days, with the
 * same crew. Everything about it is one form. Stops are edited on the map from here.
 */

type Data = { buses: Bus[]; routes: Route[]; staff: TripStaff[]; drivers: TripDriver[] };
type Places = { label: string; latitude: number; longitude: number }[];

const letter = (name: string) => name.trim().charAt(0).toUpperCase() || "?";
const firstRun = (direction: LineDirection | null) => direction?.schedules[0] ?? null;

/** The two ends of a line, in the morning direction, and the stops between. */
function ends(line: Line) {
  if (line.am?.stops.length) return { from: line.am.stops[0]!.label, to: line.am.stops.at(-1)!.label, middle: line.am.stops.slice(1, -1).map((s) => s.label) };
  if (line.pm?.stops.length) return { from: line.pm.stops.at(-1)!.label, to: line.pm.stops[0]!.label, middle: line.pm.stops.slice(1, -1).map((s) => s.label).reverse() };
  return { from: "", to: "", middle: [] as string[] };
}

/** One short line for the list: what runs, or what's missing. */
function summary(line: Line): { text: string; warn: string | null } {
  const am = firstRun(line.am);
  const pm = firstRun(line.pm);
  const run = am ?? pm;
  if (!run) return { text: `${line.kids} ${line.kids === 1 ? "kid" : "kids"}`, warn: "Not set up" };
  // "7:45a / 3:15p": short enough to fit beside the bus name.
  const short = (hhmm: string) => timeLabel(hhmm).replace(" AM", "a").replace(" PM", "p");
  const times = [am && short(am.departTime), pm && short(pm.departTime)].filter(Boolean).join(" / ");
  const warn = !run.lead ? "No lead" : !run.driver ? "No driver" : !line.kids ? "No kids" : null;
  return { text: `${run.busLabel} · ${times} · ${line.kids} ${line.kids === 1 ? "kid" : "kids"}`, warn };
}

export function LinesPage() {
  const { toast } = useOps();
  const [lines, setLines] = useState<Line[] | null>(null);
  const [data, setData] = useState<Data | null>(null);
  const [places, setPlaces] = useState<Places>([]);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  usePolling(async (signal) => {
    try {
      const [lineData, buses, routes, staff, placeData] = await Promise.all([
        getJson("/api/lines", linesResponseSchema, signal),
        getJson("/api/fleet/buses", busesResponseSchema, signal),
        getJson("/api/routes", routesResponseSchema, signal),
        getJson("/api/dispatch/staff", dispatchStaffResponseSchema, signal),
        getJson("/api/lines/places", knownPlacesResponseSchema, signal)
      ]);
      if (signal.aborted) return;
      setLines(lineData.lines);
      setData({ buses: buses.buses, routes: routes.routes, staff: staff.staff, drivers: staff.drivers });
      setPlaces(placeData.places);
      setError("");
    } catch (cause) {
      if (!signal.aborted) setError(message(cause, "Could not load the lines."));
    }
  }, 60_000, [revision]);

  const selected = lines?.find((line) => line.id === selectedId) ?? lines?.[0] ?? null;
  const reload = () => setRevision((value) => value + 1);

  return <div className="ln">
    <Head eyebrow="Setup" title="Lines"
      actions={<><Link className="btn" to="/lines/sheet">Print setup sheet</Link>
        <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>+ New line</button></>} />
    <ErrorNote text={error} />
    {!lines && !error && <p className="hint">Loading the lines…</p>}
    {lines && !lines.length && <NoMatch>No lines yet. A line is one bus going between two places in the morning and back in the afternoon.</NoMatch>}

    {lines && lines.length > 0 && <div className="ln-split">
      <nav className="ln-list" aria-label="Lines">{lines.map((line) => {
        const info = summary(line);
        const end = ends(line);
        const on = selected?.id === line.id;
        return <button key={line.id} type="button" className={`ln-item${on ? " on" : ""}`} aria-pressed={on}
          style={{ "--c": line.color } as CSSProperties} onClick={() => setSelectedId(line.id)}>
          <span className="ln-chip">{letter(line.name)}</span>
          <span className="ln-item-text"><b>{line.name}</b><small>{end.from} and {end.to}</small><small>{info.text}</small></span>
          {info.warn && <em>{info.warn}</em>}
        </button>;
      })}</nav>
      {selected && data && <LinePanel key={selected.id} line={selected} data={data} toast={toast} onSaved={reload} />}
    </div>}

    {creating && data && <Overlay onClose={() => setCreating(false)}>
      <NewLineForm data={data} places={places} used={(lines ?? []).map((line) => line.color)}
        onDone={(note) => { setCreating(false); toast(note); reload(); }} />
    </Overlay>}
  </div>;
}

/** The picked line: its two runs drawn out, then one form for everything else. */
function LinePanel({ line, data, toast, onSaved }: { line: Line; data: Data; toast: (text: string) => void; onSaved: () => void }) {
  const today = localDate(new Date());
  const am = firstRun(line.am);
  const pm = firstRun(line.pm);
  const run: TripSchedule | null = am ?? pm;
  const end = ends(line);
  const start = () => ({
    busId: run?.busId ?? "", morning: am?.departTime ?? "", afternoon: pm?.departTime ?? "",
    weekdays: run?.weekdays ?? [1, 2, 3, 4, 5], startsOn: run?.startsOn ?? today, endsOn: run?.endsOn ?? shiftDay(today, 55),
    leadId: run?.lead?.id ?? "", driverId: run?.driver?.id ?? "", counselorIds: run?.counselors.map((c) => c.id) ?? []
  });
  const [form, setForm] = useState(start);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [skipped, setSkipped] = useState<{ day: string; reason: string }[]>([]);
  const saved = JSON.stringify(start());
  useEffect(() => { setForm(start()); setError(""); }, [saved]); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = JSON.stringify(form) !== saved;
  const set = (next: Partial<typeof form>) => setForm((current) => ({ ...current, ...next }));
  const buses = data.buses.filter((bus) => bus.active || bus.id === form.busId);

  async function save(event: FormEvent) {
    event.preventDefault();
    const parsed = lineSetupInputSchema.safeParse({
      busId: form.busId, morningTime: line.am ? form.morning || null : null, afternoonTime: line.pm ? form.afternoon || null : null,
      weekdays: form.weekdays, startsOn: form.startsOn, endsOn: form.endsOn,
      crew: { leadId: form.leadId || null, counselorIds: form.counselorIds.filter((id) => id !== form.leadId), driverId: form.driverId || null }
    });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? "Check the form."); return; }
    if (!parsed.data.morningTime && !parsed.data.afternoonTime) { setError("Give a morning time, an afternoon time, or both."); return; }
    setSaving(true); setError(""); setSkipped([]);
    try {
      const body = await send("PUT", `/api/lines/${line.id}/setup`, parsed.data, "Could not save.") as { built: number; skipped: { day: string; reason: string }[] };
      toast(`${line.name} saved. ${body.built} ${body.built === 1 ? "trip" : "trips"} planned for the next 2 weeks.`);
      setSkipped(body.skipped);
      onSaved();
    } catch (cause) {
      setError(message(cause, "Could not save."));
    } finally {
      setSaving(false);
    }
  }

  const runRow = (label: string, from: string, to: string, has: boolean, value: string, onChange: (v: string) => void, id: string) =>
    <div className="ln-run">
      <div className="ln-run-what"><span className="lt">{label}</span>
        <span className="ln-run-path"><b>{from}</b><i aria-hidden="true" /><b>{to}</b></span></div>
      {has ? <div className="ln-run-time"><label htmlFor={id}>Leaves</label>
        <TimeField id={id} value={value} onChange={onChange} placeholder={label === "Morning" ? "e.g. 8am" : "e.g. 3:30p"} /></div>
        : <span className="dim">No {label.toLowerCase()} route</span>}
    </div>;

  return <section className="ln-panel" style={{ "--c": line.color } as CSSProperties} aria-label={line.name}>
    <div className="ln-panel-head">
      <span className="ln-chip big">{letter(line.name)}</span>
      <div><b>{line.name}</b><small>{end.middle.length ? `${end.middle.length} stops between` : "Shuttle"} · {line.kids} {line.kids === 1 ? "kid" : "kids"}{line.partWeek ? `, ${line.partWeek} part of the week` : ""}</small></div>
    </div>
    <form className="ln-setup" onSubmit={(event) => void save(event)} noValidate>
      {runRow("Morning", end.from, end.to, !!line.am, form.morning, (v) => set({ morning: v }), `ln-am-${line.id}`)}
      {runRow("Afternoon", end.to, end.from, !!line.pm, form.afternoon, (v) => set({ afternoon: v }), `ln-pm-${line.id}`)}
      {end.middle.length > 0 && <p className="ln-stops">Stops between: {end.middle.join(", ")}</p>}
      <div className="ln-fields">
        <div className="ctl-row"><label htmlFor={`ln-bus-${line.id}`}>Bus</label>
          <select id={`ln-bus-${line.id}`} value={form.busId} onChange={(event) => set({ busId: event.target.value })}>
            <option value="">Choose a bus</option>
            {buses.map((bus) => <option key={bus.id} value={bus.id}>{bus.label}</option>)}
          </select></div>
        <div className="ctl-row"><span className="lt">Runs on</span>
          <div className="daypick" role="group" aria-label="Days it runs">{WEEKDAY_NAMES.map((name, index) => {
            const on = form.weekdays.includes(index + 1);
            return <button key={name} type="button" aria-pressed={on} className={on ? "on" : ""}
              onClick={() => set({ weekdays: on ? form.weekdays.filter((d) => d !== index + 1) : [...form.weekdays, index + 1].sort((a, b) => a - b) })}>{name}</button>;
          })}</div></div>
        <div className="rf2">
          <div className="ctl-row"><label htmlFor={`ln-from-${line.id}`}>First day</label>
            <input id={`ln-from-${line.id}`} type="date" value={form.startsOn} onChange={(event) => set({ startsOn: event.target.value })} /></div>
          <div className="ctl-row"><label htmlFor={`ln-to-${line.id}`}>Last day</label>
            <input id={`ln-to-${line.id}`} type="date" value={form.endsOn} min={form.startsOn} onChange={(event) => set({ endsOn: event.target.value })} /></div>
        </div>
        <div className="rf2">
          <div className="ctl-row"><label htmlFor={`ln-lead-${line.id}`}>Lead counselor</label>
            <select id={`ln-lead-${line.id}`} value={form.leadId} onChange={(event) => set({ leadId: event.target.value })}>
              <option value="">Pick later</option>
              {data.staff.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
            </select></div>
          <div className="ctl-row"><label htmlFor={`ln-drv-${line.id}`}>Driver</label>
            <select id={`ln-drv-${line.id}`} value={form.driverId} onChange={(event) => set({ driverId: event.target.value })}>
              <option value="">Pick later</option>
              {data.drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select></div>
        </div>
      </div>
      <ErrorNote text={error} />
      {skipped.length > 0 && <ul className="ln-skipped">{skipped.slice(0, 5).map((skip) =>
        <li key={`${skip.day}-${skip.reason}`}><b>{dateLabel(skip.day)}</b> not planned: {skip.reason}</li>)}</ul>}
      <div className="ln-acts">
        <button className="btn btn-primary" type="submit" disabled={saving || (!!run && !changed)}>
          {saving ? "Saving…" : run ? "Save changes" : `Set up ${line.name}`}</button>
        {changed && run && <button type="button" className="btn" onClick={() => setForm(start())}>Undo changes</button>}
      </div>
    </form>
    <div className="ln-foot">
      <div className="ln-colors" role="group" aria-label="Line color">{LINE_COLORS.map((color) =>
        <button key={color} type="button" aria-label={`Color ${color}`} aria-pressed={color === line.color} className={color === line.color ? "on" : ""}
          style={{ background: color }} onClick={() => void send("PATCH", `/api/lines/${line.id}/color`, { color }, "Could not change the color.")
            .then(onSaved).catch((cause) => toast(message(cause, "Could not change the color.")))} />)}</div>
      <span className="ln-links"><Link to="/families">Kids</Link><Link to="/routes">Edit stops on the map</Link></span>
    </div>
  </section>;
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
        <TimeField id="ln-am" value={morningTime} onChange={setMorningTime} placeholder="e.g. 8am" /></div>
      <div className="ctl-row"><label htmlFor="ln-pm">Afternoon leaves</label>
        <TimeField id="ln-pm" value={afternoonTime} onChange={setAfternoonTime} placeholder="e.g. 3:30p" /></div>
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

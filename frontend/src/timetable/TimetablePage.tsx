import { useMemo, useState, type CSSProperties, type FormEvent } from "react";
import {
  busesResponseSchema, dispatchStaffResponseSchema, routesResponseSchema, SCHEDULE_HORIZON_DAYS,
  tripScheduleInputSchema, tripScheduleSaveResponseSchema, tripSchedulesResponseSchema, WEEKDAY_NAMES,
  type Bus, type Route, type TripDriver, type TripSchedule, type TripStaff
} from "@bussin/shared";
import { getJson, message, send } from "../ops/api";
import { dateLabel, localDate, routeWithPeriod, shiftDay, time } from "../ops/format";
import { busColors, busNumber } from "../ops/fleetModel";
import { Overlay, useOps } from "../ops/OpsShell";
import { Confirm, CrewPills, ErrorNote, Head, NoMatch } from "../ops/ui";
import { usePolling } from "../ops/useBoard";
import "./timetable.css";

/*
 * Timetable: the trips that run every week. "Bus 1, ALPHA AM, 8:00, Mon to Fri, all summer,
 * with this crew." Bussin plans the real trips two weeks ahead; each one then shows up in
 * Dispatch like any trip, and can be changed or cancelled on its own.
 */

type Data = { schedules: TripSchedule[]; buses: Bus[]; routes: Route[]; staff: TripStaff[]; drivers: TripDriver[] };

/** "08:00" -> "8:00 AM". */
function clockLabel(hhmm: string) {
  return new Date(`2000-01-01T${hhmm}:00`).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** "Mon to Fri", "Mon, Wed, Fri", "Every day". */
export function daysLabel(days: number[]) {
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.length === 7) return "Every day";
  const run = sorted.every((day, index) => index === 0 || day === sorted[index - 1]! + 1);
  if (run && sorted.length >= 3) return `${WEEKDAY_NAMES[sorted[0]! - 1]} to ${WEEKDAY_NAMES[sorted.at(-1)! - 1]}`;
  return sorted.map((day) => WEEKDAY_NAMES[day - 1]).join(", ");
}

function Days({ days }: { days: number[] }) {
  return <span className="tt-days" aria-label={daysLabel(days)}>{WEEKDAY_NAMES.map((name, index) =>
    <i key={name} className={days.includes(index + 1) ? "on" : ""}>{name.slice(0, 2)}</i>)}</span>;
}

function plannedLabel(schedule: TripSchedule) {
  if (schedule.stoppedAt) return `Stopped ${dateLabel(localDate(new Date(schedule.stoppedAt)))}`;
  if (!schedule.upcoming) return "Nothing coming up";
  return `${schedule.upcoming} planned · next ${dateLabel(localDate(new Date(schedule.nextDepartureAt!)))}`;
}

export function TimetablePage() {
  const { mode, toast } = useOps();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState<TripSchedule | "new" | null>(null);

  usePolling(async (signal) => {
    try {
      const [schedules, buses, routes, staff] = await Promise.all([
        getJson("/api/schedules", tripSchedulesResponseSchema, signal),
        getJson("/api/fleet/buses", busesResponseSchema, signal),
        getJson("/api/routes", routesResponseSchema, signal),
        getJson("/api/dispatch/staff", dispatchStaffResponseSchema, signal)
      ]);
      if (signal.aborted) return;
      setData({ schedules: schedules.schedules, buses: buses.buses, routes: routes.routes, staff: staff.staff, drivers: staff.drivers });
      setError("");
    } catch (cause) {
      if (!signal.aborted) setError(message(cause, "Could not load the timetable."));
    }
  }, 60_000, [revision]);

  const colorOf = useMemo(() => busColors(data?.buses ?? []), [data?.buses]);
  const running = data?.schedules.filter((s) => !s.stoppedAt) ?? [];
  const stopped = data?.schedules.filter((s) => s.stoppedAt) ?? [];
  const add = <button type="button" className="btn btn-primary" onClick={() => setEditing("new")}>+ Repeating trip</button>;

  const table = (list: TripSchedule[], dim = false) => mode === "desktop"
    ? <table className={`tbl tt-table${dim ? " dim" : ""}`}>
      <thead><tr><th>Leaves</th><th>Bus</th><th>Route</th><th>Days</th><th>Crew</th><th>Season</th><th>Planned</th></tr></thead>
      <tbody>{list.map((s) => <tr key={s.id} data-ov="" tabIndex={0} onClick={() => setEditing(s)}
        onKeyDown={(event) => { if (event.key === "Enter") setEditing(s); }}>
        <td className="mono"><b>{clockLabel(s.departTime)}</b></td>
        <td><span className="tr-busc"><span className="av" style={{ "--c": colorOf(s.busId), "--s": "24px" } as CSSProperties}>{busNumber(s.busLabel)}</span>{s.busLabel}</span></td>
        <td>{routeWithPeriod(s.routeName, s.servicePeriod)}{!s.routeUsable && <span className="fc high">ROUTE OFF</span>}</td>
        <td><Days days={s.weekdays} /></td>
        <td><CrewPills lead={s.lead} counselors={s.counselors} driver={s.driver} /></td>
        <td>{dateLabel(s.startsOn)} to {dateLabel(s.endsOn)}</td>
        <td>{plannedLabel(s)}</td>
      </tr>)}</tbody></table>
    : <div className="surface">{list.map((s) => <button key={s.id} type="button" className="it" onClick={() => setEditing(s)}>
      <span className="av" style={{ "--c": colorOf(s.busId), "--s": "34px" } as CSSProperties}>{busNumber(s.busLabel)}</span>
      <div><div className="a"><strong>{clockLabel(s.departTime)} · {routeWithPeriod(s.routeName, s.servicePeriod)}</strong></div>
        <div className="b muted">{daysLabel(s.weekdays)} · {s.lead ? `Lead ${s.lead.displayName}` : "No lead"} · {plannedLabel(s)}</div></div>
    </button>)}</div>;

  const am = running.filter((s) => s.servicePeriod === "AM");
  const pm = running.filter((s) => s.servicePeriod === "PM");
  return <div className="tt">
    <Head eyebrow="Planning" title="Timetable"
      sub={`Trips that run every week. Bussin plans them ${SCHEDULE_HORIZON_DAYS / 7} weeks ahead, crew included. Change one day in Dispatch.`}
      actions={add} />
    <ErrorNote text={error} />
    {!data && !error && <p className="hint">Loading the timetable…</p>}
    {data && !data.schedules.length && <NoMatch>Nothing repeats yet. Add the morning and afternoon run for each bus once, and every week plans itself.</NoMatch>}
    {am.length > 0 && <><div className="sec-h"><h2>Morning</h2><span>{am.length} {am.length === 1 ? "bus" : "buses"}</span></div>{table(am)}</>}
    {pm.length > 0 && <><div className="sec-h"><h2>Afternoon</h2><span>{pm.length} {pm.length === 1 ? "bus" : "buses"}</span></div>{table(pm)}</>}
    {stopped.length > 0 && <details className="tt-stopped"><summary>Stopped ({stopped.length})</summary>{table(stopped, true)}</details>}
    {editing && data && <Overlay onClose={() => setEditing(null)}>
      <ScheduleForm data={data} schedule={editing === "new" ? null : editing}
        onDone={(note) => { setEditing(null); toast(note); setRevision((r) => r + 1); }} />
    </Overlay>}
  </div>;
}

function ScheduleForm({ data, schedule, onDone }: { data: Data; schedule: TripSchedule | null; onDone: (note: string) => void }) {
  const today = localDate(new Date());
  const [routeId, setRouteId] = useState(schedule?.routeId ?? "");
  const [busId, setBusId] = useState(schedule?.busId ?? "");
  const [weekdays, setWeekdays] = useState<number[]>(schedule?.weekdays ?? [1, 2, 3, 4, 5]);
  const [departTime, setDepartTime] = useState(schedule?.departTime ?? "");
  const [startsOn, setStartsOn] = useState(schedule?.startsOn ?? today);
  const [endsOn, setEndsOn] = useState(schedule?.endsOn ?? shiftDay(today, 55));
  const [leadId, setLeadId] = useState(schedule?.lead?.id ?? "");
  const [counselorIds, setCounselorIds] = useState<string[]>(schedule?.counselors.map((c) => c.id) ?? []);
  const [driverId, setDriverId] = useState(schedule?.driver?.id ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [stopping, setStopping] = useState(false);
  const [result, setResult] = useState<{ note: string; skipped: { day: string; reason: string }[] } | null>(null);
  const readOnly = !!schedule?.stoppedAt;

  const buses = data.buses.filter((bus) => bus.active || bus.id === busId);
  const routes = data.routes.filter((route) => (route.active && route.stops.length) || route.id === routeId);
  const nameOf = (id: string) => data.staff.find((p) => p.id === id)?.displayName
    ?? schedule?.counselors.find((c) => c.id === id)?.displayName ?? (schedule?.lead?.id === id ? schedule.lead.displayName : "Staff");
  const addable = data.staff.filter((p) => p.id !== leadId && !counselorIds.includes(p.id));
  const drivers = schedule?.driver && !data.drivers.some((d) => d.id === schedule.driver!.id) ? [schedule.driver, ...data.drivers] : data.drivers;
  const toggle = (day: number) => setWeekdays((days) => days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort((a, b) => a - b));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = tripScheduleInputSchema.safeParse({
      routeId, busId, weekdays, departTime, startsOn, endsOn,
      crew: { leadId: leadId || null, counselorIds, driverId: driverId || null }
    });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? "Check the form."); return; }
    setSaving(true); setError("");
    try {
      const body = tripScheduleSaveResponseSchema.parse(await send(schedule ? "PUT" : "POST",
        schedule ? `/api/schedules/${schedule.id}` : "/api/schedules", parsed.data, "Could not save."));
      const note = `Saved. ${body.built} ${body.built === 1 ? "trip" : "trips"} planned${body.removed ? `, ${body.removed} replaced` : ""}.`;
      if (body.skipped.length) setResult({ note, skipped: body.skipped });
      else onDone(note);
    } catch (cause) {
      setError(message(cause, "Could not save."));
    } finally {
      setSaving(false);
    }
  }

  async function stop() {
    if (!schedule) return;
    setSaving(true); setError("");
    try {
      const body = tripScheduleSaveResponseSchema.parse(await send("POST", `/api/schedules/${schedule.id}/stop`, {}, "Could not stop it."));
      onDone(`Stopped. ${body.removed} upcoming ${body.removed === 1 ? "trip" : "trips"} taken off.`);
    } catch (cause) {
      setError(message(cause, "Could not stop it."));
      setSaving(false);
    }
  }

  if (result) return <div className="tt-result">
    <p className="eyebrow">Timetable</p><h2 className="dt">{result.note}</h2>
    <p>Some days weren&rsquo;t planned:</p>
    <ul>{result.skipped.map((skip) => <li key={`${skip.day}-${skip.reason}`}><b>{dateLabel(skip.day)}</b> {skip.reason}</li>)}</ul>
    <p className="hint">Fix it in Dispatch for those days, or change the bus or time here.</p>
    <button type="button" className="btn btn-primary" onClick={() => onDone(result.note)}>Done</button>
  </div>;

  return <form className="planf tt-form" onSubmit={(event) => void submit(event)} noValidate>
    <p className="eyebrow">Timetable</p>
    <h2 className="dt">{schedule ? readOnly ? "Stopped repeating trip" : "Repeating trip" : "New repeating trip"}</h2>
    <fieldset disabled={readOnly || saving}>
      <div className="rf2">
        <div className="ctl-row"><label htmlFor="tt-bus">Bus</label>
          <select id="tt-bus" value={busId} onChange={(event) => setBusId(event.target.value)}>
            <option value="">Choose a bus</option>
            {buses.map((bus) => <option key={bus.id} value={bus.id}>{bus.label}</option>)}
          </select></div>
        <div className="ctl-row"><label htmlFor="tt-time">Leaves at</label>
          <input id="tt-time" type="time" value={departTime} onChange={(event) => setDepartTime(event.target.value)} /></div>
      </div>
      <div className="ctl-row"><label htmlFor="tt-route">Route</label>
        <select id="tt-route" value={routeId} onChange={(event) => setRouteId(event.target.value)}>
          <option value="">Choose a route</option>
          {routes.map((route) => <option key={route.id} value={route.id}>{routeWithPeriod(route.name, route.servicePeriod)} ({route.stops.length} stops)</option>)}
        </select></div>
      <div className="ctl-row"><span className="lt">Runs on</span>
        <div className="tt-pick" role="group" aria-label="Days it runs">{WEEKDAY_NAMES.map((name, index) =>
          <button key={name} type="button" aria-pressed={weekdays.includes(index + 1)} className={weekdays.includes(index + 1) ? "on" : ""}
            onClick={() => toggle(index + 1)}>{name}</button>)}</div></div>
      <div className="rf2">
        <div className="ctl-row"><label htmlFor="tt-from">First day</label>
          <input id="tt-from" type="date" value={startsOn} onChange={(event) => setStartsOn(event.target.value)} /></div>
        <div className="ctl-row"><label htmlFor="tt-to">Last day</label>
          <input id="tt-to" type="date" value={endsOn} min={startsOn} onChange={(event) => setEndsOn(event.target.value)} /></div>
      </div>

      <div className="dblock crew">
        <h3>Regular crew</h3>
        <div className="rf2">
          <div className="ctl-row"><label htmlFor="tt-lead">Lead counselor</label>
            <select id="tt-lead" value={leadId} onChange={(event) => { const next = event.target.value; setLeadId(next); setCounselorIds((c) => c.filter((id) => id !== next)); }}>
              <option value="">No lead yet</option>
              {leadId && !data.staff.some((p) => p.id === leadId) && <option value={leadId}>{nameOf(leadId)}</option>}
              {data.staff.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
            </select></div>
          <div className="ctl-row"><label htmlFor="tt-driver">Driver</label>
            <select id="tt-driver" value={driverId} onChange={(event) => setDriverId(event.target.value)}>
              <option value="">No driver set</option>
              {drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select></div>
        </div>
        <span className="lt">Other counselors <small>({counselorIds.length} of 3)</small></span>
        <div className="crew-chips">
          {counselorIds.map((id) => <span key={id} className="crew-chip">{nameOf(id)}
            {!readOnly && <button type="button" aria-label={`Remove ${nameOf(id)}`} onClick={() => setCounselorIds((c) => c.filter((x) => x !== id))}>&times;</button>}</span>)}
          {!counselorIds.length && <span className="hint">None</span>}
        </div>
        {!readOnly && counselorIds.length < 3 && <select aria-label="Add a counselor" value="" disabled={!addable.length}
          onChange={(event) => { const id = event.target.value; if (id) setCounselorIds((c) => [...c, id]); }}>
          <option value="">{addable.length ? "Add a counselor…" : "No more staff to add"}</option>
          {addable.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
        </select>}
      </div>
    </fieldset>

    {!readOnly && <p className="hint">{schedule
      ? "Saving replaces the upcoming trips nobody has touched yet. Trips with checks, edits or messages stay as they are."
      : `Plans every day it runs for the next ${SCHEDULE_HORIZON_DAYS / 7} weeks, then keeps going by itself.`}</p>}
    <ErrorNote text={error} />
    {!readOnly && <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? "Saving…" : schedule ? "Save changes" : "Save and plan trips"}</button>}
    {schedule && !readOnly && (stopping
      ? <Confirm text="Stop repeating? Upcoming trips nobody has touched are taken off. Past trips stay in Transit."
        yes="Yes, stop" danger busy={saving} onYes={() => void stop()} onNo={() => setStopping(false)} />
      : <button type="button" className="btn" disabled={saving} onClick={() => setStopping(true)}>Stop repeating</button>)}
  </form>;
}

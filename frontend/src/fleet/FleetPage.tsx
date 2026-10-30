import { useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import {
  busChecks, busDetailsInputSchema, busSchema, createBusSchema, trackersResponseSchema,
  type Bus, type BusCheck, type Tracker
} from "@bussin/shared";
import { getJson, message, send } from "../ops/api";
import { localDate, time } from "../ops/format";
import { busColors, busNumber } from "../ops/fleetModel";
import { Overlay, useOps } from "../ops/OpsShell";
import { ErrorNote, Head, NoMatch } from "../ops/ui";
import { useBoard, useNow, usePolling } from "../ops/useBoard";
import { TrackerPanel } from "./TrackerPanel";
import "./fleet.css";

/*
 * Buses: a short list you open a few times a summer. Each bus has what the office keeps on
 * file (plate, company, seats, inspection, insurance) and a GPS phone. Click a bus for its
 * sheet: a drawing of the bus with each item checked off, red where something's missing.
 */

/** Checks that make a bus "not ready". The GPS phone is optional: the lead's phone tracks the bus without it. */
const required = (check: BusCheck) => check.key !== "gps";
const worst = (checks: BusCheck[]) =>
  checks.filter(required).find((c) => c.state === "expired") ?? checks.filter(required).find((c) => c.state === "missing")
  ?? checks.filter(required).find((c) => c.state === "soon") ?? null;

export function FleetPage() {
  const { mode, isAdmin, toast } = useOps();
  const today = localDate(new Date());
  const board = useBoard(today);
  const now = useNow();
  const [trackers, setTrackers] = useState<Tracker[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  usePolling(async (signal) => {
    try { setTrackers((await getJson("/api/fleet/trackers", trackersResponseSchema, signal)).trackers); }
    catch { /* the list still works without tracker status */ }
  }, 60_000, [board.buses.length]);

  const colorOf = useMemo(() => busColors(board.buses), [board.buses]);
  const paired = (busId: string) => trackers.some((tracker) => tracker.busId === busId);
  const rows = board.buses.map((bus) => {
    const checks = busChecks(bus, today, paired(bus.id));
    const trips = board.trips.filter((trip) => trip.busId === bus.id);
    const running = trips.find((trip) => trip.status === "active");
    const next = trips.filter((trip) => trip.status === "planned" && Date.parse(trip.departureAt) > now)
      .sort((a, b) => Date.parse(a.departureAt) - Date.parse(b.departureAt))[0];
    const todayText = !bus.active ? "Out of service" : running ? "On the road" : next ? `Leaves ${time(next.departureAt)}` : trips.length ? "Done for today" : "No trips today";
    return { bus, checks, problem: worst(checks), todayText };
  }).sort((a, b) => Number(b.bus.active) - Number(a.bus.active) || a.bus.label.localeCompare(b.bus.label, undefined, { numeric: true }));
  const open = rows.find((row) => row.bus.id === openId) ?? null;
  const problems = rows.filter((row) => row.bus.active && row.problem && row.problem.state !== "soon").length;

  return <div className="fl">
    <Head eyebrow="Setup" title="Buses" sub={rows.length ? `${rows.filter((r) => r.bus.active).length} in service${problems ? ` · ${problems} missing paperwork` : ""}` : undefined}
      actions={isAdmin ? <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>+ Add bus</button> : undefined} />
    <ErrorNote text={board.error} />
    {board.loading && <p className="hint">Loading buses…</p>}
    {!board.loading && !rows.length && <NoMatch>No buses yet. Add the first one.</NoMatch>}

    {rows.length > 0 && (mode === "desktop"
      ? <table className="tbl fl-table">
        <thead><tr><th>Bus</th><th>Plate</th><th>Company</th><th>Seats</th><th>Today</th><th>On file</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.bus.id} data-ov="" tabIndex={0} className={row.bus.active ? "" : "off"}
          onClick={() => setOpenId(row.bus.id)} onKeyDown={(event) => { if (event.key === "Enter") setOpenId(row.bus.id); }}>
          <td><span className="fl-bus"><span className="av" style={{ "--c": colorOf(row.bus.id), "--s": "26px" } as CSSProperties}>{busNumber(row.bus.label)}</span><b>{row.bus.label}</b></span></td>
          <td className="mono">{row.bus.plate ?? <span className="dim">—</span>}</td>
          <td>{row.bus.company ?? <span className="dim">—</span>}</td>
          <td>{row.bus.seats ?? <span className="dim">—</span>}</td>
          <td>{row.todayText}</td>
          <td><OnFile row={row} /></td>
        </tr>)}</tbody>
      </table>
      : <div className="fl-cards">{rows.map((row) => <button key={row.bus.id} type="button" className={`fl-card${row.bus.active ? "" : " off"}`} onClick={() => setOpenId(row.bus.id)}>
        <span className="av" style={{ "--c": colorOf(row.bus.id), "--s": "34px" } as CSSProperties}>{busNumber(row.bus.label)}</span>
        <span className="fl-card-text"><b>{row.bus.label}</b><small>{[row.bus.plate, row.bus.company, row.todayText].filter(Boolean).join(" · ")}</small></span>
        <OnFile row={row} />
      </button>)}</div>)}

    {open && <Overlay onClose={() => setOpenId(null)}>
      <BusSheet bus={open.bus} checks={open.checks} color={colorOf(open.bus.id)} todayText={open.todayText} isAdmin={isAdmin} now={now}
        onSaved={(note) => { toast(note); board.reload(); }} />
    </Overlay>}
    {adding && <Overlay onClose={() => setAdding(false)}>
      <AddBusForm suggested={`Bus ${board.buses.length + 1}`} onAdded={(bus) => { setAdding(false); toast(`${bus.label} added.`); board.reload(); setOpenId(bus.id); }} />
    </Overlay>}
  </div>;
}

function OnFile({ row }: { row: { bus: Bus; problem: BusCheck | null } }) {
  if (!row.bus.active) return <span className="fl-tag off">Out of service</span>;
  if (!row.problem) return <span className="fl-tag ok">Ready</span>;
  return <span className={`fl-tag ${row.problem.state === "soon" ? "warn" : "bad"}`}>{row.problem.text}</span>;
}

/** Side view of a bus (line drawing). Each item on file is a numbered pin on the part it belongs to. */
function Blueprint({ checks, color }: { checks: BusCheck[]; color: string }) {
  const tone = (key: BusCheck["key"]) => {
    const state = checks.find((c) => c.key === key)?.state ?? "missing";
    return state === "ok" ? "ok" : state === "soon" ? "warn" : key === "gps" ? "info" : "bad";
  };
  const pins: { key: BusCheck["key"]; x: number; y: number; n: number }[] = [
    { key: "gps", x: 526, y: 50, n: 1 }, { key: "seats", x: 312, y: 54, n: 2 }, { key: "company", x: 260, y: 130, n: 3 },
    { key: "insurance", x: 335, y: 172, n: 4 }, { key: "inspection", x: 586, y: 206, n: 5 }, { key: "plate", x: 50, y: 204, n: 6 }
  ];
  return <svg className="fl-bp" viewBox="0 0 640 240" role="img" aria-label="Bus checklist drawing" style={{ "--c": color } as CSSProperties}
    fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
    <g className="bp-body">
      <path d="M40 178V58Q40 42 56 42H487Q502 42 508 57L538 119L584 126Q596 128 596 141V178H577M525 178H158M106 178H40" />
      <path d="M48 51H486" /><path d="M40 108H451" /><path d="M40 151H451" />
      <path d="M538 119V145H596" /><path d="M550 128L580 133" /><path d="M588 147V166" />
      <rect x="588" y="136" width="8" height="7" rx="1" />
      <rect x="453" y="64" width="43" height="108" rx="3" /><path d="M474.5 64V172" />
      <rect x="459" y="71" width="10" height="68" rx="2" /><rect x="480" y="71" width="10" height="68" rx="2" />
      <path d="M459 153H490M459 162H490" />
      <rect x="47" y="68" width="22" height="77" rx="2" /><rect x="52" y="75" width="12" height="28" rx="1" /><path d="M61 117H64" />
      <path d="M102 178A30 30 0 0 1 162 178" /><path d="M521 178A30 30 0 0 1 581 178" />
      <rect x="32" y="179" width="39" height="8" rx="2" /><rect x="581" y="173" width="27" height="10" rx="2" />
      <path d="M526 91H550V75" /><rect x="545" y="61" width="10" height="18" rx="3" />
      <path d="M40 60H46M40 153H46" /><path d="M562 139H576" />
    </g>
    <g className={`bp-zone ${tone("gps")}`}><path className="fillable" d="M504 65H509L531 112H504Z" /><path d="M503 119H533" /></g>
    <g className={`bp-zone ${tone("seats")}`}>{[79, 132, 185, 238, 291, 344, 397].map((x) =>
      <rect key={x} className="fillable" x={x} y="65" width="43" height="35" rx="3" />)}</g>
    <g className={`bp-zone ${tone("company")}`}><rect className="fillable" x="79" y="116" width="361" height="27" rx="2" /></g>
    <g className={`bp-zone ${tone("insurance")}`}><path d="M40 157H451M496 157H529M573 157H588" /><path d="M40 164H105M159 164H451M496 164H524M578 164H588" /></g>
    <g className={`bp-zone ${tone("inspection")}`}>{[132, 551].map((cx) => <g key={cx}>
      <circle className="fillable" cx={cx} cy="181" r="25" /><circle cx={cx} cy="181" r="14" /><circle cx={cx} cy="181" r="5" /></g>)}</g>
    <g className={`bp-zone ${tone("plate")}`}><rect className="fillable" x="39" y="180" width="23" height="6" rx="1" /></g>
    {pins.map((pin) => <g key={pin.key} className={`bp-pin ${tone(pin.key)}`} transform={`translate(${pin.x},${pin.y})`}>
      <circle r="11" /><text y="4" textAnchor="middle">{pin.n}</text></g>)}
  </svg>;
}

function BusSheet({ bus, checks, color, todayText, isAdmin, now, onSaved }: {
  bus: Bus; checks: BusCheck[]; color: string; todayText: string; isAdmin: boolean; now: number; onSaved: (note: string) => void;
}) {
  const from = () => ({ label: bus.label, plate: bus.plate ?? "", company: bus.company ?? "", seats: bus.seats ? String(bus.seats) : "",
    inspectionDue: bus.inspectionDue ?? "", insuranceExpires: bus.insuranceExpires ?? "", notes: bus.notes ?? "" });
  const [form, setForm] = useState(from);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const saved = JSON.stringify(from());
  useEffect(() => setForm(from()), [saved]); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = JSON.stringify(form) !== saved;
  const set = (next: Partial<typeof form>) => setForm((current) => ({ ...current, ...next }));
  const order: BusCheck["key"][] = ["gps", "seats", "company", "insurance", "inspection", "plate"];

  async function save(event: FormEvent) {
    event.preventDefault();
    const parsed = busDetailsInputSchema.safeParse({ ...form, seats: form.seats.trim() ? Number(form.seats) : null });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? "Check the form."); return; }
    setSaving(true); setError("");
    try {
      busSchema.parse(await send("PUT", `/api/fleet/buses/${bus.id}`, parsed.data, "Could not save the bus."));
      onSaved(`${parsed.data.label} saved.`);
    } catch (cause) { setError(message(cause, "Could not save the bus.")); }
    finally { setSaving(false); }
  }
  async function setActive(active: boolean) {
    setSaving(true); setError("");
    try {
      await send("POST", `/api/fleet/buses/${bus.id}/active`, { active }, "Could not change it.");
      onSaved(active ? `${bus.label} is back in service.` : `${bus.label} is out of service.`);
    } catch (cause) { setError(message(cause, "Could not change it.")); }
    finally { setSaving(false); }
  }

  return <div className="fl-sheet">
    <p className="eyebrow">Bus</p>
    <h2 className="dt">{bus.label}</h2>
    <p className="muted fl-sub">{todayText}{bus.usualDriver ? ` · Usually driven by ${bus.usualDriver}` : ""}</p>
    <Blueprint checks={checks} color={color} />
    <ol className="fl-checks">{order.map((key, index) => {
      const check = checks.find((c) => c.key === key)!;
      const tone = check.state === "ok" ? "ok" : check.state === "soon" ? "warn" : key === "gps" ? "info" : "bad";
      return <li key={key} className={tone}><span className="n">{index + 1}</span><b>{check.label}</b><span>{check.text}</span></li>;
    })}</ol>

    {isAdmin && <form className="planf fl-form" onSubmit={(event) => void save(event)} noValidate>
      <div className="rf2">
        <div className="ctl-row"><label htmlFor="fl-name">Name</label>
          <input id="fl-name" value={form.label} maxLength={80} onChange={(event) => set({ label: event.target.value })} /></div>
        <div className="ctl-row"><label htmlFor="fl-plate">Plate</label>
          <input id="fl-plate" value={form.plate} maxLength={20} autoComplete="off" onChange={(event) => set({ plate: event.target.value.toUpperCase() })} /></div>
      </div>
      <div className="rf2">
        <div className="ctl-row"><label htmlFor="fl-company">Company</label>
          <input id="fl-company" value={form.company} maxLength={120} placeholder="Who runs the bus" onChange={(event) => set({ company: event.target.value })} /></div>
        <div className="ctl-row"><label htmlFor="fl-seats">Seats</label>
          <input id="fl-seats" inputMode="numeric" value={form.seats} onChange={(event) => set({ seats: event.target.value.replace(/\D/g, "").slice(0, 3) })} /></div>
      </div>
      <div className="rf2">
        <div className="ctl-row"><label htmlFor="fl-insp">Inspection due</label>
          <input id="fl-insp" type="date" value={form.inspectionDue} onChange={(event) => set({ inspectionDue: event.target.value })} /></div>
        <div className="ctl-row"><label htmlFor="fl-ins">Insurance expires</label>
          <input id="fl-ins" type="date" value={form.insuranceExpires} onChange={(event) => set({ insuranceExpires: event.target.value })} /></div>
      </div>
      <div className="ctl-row"><label htmlFor="fl-notes">Notes</label>
        <textarea id="fl-notes" rows={2} maxLength={500} value={form.notes} placeholder="Wheelchair lift, AC broken, company phone…" onChange={(event) => set({ notes: event.target.value })} /></div>
      <ErrorNote text={error} />
      <div className="acts">
        <button type="submit" className="btn btn-primary" disabled={saving || !changed}>{saving ? "Saving…" : "Save"}</button>
        {changed && <button type="button" className="btn" onClick={() => setForm(from())}>Undo changes</button>}
      </div>
    </form>}

    <TrackerPanel key={bus.id} busId={bus.id} busLabel={bus.label} busActive={bus.active} now={now} />

    {isAdmin && <div className="fl-retire">{bus.active
      ? <button type="button" className="btn" disabled={saving} onClick={() => void setActive(false)}>Take out of service</button>
      : <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void setActive(true)}>Back in service</button>}</div>}
  </div>;
}

function AddBusForm({ suggested, onAdded }: { suggested: string; onAdded: (bus: Bus) => void }) {
  const [label, setLabel] = useState(suggested);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = createBusSchema.safeParse({ label: label.trim() });
    if (!parsed.success) { setError("Enter a bus name."); return; }
    setSaving(true);
    try { onAdded(busSchema.parse(await send("POST", "/api/fleet/buses", parsed.data, "Could not add the bus."))); }
    catch (cause) { setError(message(cause, "Could not add the bus.")); }
    finally { setSaving(false); }
  }
  return <><p className="eyebrow">Buses</p><h2 className="dt">Add a bus</h2>
    <form className="planf" onSubmit={(event) => void submit(event)} noValidate>
      <div className="ctl-row"><label htmlFor="bus-label">Name</label>
        <input id="bus-label" value={label} maxLength={80} autoComplete="off" onChange={(event) => setLabel(event.target.value)} /></div>
      <ErrorNote text={error} />
      <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? "Adding…" : "Add bus"}</button>
    </form></>;
}

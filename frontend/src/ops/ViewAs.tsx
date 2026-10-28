import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { previewPeopleSchema, type PreviewPeople } from "@bussin/shared";
import { getJson, message } from "./api";
import { FamilyPortalPage } from "../families/FamilyPortalPage";
import { StaffTripPage } from "../staff/StaffTripPage";

const DriverTerminal = lazy(async () => ({ default: (await import("../terminal/DriverTerminal")).DriverTerminal }));

/*
 * View as (admin only). Two kinds:
 * - Dispatch: the whole admin screen drops to what a dispatcher sees (admin pages hidden).
 * - A parent, a counselor or a bus phone: their real screen, live, in a panel docked on the
 *   right that stays open while you work. Read-only: nothing tapped in the panel saves.
 */

export type Watch = { kind: "parent" | "counselor" | "bus"; id: string; name: string };
type Tab = Watch["kind"] | "dispatch";

const KIND_LABEL: Record<Watch["kind"], string> = { parent: "Parent", counselor: "Counselor", bus: "Bus phone" };
const WATCH_KEY = "bussin.watch";

/** Per-viewer convenience: the panel reopens after a reload. Storage may be blocked. */
export function loadWatch(): Watch | null {
  try {
    const raw = window.localStorage.getItem(WATCH_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object" && "kind" in value && "id" in value && "name" in value &&
      (value.kind === "parent" || value.kind === "counselor" || value.kind === "bus") &&
      typeof value.id === "string" && typeof value.name === "string") return { kind: value.kind, id: value.id, name: value.name };
  } catch { /* storage unavailable */ }
  return null;
}
export function saveWatch(watch: Watch | null) {
  try {
    if (watch) window.localStorage.setItem(WATCH_KEY, JSON.stringify(watch));
    else window.localStorage.removeItem(WATCH_KEY);
  } catch { /* storage unavailable */ }
}

type Row = { id: string; name: string; sub: string; trip: string | null };

function rowsFor(tab: Watch["kind"], people: PreviewPeople): Row[] {
  if (tab === "parent") return people.parents.map((p) => ({ id: p.id, name: p.name, sub: p.kids || "No kids linked", trip: p.trip }));
  if (tab === "counselor") return people.counselors.map((c) => ({ id: c.id, name: c.name, sub: "", trip: c.trip }));
  return people.buses.map((b) => ({ id: b.id, name: b.label, sub: b.paired ? "Phone paired" : "No phone paired yet", trip: b.trip }));
}

/** The chooser, shown in an Overlay. */
export function ViewAsPicker({ watching, dispatchView, onWatch, onDispatchView }: {
  watching: Watch | null; dispatchView: boolean;
  onWatch: (watch: Watch) => void; onDispatchView: (on: boolean) => void;
}) {
  const [tab, setTab] = useState<Tab>(watching?.kind ?? "parent");
  const [people, setPeople] = useState<PreviewPeople | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    getJson("/api/preview/people", previewPeopleSchema, controller.signal)
      .then(setPeople)
      .catch((cause) => { if (!controller.signal.aborted) setError(message(cause, "Could not load the list.")); });
    return () => controller.abort();
  }, []);

  const rows = useMemo(() => {
    if (!people || tab === "dispatch") return [];
    const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return rowsFor(tab, people).filter((row) => {
      const text = `${row.name} ${row.sub} ${row.trip ?? ""}`.toLowerCase();
      return words.every((word) => text.includes(word));
    });
  }, [people, tab, search]);

  const tabs: [Tab, string][] = [["parent", "Parent"], ["counselor", "Counselor"], ["bus", "Bus phone"], ["dispatch", "Dispatch"]];

  return <div className="va-pick">
    <p className="eyebrow">ADMIN</p><h2 className="dt">View as</h2>
    <p className="muted">See exactly what someone else sees, live. Read-only: nothing you tap there saves.</p>
    <div className="va-tabs" role="tablist">{tabs.map(([key, label]) =>
      <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? "on" : ""}
        onClick={() => { setTab(key); setSearch(""); }}>{label}</button>)}</div>

    {tab === "dispatch" ? <div className="va-dispatch">
      <p>Your screen switches to what a dispatcher sees: Dispatch, Ride Check, Fleet, Routes, Transit and Reports. Members, Riders, Messages and Data are hidden.</p>
      <button type="button" className="btn btn-primary" onClick={() => onDispatchView(!dispatchView)}>
        {dispatchView ? "Back to Admin view" : "Switch to Dispatch view"}</button>
    </div> : <>
      <input className="va-search" type="search" placeholder={tab === "parent" ? "Search parent or kid" : tab === "counselor" ? "Search counselor" : "Search bus"}
        value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Search" />
      {error && <p className="va-empty">{error}</p>}
      {!people && !error && <p className="va-empty">Loading…</p>}
      {people && !rows.length && <p className="va-empty">{search ? "No match." : tab === "parent"
        ? "No parent has a login yet. Turn on a login from Riders, then they show up here."
        : tab === "counselor" ? "No counselors yet. Add them in Members." : "No buses yet. Add them in Fleet."}</p>}
      <ul className="va-list">{rows.map((row) => {
        const on = watching?.kind === tab && watching.id === row.id;
        return <li key={row.id}><button type="button" className={on ? "on" : ""}
          onClick={() => onWatch({ kind: tab, id: row.id, name: row.name })}>
          <b>{row.name}</b>
          {row.sub && <span>{row.sub}</span>}
          <small>{row.trip ?? "No trip coming up"}</small>
          {on && <em>Watching</em>}
        </button></li>;
      })}</ul>
    </>}
  </div>;
}

/** The live panel. Rendered outside the admin styles so the screen looks exactly like the real phone. */
export function ViewAsDock({ watch, desktop, hidden, onHide, onChange, onClose }: {
  watch: Watch; desktop: boolean; hidden: boolean; onHide: (hidden: boolean) => void; onChange: () => void; onClose: () => void;
}) {
  const key = `${watch.kind}:${watch.id}`;

  const screen = watch.kind === "parent" ? <FamilyPortalPage key={key} preview={{ memberId: watch.id }} />
    : watch.kind === "counselor" ? <StaffTripPage key={key} preview={{ memberId: watch.id, name: watch.name }} />
      : <Suspense fallback={<p className="va-empty">Loading…</p>}>
        <DriverTerminal key={key} deviceBus={watch.name}
          mode={{ kind: "preview", as: "device", tripUrl: `/api/preview/bus/${watch.id}/trip` }} /></Suspense>;

  if (hidden) return createPortal(<button type="button" className="va-pill" onClick={() => onHide(false)}>
    <i />Watching {watch.name}</button>, document.body);

  return createPortal(<aside className={`va-dock${desktop ? " d" : " m"}`} aria-label={`Viewing as ${watch.name}`}>
    <header className="va-head">
      <div><span><i />{KIND_LABEL[watch.kind]} · live · read-only</span><b>{watch.name}</b></div>
      <nav>
        <button type="button" onClick={onChange}>Change</button>
        <button type="button" onClick={() => onHide(true)}>Hide</button>
        <button type="button" onClick={onClose}>Close</button>
      </nav>
    </header>
    <div className="va-stage">{screen}</div>
  </aside>, document.body);
}

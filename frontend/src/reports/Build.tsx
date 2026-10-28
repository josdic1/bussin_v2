import { useEffect, useMemo, useState } from "react";
import {
  buildDataSchema, reportDefinitionSchema, saveReportInputSchema, savedReportSchema, savedReportsResponseSchema,
  type BuildData, type BuildDataset, type BuildField, type ReportDefinition, type SavedReport
} from "@bussin/shared";
import { getJson, message, send } from "../ops/api";
import { ErrorNote } from "../ops/ui";
import { downloadCsv, Sheet, type SheetReport } from "./sheet";

// Build your own: pick the data, the columns, filters, list or totals, and sort.
// The preview on the right updates as you go and is exactly what prints or saves.

type Cell = string | number | null;
type Row = Record<string, Cell>;

const DATASETS: { key: BuildDataset; title: string; blurb: string; dated: boolean }[] = [
  { key: "trips", title: "Trips", blurb: "One row per trip: bus, crew, times", dated: true },
  { key: "rides", title: "Rides", blurb: "One row per kid per trip, from Ride Check", dated: true },
  { key: "riders", title: "Riders", blurb: "The roster: routes, stops, parents", dated: false }
];

const START: Record<BuildDataset, Pick<ReportDefinition, "columns" | "groupBy" | "sortBy">> = {
  trips: { columns: ["date", "time", "bus", "route", "lead", "status"], groupBy: null, sortBy: null },
  rides: { columns: ["date", "rider", "route", "result"], groupBy: null, sortBy: null },
  riders: { columns: ["rider", "amRoute", "amStop", "guardians", "phones"], groupBy: null, sortBy: "rider" }
};

const blank = "(blank)";
const text = (value: Cell | undefined) => (value === null || value === undefined || value === "" ? blank : String(value));

/** Turns the settings and the rows into a printable report. */
function compose(def: ReportDefinition, data: BuildData, title: string, period: string): SheetReport {
  const field = (key: string) => data.fields.find((f) => f.key === key);
  const rows = data.rows.filter((row) => def.filters.every((filter) => !filter.values.length || filter.values.includes(text(row[filter.field]))));
  const columns = def.columns.map(field).filter((f): f is BuildField => !!f);
  const compare = (key: string | null, dir: "asc" | "desc") => (a: Row, b: Row) => {
    if (!key) return 0;
    const x = a[key]; const y = b[key];
    const order = typeof x === "number" && typeof y === "number" ? x - y
      : x === null || x === undefined ? 1 : y === null || y === undefined ? -1 : String(x).localeCompare(String(y), undefined, { numeric: true });
    return dir === "asc" ? order : -order;
  };
  const numeric = columns.filter((c) => c.kind === "number");
  const aggregate = (list: Row[], c: BuildField) => {
    const values = list.map((r) => r[c.key]).filter((v): v is number => typeof v === "number");
    if (!values.length) return null;
    const sum = values.reduce((a, b) => a + b, 0);
    return c.total === "avg" ? Math.round(sum / values.length) : sum;
  };
  const summary: SheetReport["summary"] = [{ label: "Rows", value: String(rows.length), tone: null },
    ...numeric.slice(0, 3).map((c) => ({ label: `${c.total === "avg" ? "Average" : "Total"} ${c.label.toLowerCase()}`, value: String(aggregate(rows, c) ?? "—"), tone: null }))];

  if (def.layout === "totals") {
    const group = def.groupBy ? field(def.groupBy) : null;
    const groups = new Map<string, Row[]>();
    for (const row of rows) groups.set(group ? text(row[group.key]) : "All rows", [...(groups.get(group ? text(row[group.key]) : "All rows") ?? []), row]);
    const totalColumns = [{ key: "group", label: group?.label ?? "Group", numeric: false }, { key: "count", label: "Count", numeric: true },
      ...numeric.map((c) => ({ key: c.key, label: `${c.total === "avg" ? "Avg" : "Total"} ${c.label.toLowerCase()}`, numeric: true }))];
    const totalRows: Row[] = [...groups].map(([name, list]) => ({ group: name, count: list.length, ...Object.fromEntries(numeric.map((c) => [c.key, aggregate(list, c)])) }));
    const sortKey = def.sortBy && totalColumns.some((c) => c.key === def.sortBy) ? def.sortBy : "count";
    totalRows.sort(compare(sortKey, def.sortBy ? def.sortDir : "desc"));
    return { title, period, generatedAt: new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }), summary,
      sections: [{ heading: group ? `Totals by ${group.label.toLowerCase()}` : "Totals", note: null, pageBreak: false, columns: totalColumns, rows: totalRows }] };
  }

  const sorted = [...rows].sort(compare(def.sortBy, def.sortDir));
  const sheetColumns = columns.map((c) => ({ key: c.key, label: c.label, numeric: c.kind === "number" }));
  const group = def.groupBy ? field(def.groupBy) : null;
  const sections = group
    ? [...new Set(sorted.map((r) => text(r[group.key])))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((name, i) => {
      const list = sorted.filter((r) => text(r[group.key]) === name);
      return { heading: `${group.label}: ${name}`, note: `${list.length} ${list.length === 1 ? "row" : "rows"}`, pageBreak: i > 0, columns: sheetColumns, rows: list };
    })
    : [{ heading: `${rows.length} ${rows.length === 1 ? "row" : "rows"}`, note: null, pageBreak: false, columns: sheetColumns, rows: sorted }];
  return { title, period, generatedAt: new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }), summary, sections };
}

export function Build({ query, camp, onDatedChange }: { query: string; camp: string; onDatedChange: (dated: boolean) => void }) {
  const [def, setDef] = useState<ReportDefinition>({ dataset: "trips", ...START.trips, filters: [], layout: "list", sortDir: "asc" });
  const [data, setData] = useState<BuildData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<SavedReport[]>([]);
  const [current, setCurrent] = useState<SavedReport | null>(null);
  const [name, setName] = useState("");
  const [confirming, setConfirming] = useState<null | "new" | "update" | "delete">(null);
  const [note, setNote] = useState("");
  const dated = DATASETS.find((d) => d.key === def.dataset)!.dated;
  useEffect(() => onDatedChange(dated), [dated, onDatedChange]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    getJson(`/api/reports/build/${def.dataset}?${query}`, buildDataSchema, controller.signal)
      .then(setData)
      .catch((cause) => { if (!controller.signal.aborted) setError(message(cause, "Could not load the data.")); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [def.dataset, query]);

  const loadSaved = () => getJson("/api/reports/saved", savedReportsResponseSchema).then((r) => setSaved(r.reports)).catch(() => undefined);
  useEffect(() => { void loadSaved(); }, []);

  const fields = data?.dataset === def.dataset ? data.fields : [];
  const textFields = fields.filter((f) => f.kind === "text");
  const period = new URLSearchParams(query).get("period") ?? "";
  const title = name.trim() || current?.name || "Custom report";
  const report = useMemo(() => data && data.dataset === def.dataset ? compose(def, data, title, dated ? period : "Current roster") : null,
    [def, data, title, dated, period]);
  const distinct = (key: string) => [...new Set((data?.rows ?? []).map((r) => text(r[key])))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).slice(0, 200);

  const set = (patch: Partial<ReportDefinition>) => { setDef((d) => ({ ...d, ...patch })); setConfirming(null); setNote(""); };
  const pickDataset = (dataset: BuildDataset) => set({ dataset, ...START[dataset], filters: [], layout: "list", sortDir: "asc" });
  const toggleColumn = (key: string) => set({ columns: def.columns.includes(key) ? def.columns.filter((c) => c !== key) : [...def.columns, key] });

  async function save(kind: "new" | "update") {
    const input = saveReportInputSchema.safeParse({ name: name.trim() || current?.name || "", definition: def });
    if (!input.success) { setError(input.error.issues[0]?.message ?? "Check the report."); setConfirming(null); return; }
    try {
      const result = savedReportSchema.parse(kind === "update" && current
        ? await send("PUT", `/api/reports/saved/${current.id}`, input.data, "Could not save.")
        : await send("POST", "/api/reports/saved", input.data, "Could not save."));
      setCurrent(result); setName(result.name); setNote(`Saved "${result.name}".`); setError("");
      await loadSaved();
    } catch (cause) { setError(message(cause, "Could not save.")); }
    setConfirming(null);
  }
  async function remove() {
    if (!current) return;
    try {
      await send("DELETE", `/api/reports/saved/${current.id}`, undefined, "Could not delete.");
      setNote(`Deleted "${current.name}".`); setCurrent(null); setName("");
      await loadSaved();
    } catch (cause) { setError(message(cause, "Could not delete.")); }
    setConfirming(null);
  }
  function open(report: SavedReport) {
    const parsed = reportDefinitionSchema.safeParse(report.definition);
    if (!parsed.success) return;
    setDef(parsed.data); setCurrent(report); setName(report.name); setConfirming(null); setNote("");
  }

  return <div className="bd-wrap">
    <aside className="bd-side no-print">
      {saved.length > 0 && <section className="bd-box">
        <h4>Saved reports</h4>
        <div className="bd-saved">{saved.map((r) => <button key={r.id} type="button" className={current?.id === r.id ? "on" : ""} onClick={() => open(r)}>
          <b>{r.name}</b><small>{DATASETS.find((d) => d.key === r.definition.dataset)?.title} · by {r.createdBy}</small></button>)}</div>
      </section>}

      <section className="bd-box">
        <h4><i>1</i>Data</h4>
        <div className="bd-data">{DATASETS.map((d) => <button key={d.key} type="button" className={def.dataset === d.key ? "on" : ""} aria-pressed={def.dataset === d.key}
          onClick={() => pickDataset(d.key)}><b>{d.title}</b><small>{d.blurb}</small></button>)}</div>
      </section>

      <section className="bd-box">
        <h4><i>2</i>Columns <span>{def.columns.length} picked, in this order</span></h4>
        <div className="bd-chips">{fields.map((f) => {
          const at = def.columns.indexOf(f.key);
          return <button key={f.key} type="button" className={at >= 0 ? "on" : ""} aria-pressed={at >= 0} onClick={() => toggleColumn(f.key)}>
            {at >= 0 && <em>{at + 1}</em>}{f.label}</button>;
        })}</div>
      </section>

      <section className="bd-box">
        <h4><i>3</i>Filters <span>only rows that match</span></h4>
        {def.filters.map((filter, index) => {
          const meta = fields.find((f) => f.key === filter.field);
          return <div key={filter.field} className="bd-filter">
            <div className="bd-filter-head"><b>{meta?.label ?? filter.field}</b>
              <span>{filter.values.length ? `${filter.values.length} picked` : "pick values"}</span>
              <button type="button" aria-label={`Remove ${meta?.label} filter`} onClick={() => set({ filters: def.filters.filter((_, i) => i !== index) })}>&times;</button></div>
            <div className="bd-chips small">{distinct(filter.field).map((value) => {
              const on = filter.values.includes(value);
              return <button key={value} type="button" className={on ? "on" : ""} aria-pressed={on}
                onClick={() => set({ filters: def.filters.map((x, i) => i !== index ? x : { ...x, values: on ? x.values.filter((v) => v !== value) : [...x.values, value] }) })}>{value}</button>;
            })}</div>
          </div>;
        })}
        <select value="" aria-label="Add a filter" onChange={(event) => event.target.value && set({ filters: [...def.filters, { field: event.target.value, values: [] }] })}>
          <option value="">+ Add a filter…</option>
          {textFields.filter((f) => !def.filters.some((x) => x.field === f.key)).map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
      </section>

      <section className="bd-box">
        <h4><i>4</i>Show</h4>
        <div className="rp-seg" role="group" aria-label="Layout">{(["list", "totals"] as const).map((layout) =>
          <button key={layout} type="button" className={def.layout === layout ? "on" : ""} aria-pressed={def.layout === layout} onClick={() => set({ layout })}>
            {layout === "list" ? "Every row" : "Totals"}</button>)}</div>
        <label className="bd-label">{def.layout === "list" ? "Split into sections by" : "One total per"}
          <select value={def.groupBy ?? ""} onChange={(event) => set({ groupBy: event.target.value || null })}>
            <option value="">{def.layout === "list" ? "No sections" : "Everything together"}</option>
            {textFields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select></label>
        {def.layout === "totals" && <p className="bd-hint">Totals count rows, add up number columns, and average minutes.</p>}
      </section>

      <section className="bd-box">
        <h4><i>5</i>Sort</h4>
        <div className="bd-sort">
          <select value={def.sortBy ?? ""} aria-label="Sort by" onChange={(event) => set({ sortBy: event.target.value || null })}>
            <option value="">{def.layout === "totals" ? "Biggest count first" : "As listed"}</option>
            {(def.layout === "totals" ? [{ key: "group", label: "Group name" }, { key: "count", label: "Count" }, ...fields.filter((f) => f.kind === "number" && def.columns.includes(f.key))] : fields)
              .map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
          <div className="rp-seg" role="group" aria-label="Direction">{(["asc", "desc"] as const).map((dir) =>
            <button key={dir} type="button" className={def.sortDir === dir ? "on" : ""} aria-pressed={def.sortDir === dir} disabled={!def.sortBy}
              onClick={() => set({ sortDir: dir })}>{dir === "asc" ? "A to Z, low first" : "Z to A, high first"}</button>)}</div>
        </div>
      </section>

      <section className="bd-box">
        <h4><i>6</i>Save</h4>
        <input value={name} maxLength={80} placeholder="Name it, e.g. No-shows by rider" onChange={(event) => { setName(event.target.value); setConfirming(null); }} />
        {confirming && confirming !== "delete" && <div className="bd-confirm">
          <p>{confirming === "update" ? `Replace "${current?.name}" with what's in the preview?` : `Save the preview as "${name.trim()}"?`} It runs for whatever period you pick.</p>
          <div><button type="button" className="btn btn-primary" onClick={() => void save(confirming)}>Yes, save</button>
            <button type="button" className="btn" onClick={() => setConfirming(null)}>Not yet</button></div></div>}
        {confirming === "delete" && <div className="bd-confirm bad"><p>Delete "{current?.name}" for everyone?</p>
          <div><button type="button" className="btn btn-danger" onClick={() => void remove()}>Delete</button>
            <button type="button" className="btn" onClick={() => setConfirming(null)}>Keep it</button></div></div>}
        {!confirming && <div className="acts" style={{ margin: "8px 0 0" }}>
          {current && <button type="button" className="btn btn-primary" onClick={() => setConfirming("update")}>Update "{current.name}"</button>}
          <button type="button" className={current ? "btn" : "btn btn-primary"} disabled={!name.trim() || name.trim() === current?.name}
            onClick={() => setConfirming("new")}>{current ? "Save as new" : "Save report"}</button>
          {current && <button type="button" className="btn btn-danger" onClick={() => setConfirming("delete")}>Delete</button>}
        </div>}
        {note && <p className="bd-note" role="status">{note}</p>}
      </section>
    </aside>

    <div className="bd-main">
      <div className="rp-bar no-print">
        <span className="rp-note">{loading ? "Loading…" : report ? "Live preview. This is what prints." : ""}</span>
        <span className="rp-grow" />
        <button type="button" className="btn" disabled={!report} onClick={() => report && downloadCsv(report, camp)}>Download CSV</button>
        <button type="button" className="btn btn-primary" disabled={!report} onClick={() => window.print()}>Print</button>
      </div>
      <ErrorNote text={error} />
      {!def.columns.length && <p className="hint">Pick at least one column.</p>}
      <div className={`rp-paper${loading ? " loading" : ""}`}>{report && def.columns.length > 0 && <Sheet report={report} camp={camp} />}</div>
    </div>
  </div>;
}

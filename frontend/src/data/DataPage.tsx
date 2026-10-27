import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  dataEditResponseSchema, dataStopOptionsResponseSchema, dataTableResponseSchema, dataTablesResponseSchema,
  type DataCell, type DataColumn, type DataRow, type DataTable, type DataTableKey
} from "@bussin/shared";
import type { z } from "zod";
import { getJson, message } from "../ops/api";
import { Head, Search } from "../ops/ui";
import "./data.css";

// Data mode: every table as a plain grid.
//   Top: one card per table, with its row count. Click a card to open it.
//   Below: that table as a grid. Filter box, click a column header to sort.
//
// Editing: click a cell that can be edited (it highlights on hover).
//   Enter saves. Tab saves and moves to the next editable cell. Escape cancels.
//   Clicking away also saves. Stop cells are dropdowns and save as soon as you pick.
// Feedback is immediate: "Saving" while the server works, a green flash when it lands,
// and a red cell plus a message bar that stays until you dismiss it if it's refused.

type Card = { key: DataTableKey; label: string; count: number };
type Sort = { column: string; down: boolean } | null;
type StopOptions = z.infer<typeof dataStopOptionsResponseSchema>;
type CellKey = `${string}|${string}`;
type CellState = { kind: "saving" } | { kind: "saved" } | { kind: "error"; text: string; tried: string };
type Problem = { cell: CellKey; text: string; where: string };

const cellKey = (rowId: string, column: string): CellKey => `${rowId}|${column}`;

function text(value: DataCell | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function compare(a: DataCell | undefined, b: DataCell | undefined): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const x = text(a);
  const y = text(b);
  if (!x && y) return 1; // empty cells sink to the bottom
  if (x && !y) return -1;
  return x.localeCompare(y, undefined, { numeric: true, sensitivity: "base" });
}

// What the server compares against: stop columns use the hidden route:stop reference.
function shownValue(row: DataRow, column: DataColumn): string {
  if (column.edit === "stop-AM") return text(row.cells.amRef);
  if (column.edit === "stop-PM") return text(row.cells.pmRef);
  return text(row.cells[column.key]);
}

function rowName(row: DataRow): string {
  const c = row.cells;
  return text(c.first) ? `${text(c.first)} ${text(c.last)}` : text(c.name) || text(c.label) || "this row";
}

async function patchCell(table: DataTableKey, rowId: string, body: { column: string; from: string; value: string }) {
  const response = await fetch(`/api/data/${table}/${rowId}`, {
    method: "PATCH",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const json: unknown = await response.json().catch(() => null);
  if (response.ok) return { ok: true as const, row: dataEditResponseSchema.parse(json).row };
  const error = json && typeof json === "object" && "error" in json && typeof json.error === "string"
    ? json.error : `Save failed (${response.status}). Nothing was changed.`;
  const fresh = json && typeof json === "object" && "row" in json ? dataEditResponseSchema.safeParse(json) : null;
  return { ok: false as const, error, row: fresh?.success ? fresh.data.row : null };
}

export function DataPage() {
  const [cards, setCards] = useState<Card[]>([]);
  const [active, setActive] = useState<DataTableKey>("riders");
  const [table, setTable] = useState<DataTable | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [stops, setStops] = useState<StopOptions>({ AM: [], PM: [] });
  const [editing, setEditing] = useState<{ rowId: string; column: string; draft: string } | null>(null);
  const [states, setStates] = useState<Record<CellKey, CellState>>({});
  const [problem, setProblem] = useState<Problem | null>(null);
  const flashTimers = useRef<Record<string, number>>({});

  useEffect(() => {
    const controller = new AbortController();
    getJson("/api/data", dataTablesResponseSchema, controller.signal)
      .then((data) => setCards(data.tables))
      .catch((cause) => { if (!controller.signal.aborted) setError(message(cause, "Could not load tables.")); });
    getJson("/api/data/options/stops", dataStopOptionsResponseSchema, controller.signal)
      .then(setStops)
      .catch(() => { /* dropdowns stay empty; saving will explain */ });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    getJson(`/api/data/${active}`, dataTableResponseSchema, controller.signal)
      .then((data) => { setTable(data); setLoading(false); })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setError(message(cause, "Could not load this table."));
        setLoading(false);
      });
    return () => controller.abort();
  }, [active]);

  useEffect(() => () => Object.values(flashTimers.current).forEach((t) => window.clearTimeout(t)), []);

  const open = (key: DataTableKey) => {
    if (key === active) return;
    setActive(key);
    setQuery("");
    setSort(null);
    setTable(null);
    setEditing(null);
    setStates({});
    setProblem(null);
  };

  const rows = useMemo(() => {
    if (!table) return [];
    const needle = query.trim().toLowerCase();
    const found = needle
      ? table.rows.filter((row) => table.columns.some((c) => text(row.cells[c.key]).toLowerCase().includes(needle)))
      : table.rows;
    if (!sort) return found;
    const sorted = [...found].sort((a, b) => compare(a.cells[sort.column], b.cells[sort.column]));
    return sort.down ? sorted.reverse() : sorted;
  }, [table, query, sort]);

  const sortBy = (column: string) =>
    setSort((now) => (now?.column === column ? (now.down ? null : { column, down: true }) : { column, down: false }));

  const setState = (key: CellKey, state: CellState | null) =>
    setStates((now) => {
      const next = { ...now };
      if (state) next[key] = state; else delete next[key];
      return next;
    });

  const replaceRow = (row: DataRow) =>
    setTable((now) => (now ? { ...now, rows: now.rows.map((r) => (r.id === row.id ? row : r)) } : now));

  const startEdit = (row: DataRow, column: DataColumn) => {
    if (!column.edit || row.locked) return;
    const failed = states[cellKey(row.id, column.key)];
    const draft = failed?.kind === "error" ? failed.tried : shownValue(row, column);
    setEditing({ rowId: row.id, column: column.key, draft });
  };

  // Save one cell. Every outcome shows on screen right away.
  const save = useCallback(async (row: DataRow, column: DataColumn, value: string) => {
    if (!table) return;
    const key = cellKey(row.id, column.key);
    const from = shownValue(row, column);
    setEditing(null);
    if (value === from) { setState(key, null); return; }
    setState(key, { kind: "saving" });
    try {
      const result = await patchCell(table.key, row.id, { column: column.key, from, value });
      if (result.ok) {
        replaceRow(result.row);
        setState(key, { kind: "saved" });
        setProblem((p) => (p?.cell === key ? null : p));
        window.clearTimeout(flashTimers.current[key]);
        flashTimers.current[key] = window.setTimeout(() => setState(key, null), 1400);
      } else {
        // Someone else changed it: show their latest value in the cell, not what was typed.
        if (result.row) replaceRow(result.row);
        setState(key, { kind: "error", text: result.error, tried: result.row ? shownValue(result.row, column) : value });
        setProblem({ cell: key, text: result.error, where: `${rowName(row)}, ${column.label}` });
      }
    } catch {
      const text = "No connection to the server. Nothing was saved. Check your internet and try again.";
      setState(key, { kind: "error", text, tried: value });
      setProblem({ cell: key, text, where: `${rowName(row)}, ${column.label}` });
    }
  }, [table]);

  // Tab: the next editable cell in the same row, then the next row.
  const nextCell = (row: DataRow, column: DataColumn, back: boolean) => {
    if (!table) return;
    const editable = table.columns.filter((c) => c.edit);
    const order = rows.filter((r) => !r.locked).flatMap((r) => editable.map((c) => ({ r, c })));
    const at = order.findIndex((x) => x.r.id === row.id && x.c.key === column.key);
    const next = order[at + (back ? -1 : 1)];
    if (next) startEdit(next.r, next.c);
  };

  const onKey = (event: KeyboardEvent, row: DataRow, column: DataColumn, value: string) => {
    if (event.key === "Escape") { event.preventDefault(); setEditing(null); return; }
    if (event.key === "Enter") { event.preventDefault(); void save(row, column, value); return; }
    if (event.key === "Tab") {
      event.preventDefault();
      void save(row, column, value);
      nextCell(row, column, event.shiftKey);
    }
  };

  const dismiss = () => {
    if (!problem) return;
    setState(problem.cell, null);
    setProblem(null);
  };

  const editableCount = table?.columns.filter((c) => c.edit).length ?? 0;
  const lockedNote = table && editableCount === 0 ? table.rows[0]?.locked : null;

  return <>
    <Head eyebrow="Records" title="Data" sub="Every table in one place. Click a table to open it, click a cell to edit it." />

    <div className="dm-cards" role="tablist" aria-label="Tables">
      {cards.map((card) => <button key={card.key} type="button" role="tab"
        className={card.key === active ? "dm-card on" : "dm-card"} aria-selected={card.key === active}
        onClick={() => open(card.key)}>
        <span>{card.label}</span>
        <strong>{card.count}</strong>
      </button>)}
    </div>

    <section className="dm-grid surface" aria-label={table?.label ?? "Table"}>
      <div className="dm-bar">
        <b>{table?.label ?? cards.find((card) => card.key === active)?.label ?? ""}</b>
        <span className="dm-count">
          {table ? (query.trim()
            ? `${rows.length} of ${table.rows.length} ${table.rows.length === 1 ? "row" : "rows"}`
            : `${table.rows.length} ${table.rows.length === 1 ? "row" : "rows"}`) : ""}
        </span>
        {lockedNote && <span className="dm-ro">Read-only here. {lockedNote}</span>}
        <div className="dm-find">
          <Search value={query} onChange={setQuery} placeholder="Filter this table" />
        </div>
      </div>

      {problem && <div className="dm-problem" role="alert">
        <span><b>Not saved: {problem.where}.</b> {problem.text}</span>
        <button type="button" className="btn sm" onClick={dismiss}>Dismiss</button>
      </div>}

      {error && <p className="dm-note bad" role="alert">{error}</p>}
      {!error && loading && <p className="dm-note">Loading…</p>}
      {!error && !loading && table && table.rows.length === 0 && <p className="dm-note">This table is empty.</p>}
      {!error && !loading && table && table.rows.length > 0 && rows.length === 0 &&
        <p className="dm-note">Nothing matches &ldquo;{query.trim()}&rdquo;.</p>}

      {!error && !loading && table && rows.length > 0 && <div className="dm-scroll">
        <table className="dm-table">
          <thead><tr>
            <th className="dm-num" aria-label="Row number">#</th>
            {table.columns.map((column) => {
              const on = sort?.column === column.key;
              return <th key={column.key} aria-sort={on ? (sort.down ? "descending" : "ascending") : "none"}>
                <button type="button" onClick={() => sortBy(column.key)}>
                  {column.label}<i aria-hidden="true">{on ? (sort.down ? "↓" : "↑") : ""}</i>
                </button>
              </th>;
            })}
          </tr></thead>
          <tbody>
            {rows.map((row, index) => <tr key={row.id} className={row.locked && editableCount ? "dm-locked" : undefined}
              title={row.locked && editableCount ? row.locked : undefined}>
              <td className="dm-num">{index + 1}</td>
              {table.columns.map((column) => {
                const key = cellKey(row.id, column.key);
                const state = states[key];
                const isEditing = editing?.rowId === row.id && editing.column === column.key;
                const canEdit = Boolean(column.edit) && !row.locked;
                const value = text(row.cells[column.key]);
                const cls = [
                  canEdit ? "dm-edit" : "",
                  value ? "" : "dm-empty",
                  state ? `dm-${state.kind}` : "",
                  isEditing ? "dm-open" : ""
                ].filter(Boolean).join(" ");

                if (isEditing && column.edit) {
                  if (column.edit === "stop-AM" || column.edit === "stop-PM") {
                    const options = column.edit === "stop-AM" ? stops.AM : stops.PM;
                    const current = editing.draft;
                    return <td key={column.key} className={cls}>
                      <select autoFocus aria-label={`${column.label} for ${rowName(row)}`} value={current}
                        onChange={(event) => void save(row, column, event.target.value)}
                        onBlur={() => setEditing(null)}
                        onKeyDown={(event) => onKey(event, row, column, current)}>
                        <option value="">No {column.edit === "stop-AM" ? "AM" : "PM"} bus</option>
                        {current && !options.some((o) => o.value === current) &&
                          <option value={current}>{text(row.cells[column.key]) || "Current stop"} (inactive route)</option>}
                        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </td>;
                  }
                  return <td key={column.key} className={cls}>
                    <input autoFocus aria-label={`${column.label} for ${rowName(row)}`}
                      type={column.edit === "email" ? "email" : column.edit === "phone" ? "tel" : "text"}
                      value={editing.draft}
                      onChange={(event) => setEditing({ ...editing, draft: event.target.value })}
                      onBlur={() => void save(row, column, editing.draft)}
                      onKeyDown={(event) => onKey(event, row, column, editing.draft)} />
                  </td>;
                }

                const tried = state?.kind === "error"
                  ? (column.edit === "stop-AM" || column.edit === "stop-PM"
                    ? [...stops.AM, ...stops.PM].find((o) => o.value === state.tried)?.label ?? "No bus"
                    : state.tried || "(blank)")
                  : "";
                const shown = state?.kind === "error" ? tried : value;
                return <td key={column.key} className={cls}
                  title={state?.kind === "error" ? state.text : undefined}
                  tabIndex={canEdit ? 0 : undefined}
                  onClick={canEdit ? () => startEdit(row, column) : undefined}
                  onKeyDown={canEdit ? (event) => { if (event.key === "Enter") { event.preventDefault(); startEdit(row, column); } } : undefined}>
                  {shown}
                  {state?.kind === "saving" && <small className="dm-tag">Saving</small>}
                  {state?.kind === "saved" && <small className="dm-tag">Saved</small>}
                </td>;
              })}
            </tr>)}
          </tbody>
        </table>
      </div>}
    </section>
  </>;
}

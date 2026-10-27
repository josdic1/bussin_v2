import { useEffect, useMemo, useState } from "react";
import {
  dataTableResponseSchema, dataTablesResponseSchema,
  type DataCell, type DataTable, type DataTableKey
} from "@bussin/shared";
import { getJson, message } from "../ops/api";
import { Head, Search } from "../ops/ui";
import "./data.css";

// Data mode: every table as a plain grid.
//   Top: one card per table, with its row count. Click a card to open it.
//   Below: that table as a grid. Filter box, click a column header to sort.
// Read-only for now. Editing cells comes next.

type Card = { key: DataTableKey; label: string; count: number };
type Sort = { column: string; down: boolean } | null;

const EMPTY = ""; // empty cells stay blank

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

export function DataPage() {
  const [cards, setCards] = useState<Card[]>([]);
  const [active, setActive] = useState<DataTableKey>("riders");
  const [table, setTable] = useState<DataTable | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    getJson("/api/data", dataTablesResponseSchema, controller.signal)
      .then((data) => setCards(data.tables))
      .catch((cause) => { if (!controller.signal.aborted) setError(message(cause, "Could not load tables.")); });
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

  const open = (key: DataTableKey) => {
    if (key === active) return;
    setActive(key);
    setQuery("");
    setSort(null);
    setTable(null);
  };

  const rows = useMemo(() => {
    if (!table) return [];
    const needle = query.trim().toLowerCase();
    const found = needle
      ? table.rows.filter((row) => Object.values(row.cells).some((cell) => text(cell).toLowerCase().includes(needle)))
      : table.rows;
    if (!sort) return found;
    const sorted = [...found].sort((a, b) => compare(a.cells[sort.column], b.cells[sort.column]));
    return sort.down ? sorted.reverse() : sorted;
  }, [table, query, sort]);

  const sortBy = (column: string) =>
    setSort((now) => (now?.column === column ? (now.down ? null : { column, down: true }) : { column, down: false }));

  return <>
    <Head eyebrow="Records" title="Data" sub="Every table in one place. Click a table to open it." />

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
          {table ? (query.trim() ? `${rows.length} of ${table.rows.length} rows` : `${table.rows.length} rows`) : ""}
        </span>
        <div className="dm-find">
          <Search value={query} onChange={setQuery} placeholder="Filter this table" />
        </div>
      </div>

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
            {rows.map((row, index) => <tr key={row.id}>
              <td className="dm-num">{index + 1}</td>
              {table.columns.map((column) => {
                const value = text(row.cells[column.key]);
                return <td key={column.key} className={value ? undefined : "dm-empty"}>{value || EMPTY}</td>;
              })}
            </tr>)}
          </tbody>
        </table>
      </div>}
    </section>
  </>;
}

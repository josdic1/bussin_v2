import { useEffect, useRef, useState, type ReactNode } from "react";

// Small hand-built charts for the Visualize dashboard. Rules (from the data-viz spec):
// thin marks, bars <= 24px with a 4px rounded end, 2px lines, >= 8px markers with a
// 2px surface ring, hairline solid grid, text in text colors (never the series color),
// a hover tooltip on every chart, and a table view behind every chart.

export const SERIES = { one: "#2a78d6", two: "#eb6834" };
// Sequential blue, light to dark (magnitude only).
const RAMP = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95"];

/** Width of an element, kept current as the layout changes. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

type Tip = { x: number; y: number; title: string; rows: { label: string; value: string; color?: string }[] } | null;

function Tooltip({ tip }: { tip: Tip }) {
  if (!tip) return null;
  return <div className="vz-tip" style={{ left: tip.x, top: tip.y }} role="status">
    <p>{tip.title}</p>
    {tip.rows.map((row) => <div key={row.label}>{row.color && <i style={{ background: row.color }} />}<b>{row.value}</b><span>{row.label}</span></div>)}
  </div>;
}

/** Clean tick steps: 0, 5, 10... or 0, 20, 40... */
function ticks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(Math.round(v * 100) / 100);
  if (out.at(-1)! < max) out.push(out.at(-1)! + step);
  return out;
}

// ---------- A card with a Chart / Table switch ----------

export function Card({ title, sub, wide, children, table }: {
  title: string; sub?: ReactNode; wide?: boolean; children: ReactNode;
  table?: { columns: string[]; rows: (string | number)[][] };
}) {
  const [showTable, setShowTable] = useState(false);
  return <section className={`vz-card${wide ? " wide" : ""}`}>
    <header><div><h3>{title}</h3>{sub && <p>{sub}</p>}</div>
      {table && <button type="button" className="vz-toggle" onClick={() => setShowTable(!showTable)}>{showTable ? "Chart" : "Table"}</button>}</header>
    {showTable && table
      ? <table className="vz-table"><thead><tr>{table.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>{table.rows.map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c}>{cell}</td>)}</tr>)}</tbody></table>
      : children}
  </section>;
}

// ---------- Stacked columns (two series over days) ----------

export function StackedColumns({ days, series }: {
  days: { label: string; values: number[] }[];
  series: { label: string; color: string }[];
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip>(null);
  const [hover, setHover] = useState<number | null>(null);
  const height = 190; const left = 34; const bottom = 24; const top = 8;
  const plotW = Math.max(0, width - left - 4); const plotH = height - bottom - top;
  const totals = days.map((d) => d.values.reduce((a, b) => a + b, 0));
  const scale = ticks(Math.max(1, ...totals));
  const max = scale.at(-1)!;
  const band = days.length ? plotW / days.length : 0;
  const barW = Math.min(24, band * 0.6);
  const y = (v: number) => top + plotH - (v / max) * plotH;
  const every = Math.ceil(days.length / Math.max(1, Math.floor(plotW / 44)));

  return <div ref={ref} className="vz-plot" onPointerLeave={() => { setTip(null); setHover(null); }}>
    {width > 0 && <svg width={width} height={height} role="img" aria-label="Column chart">
      {scale.map((v) => <g key={v}><line x1={left} x2={width} y1={y(v)} y2={y(v)} className="vz-grid" />
        <text x={left - 6} y={y(v) + 3} className="vz-axis" textAnchor="end">{v}</text></g>)}
      {days.map((day, i) => {
        const cx = left + band * i + band / 2;
        let base = 0;
        const segments = day.values.map((v, s) => {
          if (!v) return null;
          const y0 = y(base); const y1 = y(base + v);
          base += v;
          const isTop = day.values.slice(s + 1).every((n) => !n);
          // 2px surface gap between stacked segments; only the top segment gets the rounded end.
          const h = Math.max(0, y0 - y1 - (s > 0 ? 2 : 0));
          const r = isTop ? Math.min(4, h, barW / 2) : 0;
          const x = cx - barW / 2; const yt = y1;
          return <path key={s} fill={series[s]!.color} opacity={hover === null || hover === i ? 1 : 0.55}
            d={`M${x},${yt + h} V${yt + r} Q${x},${yt} ${x + r},${yt} H${x + barW - r} Q${x + barW},${yt} ${x + barW},${yt + r} V${yt + h} Z`} />;
        });
        return <g key={day.label}>
          {segments}
          {i % every === 0 && <text x={cx} y={height - 7} className="vz-axis" textAnchor="middle">{day.label}</text>}
          <rect x={cx - band / 2} y={top} width={band} height={plotH} fill="transparent" tabIndex={0}
            onPointerMove={(event) => {
              setHover(i);
              const box = ref.current!.getBoundingClientRect();
              setTip({ x: event.clientX - box.left, y: event.clientY - box.top, title: day.label,
                rows: series.map((s, k) => ({ label: s.label, value: String(day.values[k] ?? 0), color: s.color })) });
            }}
            onFocus={() => { setHover(i); setTip({ x: cx, y: top + 10, title: day.label, rows: series.map((s, k) => ({ label: s.label, value: String(day.values[k] ?? 0), color: s.color })) }); }}
            onBlur={() => { setHover(null); setTip(null); }} />
        </g>;
      })}
      <line x1={left} x2={width} y1={y(0)} y2={y(0)} className="vz-base" />
    </svg>}
    <Tooltip tip={tip} />
  </div>;
}

// ---------- Line with a soft area (one series over days) ----------

export function LineTrend({ points, unit }: { points: { label: string; value: number | null }[]; unit: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [at, setAt] = useState<number | null>(null);
  const height = 190; const left = 34; const bottom = 24; const top = 12;
  // Right padding leaves room for the last day's label.
  const plotW = Math.max(0, width - left - 26); const plotH = height - bottom - top;
  const values = points.map((p) => p.value).filter((v): v is number => v !== null);
  const scale = ticks(Math.max(1, ...values));
  const max = scale.at(-1)!;
  const x = (i: number) => left + (points.length > 1 ? (plotW * i) / (points.length - 1) : plotW / 2);
  const y = (v: number) => top + plotH - (v / max) * plotH;
  // Break the line where a day has no value.
  const runs: { i: number; v: number }[][] = [];
  points.forEach((p, i) => {
    if (p.value === null) { runs.push([]); return; }
    if (!runs.length) runs.push([]);
    runs.at(-1)!.push({ i, v: p.value });
  });
  const every = Math.ceil(points.length / Math.max(1, Math.floor(plotW / 44)));
  const tipPoint = at !== null ? points[at] : null;

  return <div ref={ref} className="vz-plot" onPointerLeave={() => setAt(null)}
    onPointerMove={(event) => {
      const box = ref.current!.getBoundingClientRect();
      const rel = event.clientX - box.left - left;
      setAt(Math.max(0, Math.min(points.length - 1, Math.round((rel / Math.max(1, plotW)) * (points.length - 1)))));
    }}>
    {width > 0 && <svg width={width} height={height} role="img" aria-label="Line chart">
      {scale.map((v) => <g key={v}><line x1={left} x2={width} y1={y(v)} y2={y(v)} className="vz-grid" />
        <text x={left - 6} y={y(v) + 3} className="vz-axis" textAnchor="end">{v}</text></g>)}
      {runs.filter((r) => r.length).map((run, k) => <g key={k}>
        {run.length > 1 && <path fill={SERIES.one} opacity={0.1}
          d={`M${x(run[0]!.i)},${y(0)} ${run.map((p) => `L${x(p.i)},${y(p.v)}`).join(" ")} L${x(run.at(-1)!.i)},${y(0)} Z`} />}
        <path fill="none" stroke={SERIES.one} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"
          d={run.map((p, n) => `${n ? "L" : "M"}${x(p.i)},${y(p.v)}`).join(" ")} />
        {run.map((p) => <circle key={p.i} cx={x(p.i)} cy={y(p.v)} r={4} fill={SERIES.one} stroke="#fff" strokeWidth={2} />)}
      </g>)}
      {points.map((p, i) => i % every === 0 && <text key={p.label} x={x(i)} y={height - 7} className="vz-axis" textAnchor="middle">{p.label}</text>)}
      <line x1={left} x2={width} y1={y(0)} y2={y(0)} className="vz-base" />
      {at !== null && <line x1={x(at)} x2={x(at)} y1={top} y2={y(0)} className="vz-cross" />}
    </svg>}
    <Tooltip tip={tipPoint && at !== null ? { x: x(at), y: top + 4, title: tipPoint.label,
      rows: [{ label: unit, value: tipPoint.value === null ? "No trips" : String(tipPoint.value), color: SERIES.one }] } : null} />
  </div>;
}

// ---------- Horizontal bars (one series, value at the tip) ----------

export function HBars({ items, color = SERIES.one, format = String }: {
  items: { label: string; value: number; note?: string }[]; color?: string; format?: (v: number) => string;
}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  if (!items.length) return <p className="vz-empty">Nothing in this period.</p>;
  return <ul className="vz-hbars">{items.map((item) =>
    <li key={item.label} title={item.note ? `${item.label}: ${item.note}` : undefined}>
      <span className="vz-hl">{item.label}</span>
      <span className="vz-track">{item.value > 0 && <i style={{ width: `${(item.value / max) * 100}%`, background: color }} />}</span>
      <b>{format(item.value)}</b>
    </li>)}</ul>;
}

// ---------- Calendar heat (attendance per day) ----------

export function CalendarHeat({ days }: { days: { day: string; label: string; rate: number | null; detail: string }[] }) {
  const [tip, setTip] = useState<Tip>(null);
  const ref = useRef<HTMLDivElement>(null);
  if (!days.length) return null;
  const firstDow = (new Date(`${days[0]!.day}T12:00:00`).getDay() + 6) % 7; // Monday first
  const color = (rate: number | null) => rate === null ? "#f0efec" : RAMP[Math.min(RAMP.length - 1, Math.floor(rate * RAMP.length))]!;
  return <div ref={ref} className="vz-cal-wrap" onPointerLeave={() => setTip(null)}>
    <div className="vz-cal">
      {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => <span key={i} className="vz-dow">{d}</span>)}
      {Array.from({ length: firstDow }, (_, i) => <span key={`pad${i}`} />)}
      {days.map((d) => <button key={d.day} type="button" className="vz-day" style={{ background: color(d.rate) }}
        aria-label={`${d.label}: ${d.detail}`}
        onPointerMove={(event) => {
          const box = ref.current!.getBoundingClientRect();
          setTip({ x: event.clientX - box.left, y: event.clientY - box.top, title: d.label, rows: [{ label: "", value: d.detail }] });
        }}
        onFocus={(event) => {
          const box = ref.current!.getBoundingClientRect(); const cell = event.currentTarget.getBoundingClientRect();
          setTip({ x: cell.left - box.left + cell.width / 2, y: cell.top - box.top, title: d.label, rows: [{ label: "", value: d.detail }] });
        }}
        onBlur={() => setTip(null)}>
        <span style={{ color: d.rate !== null && d.rate >= 0.5 ? "#fff" : "#0b0b0b" }}>{Number(d.day.slice(8))}</span>
      </button>)}
    </div>
    <div className="vz-scale"><span>0%</span>{RAMP.map((c) => <i key={c} style={{ background: c }} />)}<span>100%</span>
      <i className="none" style={{ background: "#f0efec" }} /><span>No rides</span></div>
    <Tooltip tip={tip} />
  </div>;
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return <div className="vz-legend">{items.map((item) => <span key={item.label}><i style={{ background: item.color }} />{item.label}</span>)}</div>;
}

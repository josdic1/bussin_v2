import { useEffect, useMemo, useState } from "react";
import { reportSchema, type Report, type ReportKey } from "@bussin/shared";
import { getJson, message } from "../ops/api";
import { useAuth } from "../auth/AuthProvider";
import { ErrorNote, Head } from "../ops/ui";
import "./reports.css";

// Reports, Analyze mode: pick a ready-made report and a period, look at the
// preview (it is exactly what prints), then Print or Download CSV.

type Span = "day" | "week" | "month";

const REPORTS: { key: ReportKey; mark: string; title: string; blurb: string; dated: boolean }[] = [
  { key: "run-sheet", mark: "RS", title: "Run sheet", blurb: "Every trip with bus, driver, lead and kids. One day adds each trip's stops and riders.", dated: true },
  { key: "attendance", mark: "AT", title: "Attendance", blurb: "Who rode, no-shows and days off, per rider and per ride.", dated: true },
  { key: "trip-times", mark: "TT", title: "Trip times", blurb: "When each bus left and got back, how late, how long.", dated: true },
  { key: "crew", mark: "CR", title: "Crew and leads", blurb: "Who led, who rode along, who drove, and how often.", dated: true },
  { key: "riders", mark: "RR", title: "Riders by route", blurb: "Today's roster by route and stop, with parent phones.", dated: false }
];

// ---------- Periods (in the viewer's own time zone) ----------

function startOf(span: Span, anchor: Date): Date {
  const d = new Date(anchor); d.setHours(0, 0, 0, 0);
  if (span === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
  if (span === "month") d.setDate(1);
  return d;
}
function shift(span: Span, from: Date, steps: number): Date {
  const d = new Date(from);
  if (span === "day") d.setDate(d.getDate() + steps);
  if (span === "week") d.setDate(d.getDate() + 7 * steps);
  if (span === "month") d.setMonth(d.getMonth() + steps);
  return d;
}
function label(span: Span, from: Date): string {
  if (span === "day") return from.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  if (span === "week") {
    const end = shift("day", from, 6);
    return `Week of ${from.toLocaleDateString("en-US", { month: "short", day: "numeric" })} to ${end.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
  }
  return from.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

// ---------- CSV (every section, one after another) ----------

function csvCell(value: string | number | null | undefined): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
function downloadCsv(report: Report, camp: string) {
  const lines: string[] = [csvCell(`${report.title}, ${report.period}`)];
  for (const section of report.sections) {
    lines.push("", csvCell(section.heading), section.columns.map((c) => csvCell(c.label)).join(","));
    for (const row of section.rows) lines.push(section.columns.map((c) => csvCell(row[c.key])).join(","));
  }
  const blob = new Blob([`﻿${lines.join("\r\n")}\r\n`], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  link.download = `${slug(camp)}-${report.key}-${slug(report.period)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

// ---------- The sheet: the preview is exactly what prints ----------

function Sheet({ report, camp }: { report: Report; camp: string }) {
  return <article className="rp-sheet">
    <header className="rp-head">
      <div><p className="rp-camp">{camp}</p><h2>{report.title}</h2><p className="rp-period">{report.period}</p></div>
      <p className="rp-stamp">Printed {report.generatedAt}</p>
    </header>
    <div className="rp-kpis">{report.summary.map((item) =>
      <div key={item.label} className={item.tone ?? ""}><b>{item.value}</b><span>{item.label}</span></div>)}</div>
    {report.sections.length === 0 && <p className="rp-empty">Nothing in this period.</p>}
    {report.sections.map((section, index) => <section key={`${section.heading}-${index}`} className={`rp-section${section.pageBreak ? " break" : ""}`}>
      <div className="rp-sec-head"><h3>{section.heading}</h3>{section.note && <p>{section.note}</p>}</div>
      {section.rows.length === 0 ? <p className="rp-empty">None.</p> : <table className="rp-table">
        <thead><tr>{section.columns.map((c) => <th key={c.key} className={c.numeric ? "num" : ""}>{c.label}</th>)}</tr></thead>
        <tbody>{section.rows.map((row, r) => <tr key={r}>{section.columns.map((c) => {
          const value = row[c.key];
          // Short columns (times, buses, counts) never wrap; long text (names, notes) does.
          const long = section.rows.some((x) => String(x[c.key] ?? "").length > 22);
          return <td key={c.key} className={`${c.numeric ? "num" : ""}${long ? "" : " tight"}${value === null || value === "" ? " blank" : ""}`}>
            {value === null || value === "" ? "—" : value}</td>;
        })}</tr>)}</tbody>
      </table>}
    </section>)}
  </article>;
}

export function ReportsPage() {
  const { tenant } = useAuth();
  const camp = tenant?.name ?? "Bussin";
  const [key, setKey] = useState<ReportKey>("run-sheet");
  const [span, setSpan] = useState<Span>("day");
  const [from, setFrom] = useState(() => startOf("day", new Date()));
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const meta = REPORTS.find((r) => r.key === key)!;

  const query = useMemo(() => new URLSearchParams({
    from: from.toISOString(), to: shift(span, from, 1).toISOString(),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone, period: label(span, from)
  }).toString(), [from, span]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    getJson(`/api/reports/${key}?${query}`, reportSchema, controller.signal)
      .then((data) => setReport(data))
      .catch((cause) => { if (!controller.signal.aborted) { setReport(null); setError(message(cause, "Could not build that report.")); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [key, query]);

  const pickSpan = (next: Span) => { setSpan(next); setFrom(startOf(next, from)); };
  const rows = report?.sections.reduce((n, s) => n + s.rows.length, 0) ?? 0;

  return <div className="rp">
    <div className="no-print">
      <Head eyebrow="Records" title="Reports" sub="Pick a report and a period. The preview is exactly what prints." />
      <div className="rp-modes" role="tablist" aria-label="Report mode">
        <button type="button" role="tab" aria-selected="true" className="on">Analyze</button>
        <button type="button" role="tab" aria-selected="false" disabled>Visualize<em>Next</em></button>
        <button type="button" role="tab" aria-selected="false" disabled>Build your own<em>Next</em></button>
      </div>
    </div>

    <div className="rp-body">
      <nav className="rp-pick no-print" aria-label="Reports">
        {REPORTS.map((r) => <button key={r.key} type="button" className={r.key === key ? "on" : ""} onClick={() => setKey(r.key)}>
          <i>{r.mark}</i><span><b>{r.title}</b><small>{r.blurb}</small></span></button>)}
      </nav>

      <div className="rp-main">
        <div className="rp-bar no-print">
          {meta.dated ? <>
            <div className="rp-seg" role="group" aria-label="Period">{(["day", "week", "month"] as const).map((s) =>
              <button key={s} type="button" className={s === span ? "on" : ""} aria-pressed={s === span} onClick={() => pickSpan(s)}>
                {s === "day" ? "Day" : s === "week" ? "Week" : "Month"}</button>)}</div>
            <div className="rp-nav">
              <button type="button" aria-label="Previous" onClick={() => setFrom(shift(span, from, -1))}>&lsaquo;</button>
              <span>{label(span, from)}</span>
              <button type="button" aria-label="Next" onClick={() => setFrom(shift(span, from, 1))}>&rsaquo;</button>
            </div>
            <button type="button" className="btn sm" onClick={() => setFrom(startOf(span, new Date()))}>Today</button>
          </> : <span className="rp-note">Current roster, no dates</span>}
          <span className="rp-grow" />
          <span className="rp-note">{loading ? "Building…" : report ? `${rows} ${rows === 1 ? "row" : "rows"}` : ""}</span>
          <button type="button" className="btn" disabled={!report || loading} onClick={() => report && downloadCsv(report, camp)}>Download CSV</button>
          <button type="button" className="btn btn-primary" disabled={!report || loading} onClick={() => window.print()}>Print</button>
        </div>
        <ErrorNote text={error} />
        <div className={`rp-paper${loading ? " loading" : ""}`}>{report && <Sheet report={report} camp={camp} />}</div>
      </div>
    </div>
  </div>;
}

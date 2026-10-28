import type { Report } from "@bussin/shared";

// The printable sheet and its CSV, shared by Analyze (ready-made reports) and
// Build your own. The preview on screen is exactly what prints.

/** A report without its built-in key, so custom reports use the same sheet. */
export type SheetReport = Omit<Report, "key">;

// ---------- CSV (every section, one after another) ----------

function csvCell(value: string | number | null | undefined): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
export function downloadCsv(report: SheetReport, camp: string) {
  const lines: string[] = [csvCell(`${report.title}, ${report.period}`)];
  for (const section of report.sections) {
    lines.push("", csvCell(section.heading), section.columns.map((c) => csvCell(c.label)).join(","));
    for (const row of section.rows) lines.push(section.columns.map((c) => csvCell(row[c.key])).join(","));
  }
  const blob = new Blob([`﻿${lines.join("\r\n")}\r\n`], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  link.download = `${slug(camp)}-${slug(report.title)}-${slug(report.period)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

// ---------- The sheet: the preview is exactly what prints ----------

export function Sheet({ report, camp }: { report: SheetReport; camp: string }) {
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


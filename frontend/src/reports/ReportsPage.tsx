import { useCallback, useEffect, useMemo, useState } from "react";
import { reportSchema, type Report, type ReportKey } from "@bussin/shared";
import { downloadCsv, Sheet } from "./sheet";
import { getJson, message } from "../ops/api";
import { useAuth } from "../auth/AuthProvider";
import { ErrorNote, Head } from "../ops/ui";
import { Build } from "./Build";
import { Visualize } from "./Visualize";
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

export function ReportsPage() {
  const { tenant } = useAuth();
  const camp = tenant?.name ?? "Bussin";
  type Mode = "analyze" | "visualize" | "build";
  const [mode, setMode] = useState<Mode>("analyze");
  // Build your own tells us whether its data has dates (the roster doesn't).
  const [buildDated, setBuildDated] = useState(true);
  const onBuildDated = useCallback((value: boolean) => setBuildDated(value), []);
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
    if (mode !== "analyze") return;
    const controller = new AbortController();
    setLoading(true); setError("");
    getJson(`/api/reports/${key}?${query}`, reportSchema, controller.signal)
      .then((data) => setReport(data))
      .catch((cause) => { if (!controller.signal.aborted) { setReport(null); setError(message(cause, "Could not build that report.")); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [key, query, mode]);

  const pickSpan = (next: Span) => { setSpan(next); setFrom(startOf(next, from)); };
  // Visualize works in weeks and months; a single day has nothing to chart.
  const pickMode = (next: Mode) => {
    setMode(next);
    if (next === "visualize" && span === "day") pickSpan("week");
  };
  const dated = mode === "visualize" || (mode === "build" ? buildDated : meta.dated);
  const rows = report?.sections.reduce((n, s) => n + s.rows.length, 0) ?? 0;

  return <div className="rp">
    <div className="no-print">
      <Head eyebrow="Daily" title="Reports" />
      <div className="rp-modes" role="tablist" aria-label="Report mode">
        <button type="button" role="tab" aria-selected={mode === "analyze"} className={mode === "analyze" ? "on" : ""} onClick={() => pickMode("analyze")}>Analyze</button>
        <button type="button" role="tab" aria-selected={mode === "visualize"} className={mode === "visualize" ? "on" : ""} onClick={() => pickMode("visualize")}>Visualize</button>
        <button type="button" role="tab" aria-selected={mode === "build"} className={mode === "build" ? "on" : ""} onClick={() => pickMode("build")}>Build your own</button>
      </div>
    </div>

    <div className={`rp-body${mode !== "analyze" ? " solo" : ""}`}>
      {mode === "analyze" && <nav className="rp-pick no-print" aria-label="Reports">
        {REPORTS.map((r) => <button key={r.key} type="button" className={r.key === key ? "on" : ""} onClick={() => setKey(r.key)}>
          <i>{r.mark}</i><span><b>{r.title}</b><small>{r.blurb}</small></span></button>)}
      </nav>}

      <div className="rp-main">
        <div className="rp-bar no-print">
          {dated ? <>
            <div className="rp-seg" role="group" aria-label="Period">{(mode === "visualize" ? ["week", "month"] as const : ["day", "week", "month"] as const).map((s) =>
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
          {mode === "analyze" ? <>
            <span className="rp-note">{loading ? "Building…" : report ? `${rows} ${rows === 1 ? "row" : "rows"}` : ""}</span>
            <button type="button" className="btn" disabled={!report || loading} onClick={() => report && downloadCsv(report, camp)}>Download CSV</button>
            <button type="button" className="btn btn-primary" disabled={!report || loading} onClick={() => window.print()}>Print</button>
          </> : mode === "visualize" ? <button type="button" className="btn" onClick={() => window.print()}>Print</button> : null}
        </div>
        {mode === "analyze" ? <>
          <ErrorNote text={error} />
          <div className={`rp-paper${loading ? " loading" : ""}`}>{report && <Sheet report={report} camp={camp} />}</div>
        </> : mode === "visualize" ? <Visualize query={query} /> : <Build query={query} camp={camp} onDatedChange={onBuildDated} />}
      </div>
    </div>
  </div>;
}

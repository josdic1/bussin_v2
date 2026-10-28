import { useEffect, useState } from "react";
import { insightsSchema, type Insights } from "@bussin/shared";
import { getJson, message } from "../ops/api";
import { ErrorNote } from "../ops/ui";
import { Card, CalendarHeat, HBars, Legend, LineTrend, SERIES, StackedColumns } from "./charts";

// Reports, Visualize mode: the period at a glance. One hero number (attendance),
// stat tiles, then charts. Every chart has a Table view with the same numbers.

const pct = (value: number | null) => (value === null ? "—" : `${Math.round(value * 100)}%`);
const mins = (value: number | null) => (value === null ? "—" : `${value} min`);
// Ordered lateness buckets: light (on time) to dark (very late).
const LATE_COLORS = ["#86b6ef", "#3987e5", "#256abf", "#184f95"];

export function Visualize({ query }: { query: string }) {
  const [data, setData] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    getJson(`/api/reports/insights?${query}`, insightsSchema, controller.signal)
      .then(setData)
      .catch((cause) => { if (!controller.signal.aborted) setError(message(cause, "Could not load the numbers.")); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [query]);

  if (!data) return <><ErrorNote text={error} />{loading && <p className="hint">Loading…</p>}</>;
  const t = data.totals;
  const rideDays = data.days.map((d) => ({ label: d.label, values: [d.rode, d.noShow] }));
  const lateTotal = data.lateness.reduce((n, b) => n + b.count, 0);

  // Refetch keeps the frame: the old numbers stay, dimmed, until the new ones land.
  return <div className={`vz${loading ? " loading" : ""}`}>
    <ErrorNote text={error} />
    <div className="vz-top">
      <section className="vz-hero">
        <p>Attendance</p>
        <b>{pct(t.attendance)}</b>
        <span>{t.rode} rides, {t.noShow} {t.noShow === 1 ? "no-show" : "no-shows"}. Days marked not riding ahead don't count.</span>
      </section>
      <div className="vz-tiles">
        <div><span>Trips run</span><b>{t.ran}<small> of {t.trips}</small></b></div>
        <div><span>Kids who rode</span><b>{t.uniqueRiders}</b></div>
        <div><span>Left on time</span><b>{pct(t.onTime)}</b></div>
        <div><span>Average trip</span><b>{mins(t.avgLength)}</b></div>
        <div><span>Average late start</span><b>{mins(t.avgLate)}</b></div>
        <div className={t.missingLead ? "bad" : ""}><span>Upcoming trips with no lead</span><b>{t.missingLead}</b></div>
      </div>
    </div>

    <div className="vz-grid">
      <Card title="Rides per day" sub={<Legend items={[{ label: "Rode", color: SERIES.one }, { label: "No-show", color: SERIES.two }]} />} wide
        table={{ columns: ["Day", "Trips", "Rode", "No-show", "Not riding", "Not checked"],
          rows: data.days.map((d) => [d.label, d.trips, d.rode, d.noShow, d.notRiding, d.unchecked]) }}>
        <StackedColumns days={rideDays} series={[{ label: "Rode", color: SERIES.one }, { label: "No-show", color: SERIES.two }]} />
      </Card>

      <Card title="Attendance by day" sub="Darker is better. Gray days had no checked rides."
        table={{ columns: ["Day", "Attendance", "Rode", "No-show"],
          rows: data.days.map((d) => [d.label, d.rode + d.noShow ? pct(d.rode / (d.rode + d.noShow)) : "—", d.rode, d.noShow]) }}>
        <CalendarHeat days={data.days.map((d) => ({
          day: d.day, label: d.label,
          rate: d.rode + d.noShow ? d.rode / (d.rode + d.noShow) : null,
          detail: d.rode + d.noShow ? `${pct(d.rode / (d.rode + d.noShow))} attendance · ${d.rode} rode · ${d.noShow} no-show` : d.trips ? `${d.trips} trips, no rides checked` : "No trips"
        }))} />
      </Card>

      <Card title="Departures" sub={lateTotal ? `${lateTotal} trips started` : "No trips started yet"}
        table={{ columns: ["When the bus left", "Trips"], rows: data.lateness.map((b) => [b.label, b.count]) }}>
        <ul className="vz-hbars">{data.lateness.map((b, i) => {
          const max = Math.max(1, ...data.lateness.map((x) => x.count));
          return <li key={b.label}><span className="vz-hl">{b.label}</span>
            <span className="vz-track">{b.count > 0 && <i style={{ width: `${(b.count / max) * 100}%`, background: LATE_COLORS[i] }} />}</span><b>{b.count}</b></li>;
        })}</ul>
      </Card>

      <Card title="Average trip length" sub="Minutes from start to finish, finished trips only"
        table={{ columns: ["Day", "Average minutes"], rows: data.days.map((d) => [d.label, d.avgLength ?? "—"]) }}>
        <LineTrend points={data.days.map((d) => ({ label: d.label, value: d.avgLength }))} unit="minutes" />
      </Card>

      <Card title="Rides by route" sub="Rides out of scheduled seats"
        table={{ columns: ["Route", "Rode", "Seats"], rows: data.routes.map((r) => [r.route, r.rode, r.seats]) }}>
        <HBars items={data.routes.map((r) => ({ label: r.route, value: r.rode, note: `${r.rode} of ${r.seats} seats` }))} />
      </Card>

      <Card title="Busiest leads" sub="Trips led this period"
        table={{ columns: ["Lead", "Trips"], rows: data.leads.map((l) => [l.name, l.trips]) }}>
        <HBars items={data.leads.map((l) => ({ label: l.name, value: l.trips }))} />
      </Card>

      <Card title="Heads up" sub="Worth a look this period" wide>
        <ul className="vz-heads">{data.headsUp.length ? data.headsUp.map((h) =>
          <li key={h.title} className={h.tone}><span className="vz-flag" aria-hidden="true">{h.tone === "good" ? "✓" : "!"}</span>
            <div><b>{h.title}</b><p>{h.text}</p></div></li>)
          : <li className="good"><span className="vz-flag" aria-hidden="true">✓</span><div><b>No trips in this period</b></div></li>}</ul>
      </Card>
    </div>
  </div>;
}

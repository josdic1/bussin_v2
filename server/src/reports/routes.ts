import { Router } from "express";
import { reportKeySchema, reportSchema, type Report, type ReportKey } from "@bussin/shared";
import { requireRole } from "../auth/guard.js";
import { deriveRiderState, type RiderEventRow } from "../check/state.js";
import { pool } from "../db/pool.js";
import { loadCrew } from "../dispatch/crew.js";

// Ready-made reports. GET /api/reports/:key?from=&to=&tz=&period=
//   from, to  the window as ISO instants (the browser works out the local day, week or month)
//   tz        the viewer's time zone, so every time prints the way they read it
//   period    the label printed on the sheet ("Wednesday, Oct 28", "Week of Oct 26")
// Each report returns the same shape (shared reportSchema): summary numbers, then tables.
// Read-only. Admin and Dispatch.

export const reportRoutes = Router();

const MAX_DAYS = 93;
type Section = Report["sections"][number];
type Row = Section["rows"][number];
const col = (key: string, label: string, numeric = false) => ({ key, label, numeric });

// ---------- Time formatting in the viewer's zone ----------

function formatters(tz: string) {
  const make = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: tz, ...options });
  const clock = make({ hour: "numeric", minute: "2-digit" });
  const day = make({ weekday: "long", month: "short", day: "numeric" });
  const short = make({ weekday: "short", month: "short", day: "numeric" });
  const key = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return {
    clock: (d: Date | null) => (d ? clock.format(d) : null),
    day: (d: Date) => day.format(d),
    short: (d: Date) => short.format(d),
    dayKey: (d: Date) => key.format(d)
  };
}
type Fmt = ReturnType<typeof formatters>;

const minutes = (from: Date | null, to: Date | null) =>
  from && to ? Math.round((to.getTime() - from.getTime()) / 60_000) : null;
const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "—");
const STATUS: Record<string, string> = { planned: "Planned", active: "Running", completed: "Done", cancelled: "Cancelled" };

// ---------- Shared trip load ----------

type TripRow = {
  id: string; routeName: string; period: "AM" | "PM"; bus: string; status: string;
  departureAt: Date; startedAt: Date | null; endedAt: Date | null;
  lead: string | null; riders: number; stops: number; stopsDone: number;
};

async function loadTrips(from: Date, to: Date) {
  const result = await pool.query<TripRow>(
    `SELECT t.id, t.route_name AS "routeName", r.service_period AS period, b.label AS bus, t.status,
            t.departure_at AS "departureAt", t.started_at AS "startedAt", t.ended_at AS "endedAt",
            (SELECT m.display_name FROM staff_assignments a JOIN members m ON m.id = a.member_id
              WHERE a.trip_id = t.id AND a.crew_role = 'lead'
              ORDER BY (a.ended_at IS NULL) DESC, a.assigned_at DESC LIMIT 1) AS lead,
            (SELECT count(*)::int FROM trip_riders tr WHERE tr.trip_id = t.id) AS riders,
            (SELECT count(*)::int FROM trip_stops s WHERE s.trip_id = t.id) AS stops,
            (SELECT count(DISTINCT e.trip_stop_id)::int FROM trip_events e
              WHERE e.trip_id = t.id AND e.event_type = 'arrived_stop'
                AND NOT EXISTS (SELECT 1 FROM trip_events x WHERE x.replaces_event_id = e.id)) AS "stopsDone"
       FROM trips t JOIN routes r ON r.id = t.route_id JOIN buses b ON b.id = t.bus_id
      WHERE t.departure_at >= $1 AND t.departure_at < $2
      ORDER BY t.departure_at, b.label, t.id`,
    [from, to]
  );
  const crew = await loadCrew(result.rows.map((t) => t.id));
  return result.rows.map((t) => ({ ...t, ...(crew.get(t.id) ?? { driver: null, counselors: [] }) }));
}
type Trip = Awaited<ReturnType<typeof loadTrips>>[number];

function byDay(trips: Trip[], fmt: Fmt) {
  const days = new Map<string, Trip[]>();
  for (const trip of trips) {
    const key = fmt.dayKey(trip.departureAt);
    days.set(key, [...(days.get(key) ?? []), trip]);
  }
  return days;
}

// ---------- Run sheet ----------

async function runSheet(from: Date, to: Date, fmt: Fmt): Promise<Pick<Report, "summary" | "sections">> {
  const trips = await loadTrips(from, to);
  const live = trips.filter((t) => t.status !== "cancelled");
  const sections: Section[] = [];
  const days = byDay(trips, fmt);
  let first = true;
  for (const list of days.values()) {
    sections.push({
      heading: fmt.day(list[0]!.departureAt), note: null, pageBreak: !first,
      columns: [col("time", "Time"), col("bus", "Bus"), col("route", "Route"), col("driver", "Driver"), col("lead", "Lead"),
        col("counselors", "Counselors"), col("riders", "Riders", true), col("left", "Left"), col("returned", "Returned"), col("status", "Status")],
      rows: list.map((t) => ({
        time: fmt.clock(t.departureAt), bus: t.bus, route: t.routeName,
        driver: t.driver ? `${t.driver.name}${t.driver.phone ? ` (${t.driver.phone})` : ""}` : "Not set",
        lead: t.lead ?? "None", counselors: t.counselors.map((c) => c.displayName).join(", ") || null,
        riders: t.riders, left: fmt.clock(t.startedAt), returned: fmt.clock(t.endedAt), status: STATUS[t.status] ?? t.status
      }))
    });
    first = false;
  }

  // One day: each trip's stops with the kids at each one, ready to hand to the lead.
  if (days.size === 1) {
    const stops = await pool.query<{ tripId: string; position: number; label: string; riders: string | null; count: number; arrivedAt: Date | null }>(
      `SELECT s.trip_id AS "tripId", s.position, s.label,
              (SELECT string_agg(r.given_name || ' ' || r.family_name, ', ' ORDER BY r.family_name, r.given_name)
                 FROM trip_riders tr JOIN riders r ON r.id = tr.rider_id WHERE tr.trip_stop_id = s.id AND tr.trip_id = s.trip_id) AS riders,
              (SELECT count(*)::int FROM trip_riders tr WHERE tr.trip_stop_id = s.id AND tr.trip_id = s.trip_id) AS count,
              (SELECT min(e.occurred_at) FROM trip_events e WHERE e.trip_id = s.trip_id AND e.trip_stop_id = s.id
                 AND e.event_type = 'arrived_stop' AND NOT EXISTS (SELECT 1 FROM trip_events x WHERE x.replaces_event_id = e.id)) AS "arrivedAt"
         FROM trip_stops s WHERE s.trip_id = ANY($1::uuid[]) ORDER BY s.trip_id, s.position`,
      [live.map((t) => t.id)]
    );
    for (const trip of live) {
      sections.push({
        heading: `${fmt.clock(trip.departureAt)} · ${trip.bus} · ${trip.routeName}`,
        note: [trip.driver ? `Driver ${trip.driver.name}` : "No driver set", `Lead ${trip.lead ?? "not set"}`,
          trip.counselors.length ? `Counselors ${trip.counselors.map((c) => c.displayName).join(", ")}` : null].filter(Boolean).join(" · "),
        pageBreak: true,
        columns: [col("stop", "#", true), col("label", "Stop"), col("count", "Kids", true), col("riders", "Riders"), col("arrived", "Arrived")],
        rows: stops.rows.filter((s) => s.tripId === trip.id).map((s) => ({
          stop: s.position, label: s.label, count: s.count, riders: s.riders, arrived: fmt.clock(s.arrivedAt)
        }))
      });
    }
  }

  return {
    summary: [
      { label: "Trips", value: String(live.length), tone: null },
      { label: "Buses", value: String(new Set(live.map((t) => t.bus)).size), tone: null },
      { label: "Rider seats", value: String(live.reduce((n, t) => n + t.riders, 0)), tone: null },
      { label: "Done", value: `${live.filter((t) => t.status === "completed").length} of ${live.length}`, tone: null },
      { label: "Missing a lead", value: String(live.filter((t) => !t.lead).length), tone: live.some((t) => !t.lead) ? "bad" : "good" },
      { label: "Cancelled", value: String(trips.length - live.length), tone: null }
    ],
    sections
  };
}

// ---------- Attendance (Ride Check) ----------

const RESULT: Record<string, string> = {
  expected: "Not checked", aboard: "Rode", dropped: "Rode", no_show: "No-show", not_riding: "Not riding"
};

async function attendance(from: Date, to: Date, fmt: Fmt): Promise<Pick<Report, "summary" | "sections">> {
  const seats = await pool.query<{ tripId: string; riderId: string; rider: string; stop: string; route: string; bus: string; status: string; departureAt: Date }>(
    `SELECT tr.trip_id AS "tripId", r.id AS "riderId", r.given_name || ' ' || r.family_name AS rider, s.label AS stop,
            t.route_name AS route, b.label AS bus, t.status, t.departure_at AS "departureAt"
       FROM trip_riders tr JOIN trips t ON t.id = tr.trip_id JOIN riders r ON r.id = tr.rider_id
       JOIN trip_stops s ON s.trip_id = tr.trip_id AND s.id = tr.trip_stop_id JOIN buses b ON b.id = t.bus_id
      WHERE t.departure_at >= $1 AND t.departure_at < $2 AND t.status <> 'cancelled'
      ORDER BY t.departure_at, b.label, r.family_name, r.given_name`,
    [from, to]
  );
  const events = await pool.query<RiderEventRow & { tripId: string; riderId: string }>(
    `SELECT e.trip_id AS "tripId", e.rider_id AS "riderId", e.event_type AS "eventType", e.occurred_at AS "occurredAt",
            m.display_name AS "recordedByName"
       FROM trip_rider_events e JOIN members m ON m.id = e.recorded_by
      WHERE e.trip_id = ANY($1::uuid[]) ORDER BY e.occurred_at, e.recorded_at`,
    [[...new Set(seats.rows.map((s) => s.tripId))]]
  );
  const grouped = new Map<string, RiderEventRow[]>();
  for (const e of events.rows) grouped.set(`${e.tripId}|${e.riderId}`, [...(grouped.get(`${e.tripId}|${e.riderId}`) ?? []), e]);

  const perRider = new Map<string, { rider: string; trips: number; rode: number; noShow: number; notRiding: number; unchecked: number }>();
  const rows: Row[] = [];
  let rode = 0; let noShow = 0; let notRiding = 0; let unchecked = 0; let upcoming = 0;
  for (const seat of seats.rows) {
    const state = deriveRiderState(grouped.get(`${seat.tripId}|${seat.riderId}`) ?? []);
    const result = seat.status === "planned" && state.state === "expected" ? "Scheduled" : RESULT[state.state] ?? state.state;
    if (result === "Rode") rode += 1; else if (result === "No-show") noShow += 1;
    else if (result === "Not riding") notRiding += 1; else if (result === "Not checked") unchecked += 1; else upcoming += 1;
    const tally = perRider.get(seat.riderId) ?? { rider: seat.rider, trips: 0, rode: 0, noShow: 0, notRiding: 0, unchecked: 0 };
    tally.trips += 1;
    if (result === "Rode") tally.rode += 1; else if (result === "No-show") tally.noShow += 1;
    else if (result === "Not riding") tally.notRiding += 1; else if (result === "Not checked") tally.unchecked += 1;
    perRider.set(seat.riderId, tally);
    rows.push({
      date: fmt.short(seat.departureAt), time: fmt.clock(seat.departureAt), route: seat.route, bus: seat.bus,
      rider: seat.rider, stop: seat.stop, result, at: fmt.clock(state.boardedAt ?? state.stateAt), by: state.stateBy
    });
  }
  return {
    summary: [
      { label: "Rider seats", value: String(seats.rowCount ?? 0), tone: null },
      { label: "Rode", value: String(rode), tone: null },
      { label: "No-shows", value: String(noShow), tone: noShow ? "bad" : "good" },
      { label: "Not riding (told ahead)", value: String(notRiding), tone: null },
      { label: "Not checked", value: String(unchecked), tone: unchecked ? "bad" : "good" },
      { label: "Attendance", value: pct(rode, rode + noShow), tone: null }
    ],
    sections: [
      {
        heading: "By rider", note: "Attendance counts rides against no-shows. Days marked Not riding ahead of time don't count against anyone.",
        pageBreak: false,
        columns: [col("rider", "Rider"), col("trips", "Trips", true), col("rode", "Rode", true), col("noShow", "No-shows", true),
          col("notRiding", "Not riding", true), col("unchecked", "Not checked", true), col("rate", "Attendance", true)],
        rows: [...perRider.values()].sort((a, b) => a.rider.localeCompare(b.rider)).map((t) => ({
          rider: t.rider, trips: t.trips, rode: t.rode, noShow: t.noShow, notRiding: t.notRiding, unchecked: t.unchecked,
          rate: pct(t.rode, t.rode + t.noShow)
        }))
      },
      {
        heading: "Every ride", note: upcoming ? `${upcoming} upcoming ${upcoming === 1 ? "seat is" : "seats are"} listed as Scheduled.` : null,
        pageBreak: true,
        columns: [col("date", "Date"), col("time", "Time"), col("route", "Route"), col("bus", "Bus"), col("rider", "Rider"),
          col("stop", "Stop"), col("result", "Result"), col("at", "Checked at"), col("by", "Checked by")],
        rows
      }
    ]
  };
}

// ---------- Trip times ----------

const ON_TIME_MINUTES = 5;

async function tripTimes(from: Date, to: Date, fmt: Fmt): Promise<Pick<Report, "summary" | "sections">> {
  const trips = (await loadTrips(from, to)).filter((t) => t.status !== "cancelled");
  const ran = trips.filter((t) => t.startedAt);
  const late = ran.map((t) => Math.max(0, minutes(t.departureAt, t.startedAt) ?? 0));
  const finished = trips.filter((t) => t.startedAt && t.endedAt);
  const durations = finished.map((t) => minutes(t.startedAt, t.endedAt)!);
  const onTime = late.filter((m) => m <= ON_TIME_MINUTES).length;
  const average = (list: number[]) => (list.length ? `${Math.round(list.reduce((a, b) => a + b, 0) / list.length)} min` : "—");
  return {
    summary: [
      { label: "Trips run", value: `${ran.length} of ${trips.length}`, tone: null },
      { label: `Left on time (within ${ON_TIME_MINUTES} min)`, value: pct(onTime, ran.length), tone: ran.length && onTime / ran.length < 0.9 ? "bad" : "good" },
      { label: "Average late start", value: average(late), tone: null },
      { label: "Average trip length", value: average(durations), tone: null }
    ],
    sections: [{
      heading: "Every trip", note: "Left is when the trip was started. Returned is when it finished.", pageBreak: false,
      columns: [col("date", "Date"), col("scheduled", "Scheduled"), col("bus", "Bus"), col("route", "Route"), col("left", "Left"),
        col("late", "Late (min)", true), col("returned", "Returned"), col("length", "Length (min)", true), col("stops", "Stops"), col("status", "Status")],
      rows: trips.map((t) => {
        const lateBy = minutes(t.departureAt, t.startedAt);
        return {
          date: fmt.short(t.departureAt), scheduled: fmt.clock(t.departureAt), bus: t.bus, route: t.routeName,
          left: fmt.clock(t.startedAt), late: lateBy === null ? null : Math.max(0, lateBy), returned: fmt.clock(t.endedAt),
          length: minutes(t.startedAt, t.endedAt), stops: `${t.stopsDone} of ${t.stops}`, status: STATUS[t.status] ?? t.status
        };
      })
    }]
  };
}

// ---------- Crew and leads ----------

async function crewReport(from: Date, to: Date, fmt: Fmt): Promise<Pick<Report, "summary" | "sections">> {
  const trips = (await loadTrips(from, to)).filter((t) => t.status !== "cancelled");
  const people = new Map<string, { lead: number; counselor: number }>();
  const drivers = new Map<string, { trips: number; phone: string | null }>();
  for (const t of trips) {
    if (t.lead) { const p = people.get(t.lead) ?? { lead: 0, counselor: 0 }; p.lead += 1; people.set(t.lead, p); }
    for (const c of t.counselors) { const p = people.get(c.displayName) ?? { lead: 0, counselor: 0 }; p.counselor += 1; people.set(c.displayName, p); }
    if (t.driver) { const d = drivers.get(t.driver.name) ?? { trips: 0, phone: t.driver.phone }; d.trips += 1; drivers.set(t.driver.name, d); }
  }
  return {
    summary: [
      { label: "Trips", value: String(trips.length), tone: null },
      { label: "With a lead", value: `${trips.filter((t) => t.lead).length} of ${trips.length}`, tone: trips.some((t) => !t.lead) ? "bad" : "good" },
      { label: "With a driver", value: `${trips.filter((t) => t.driver).length} of ${trips.length}`, tone: trips.some((t) => !t.driver) ? "bad" : "good" },
      { label: "Counselors used", value: String(people.size), tone: null },
      { label: "Drivers used", value: String(drivers.size), tone: null }
    ],
    sections: [
      {
        heading: "Counselors", note: null, pageBreak: false,
        columns: [col("name", "Name"), col("lead", "As lead", true), col("counselor", "As counselor", true), col("total", "Total", true)],
        rows: [...people].sort((a, b) => b[1].lead + b[1].counselor - (a[1].lead + a[1].counselor) || a[0].localeCompare(b[0]))
          .map(([name, p]) => ({ name, lead: p.lead, counselor: p.counselor, total: p.lead + p.counselor }))
      },
      {
        heading: "Drivers", note: null, pageBreak: false,
        columns: [col("name", "Driver"), col("phone", "Phone"), col("trips", "Trips", true)],
        rows: [...drivers].sort((a, b) => b[1].trips - a[1].trips || a[0].localeCompare(b[0]))
          .map(([name, d]) => ({ name, phone: d.phone, trips: d.trips }))
      },
      {
        heading: "Who was on each trip", note: null, pageBreak: true,
        columns: [col("date", "Date"), col("time", "Time"), col("bus", "Bus"), col("route", "Route"), col("driver", "Driver"),
          col("lead", "Lead"), col("counselors", "Counselors")],
        rows: trips.map((t) => ({
          date: fmt.short(t.departureAt), time: fmt.clock(t.departureAt), bus: t.bus, route: t.routeName,
          driver: t.driver?.name ?? "Not set", lead: t.lead ?? "None", counselors: t.counselors.map((c) => c.displayName).join(", ") || null
        }))
      }
    ]
  };
}

// ---------- Riders by route (today's roster; no dates) ----------

async function ridersByRoute(): Promise<Pick<Report, "summary" | "sections">> {
  const result = await pool.query<{ riderId: string; rider: string; direction: "AM" | "PM" | null; route: string | null;
    position: number | null; stop: string | null; guardian: string | null; phone: string | null }>(
    `SELECT r.id AS "riderId", r.family_name || ', ' || r.given_name AS rider, a.direction, ro.name AS route, s.position, s.label AS stop,
            (SELECT string_agg(g.name, ', ' ORDER BY g.name) FROM rider_guardian_links l JOIN guardians g ON g.id = l.guardian_id WHERE l.rider_id = r.id) AS guardian,
            (SELECT string_agg(g.phone, ', ' ORDER BY g.name) FROM rider_guardian_links l JOIN guardians g ON g.id = l.guardian_id WHERE l.rider_id = r.id AND g.phone IS NOT NULL) AS phone
       FROM riders r
       LEFT JOIN rider_stop_assignments a ON a.rider_id = r.id
       LEFT JOIN routes ro ON ro.id = a.route_id
       LEFT JOIN route_stops s ON s.id = a.route_stop_id
      ORDER BY a.direction NULLS LAST, ro.name NULLS LAST, s.position, r.family_name, r.given_name`
  );
  const riders = new Set(result.rows.map((r) => r.riderId));
  const am = new Set(result.rows.filter((r) => r.direction === "AM").map((r) => r.riderId));
  const pm = new Set(result.rows.filter((r) => r.direction === "PM").map((r) => r.riderId));
  const none = [...riders].filter((id) => !am.has(id) && !pm.has(id));
  const routes = new Map<string, typeof result.rows>();
  for (const row of result.rows) if (row.route) routes.set(row.route, [...(routes.get(row.route) ?? []), row]);
  const columns = [col("stop", "#", true), col("stopName", "Stop"), col("rider", "Rider"), col("guardian", "Guardians"), col("phone", "Phone")];
  return {
    summary: [
      { label: "Riders", value: String(riders.size), tone: null },
      { label: "Ride AM", value: String(am.size), tone: null },
      { label: "Ride PM", value: String(pm.size), tone: null },
      { label: "No route yet", value: String(none.length), tone: none.length ? "bad" : "good" }
    ],
    sections: [
      ...[...routes].map(([route, rows], index) => ({
        heading: route, note: `${rows.length} ${rows.length === 1 ? "rider" : "riders"}`, pageBreak: index > 0, columns,
        rows: rows.map((r) => ({ stop: r.position, stopName: r.stop, rider: r.rider, guardian: r.guardian, phone: r.phone }))
      })),
      ...(none.length ? [{
        heading: "No route yet", note: "These riders have no AM or PM stop, so no bus will pick them up.", pageBreak: routes.size > 0, columns,
        rows: result.rows.filter((r) => none.includes(r.riderId)).map((r) => ({ stop: null, stopName: null, rider: r.rider, guardian: r.guardian, phone: r.phone }))
      }] : [])
    ]
  };
}

const TITLES: Record<ReportKey, string> = {
  "run-sheet": "Run sheet", attendance: "Attendance", "trip-times": "Trip times", crew: "Crew and leads", riders: "Riders by route"
};

reportRoutes.get("/:key", requireRole("admin", "dispatch"), async (request, response) => {
  const key = reportKeySchema.safeParse(request.params.key);
  const from = new Date(String(request.query.from ?? ""));
  const to = new Date(String(request.query.to ?? ""));
  const tz = String(request.query.tz ?? "America/New_York");
  const period = String(request.query.period ?? "").slice(0, 80);
  if (!key.success) { response.status(404).json({ error: "No such report." }); return; }
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch {
    response.status(400).json({ error: "Unknown time zone." }); return;
  }
  const dated = key.data !== "riders";
  if (dated && (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from ||
      to.getTime() - from.getTime() > MAX_DAYS * 86_400_000)) {
    response.status(400).json({ error: `Choose a period of up to ${MAX_DAYS} days.` });
    return;
  }
  const fmt = formatters(tz);
  const body = key.data === "run-sheet" ? await runSheet(from, to, fmt)
    : key.data === "attendance" ? await attendance(from, to, fmt)
    : key.data === "trip-times" ? await tripTimes(from, to, fmt)
    : key.data === "crew" ? await crewReport(from, to, fmt)
    : await ridersByRoute();
  const stamp = new Intl.DateTimeFormat("en-US", { timeZone: tz, dateStyle: "medium", timeStyle: "short" }).format(new Date());
  response.json(reportSchema.parse({
    key: key.data, title: TITLES[key.data], period: dated ? period : "Current roster", generatedAt: stamp, ...body
  }));
});

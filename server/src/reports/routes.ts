import { Router } from "express";
import {
  buildDataSchema, buildDatasetSchema, insightsSchema, reportKeySchema, reportSchema, saveReportInputSchema, savedReportSchema,
  savedReportsResponseSchema, type BuildData, type BuildDataset, type BuildField, type Insights, type Report, type ReportKey
} from "@bussin/shared";
import { currentMember, requireRole, requireSameOrigin } from "../auth/guard.js";
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
    tz,
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

type SeatRow = { tripId: string; riderId: string; rider: string; stop: string; route: string; bus: string; status: string; departureAt: Date };

/** Every rider seat on non-cancelled trips in the window, with its Ride Check result. */
async function loadSeats(from: Date, to: Date) {
  const seats = await pool.query<SeatRow>(
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
  return seats.rows.map((seat) => {
    const state = deriveRiderState(grouped.get(`${seat.tripId}|${seat.riderId}`) ?? []);
    const result = seat.status === "planned" && state.state === "expected" ? "Scheduled" : RESULT[state.state] ?? state.state;
    return { ...seat, state, result };
  });
}

async function attendance(from: Date, to: Date, fmt: Fmt): Promise<Pick<Report, "summary" | "sections">> {
  const seats = { rows: await loadSeats(from, to) };
  const seatCount = seats.rows.length;
  const perRider = new Map<string, { rider: string; trips: number; rode: number; noShow: number; notRiding: number; unchecked: number }>();
  const rows: Row[] = [];
  let rode = 0; let noShow = 0; let notRiding = 0; let unchecked = 0; let upcoming = 0;
  for (const seat of seats.rows) {
    const { state, result } = seat;
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
      { label: "Rider seats", value: String(seatCount), tone: null },
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

// ---------- Visualize: the numbers for the dashboard ----------

async function insights(from: Date, to: Date, fmt: Fmt, period: string): Promise<Insights> {
  const trips = (await loadTrips(from, to)).filter((t) => t.status !== "cancelled");
  const seats = await loadSeats(from, to);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: fmt.tz, weekday: "short", day: "numeric" });
  const short = { format: (d: Date) => {
    const p = parts.formatToParts(d);
    return `${p.find((x) => x.type === "weekday")?.value} ${p.find((x) => x.type === "day")?.value}`;
  } };

  // Every day in the window, even empty ones, so the calendar has no holes.
  const days = new Map<string, Insights["days"][number]>();
  for (let at = new Date(from.getTime() + 12 * 3_600_000); at < to; at = new Date(at.getTime() + 86_400_000)) {
    days.set(fmt.dayKey(at), { day: fmt.dayKey(at), label: short.format(at), trips: 0, rode: 0, noShow: 0, notRiding: 0,
      unchecked: 0, avgLength: null, departed: 0, onTime: 0 });
  }
  const lengths = new Map<string, number[]>();
  const lateList: number[] = [];
  for (const t of trips) {
    const day = days.get(fmt.dayKey(t.departureAt));
    if (!day) continue;
    day.trips += 1;
    if (t.startedAt) {
      const late = Math.max(0, minutes(t.departureAt, t.startedAt) ?? 0);
      lateList.push(late);
      day.departed += 1;
      if (late <= ON_TIME_MINUTES) day.onTime += 1;
    }
    if (t.startedAt && t.endedAt) lengths.set(day.day, [...(lengths.get(day.day) ?? []), minutes(t.startedAt, t.endedAt)!]);
  }
  for (const [key, list] of lengths) days.get(key)!.avgLength = Math.round(list.reduce((a, b) => a + b, 0) / list.length);

  // past = seats on trips that already ran, minus days the family said "not riding".
  const routeTally = new Map<string, { seats: number; rode: number; past: number }>();
  const riderNoShows = new Map<string, number>();
  const riders = new Set<string>();
  for (const seat of seats) {
    const day = days.get(fmt.dayKey(seat.departureAt));
    const tally = routeTally.get(seat.route) ?? { seats: 0, rode: 0, past: 0 };
    tally.seats += 1;
    if (seat.result !== "Scheduled" && seat.result !== "Not riding") tally.past += 1;
    if (seat.result === "Rode") { tally.rode += 1; riders.add(seat.riderId); }
    routeTally.set(seat.route, tally);
    if (!day) continue;
    if (seat.result === "Rode") day.rode += 1;
    else if (seat.result === "No-show") { day.noShow += 1; riderNoShows.set(seat.rider, (riderNoShows.get(seat.rider) ?? 0) + 1); }
    else if (seat.result === "Not riding") day.notRiding += 1;
    else if (seat.result === "Not checked") day.unchecked += 1;
  }

  const all = [...days.values()];
  const sum = (pick: (d: Insights["days"][number]) => number) => all.reduce((n, d) => n + pick(d), 0);
  const rode = sum((d) => d.rode); const noShow = sum((d) => d.noShow);
  const departed = sum((d) => d.departed); const onTime = sum((d) => d.onTime);
  const allLengths = [...lengths.values()].flat();
  const avg = (list: number[]) => (list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : null);
  const missingLead = trips.filter((t) => !t.lead && t.status === "planned").length;

  const leadTally = new Map<string, number>();
  for (const t of trips) if (t.lead) leadTally.set(t.lead, (leadTally.get(t.lead) ?? 0) + 1);

  // Heads up: the few things worth a look, worst first.
  const headsUp: Insights["headsUp"] = [];
  if (missingLead) headsUp.push({ tone: "bad", title: `${missingLead} upcoming ${missingLead === 1 ? "trip has" : "trips have"} no lead`,
    text: "A trip can't start without a lead counselor. Assign one on Dispatch." });
  const worstRider = [...riderNoShows].sort((a, b) => b[1] - a[1])[0];
  if (worstRider && worstRider[1] >= 2) headsUp.push({ tone: "warn", title: `${worstRider[0]}: ${worstRider[1]} no-shows`,
    text: "Worth a call home to check whether the bus is still needed." });
  const routeRates = [...routeTally].filter(([, t]) => t.past >= 4);
  const lowRoute = routeRates.map(([route, t]) => ({ route, rate: t.rode / t.past })).sort((a, b) => a.rate - b.rate)[0];
  const unchecked = sum((d) => d.unchecked);
  if (unchecked) headsUp.push({ tone: "warn", title: `${unchecked} ${unchecked === 1 ? "rider was" : "riders were"} never checked`,
    text: "Ride Check was not finished on some trips, so attendance is incomplete." });
  if (lowRoute && lowRoute.rate < 0.6) headsUp.push({ tone: "warn", title: `${lowRoute.route} rides at ${Math.round(lowRoute.rate * 100)}%`,
    text: "Fewer than 6 in 10 scheduled seats were used. The route may need a look." });
  const lateDays = all.filter((d) => d.departed >= 2 && d.onTime / d.departed < 0.75);
  if (lateDays.length) headsUp.push({ tone: "warn", title: `Late starts on ${lateDays.length} ${lateDays.length === 1 ? "day" : "days"}`,
    text: `Under 75% of buses left on time on ${lateDays.map((d) => d.label).join(", ")}.` });
  if (!headsUp.length && trips.length) headsUp.push({ tone: "good", title: "Nothing needs attention",
    text: "Every trip had a lead, attendance was checked, and buses left on time." });

  return {
    period,
    days: all,
    totals: {
      trips: trips.length, ran: departed, rode, noShow, notRiding: sum((d) => d.notRiding), uniqueRiders: riders.size,
      attendance: rode + noShow ? rode / (rode + noShow) : null, onTime: departed ? onTime / departed : null,
      avgLength: avg(allLengths), avgLate: avg(lateList), missingLead
    },
    lateness: [
      { label: `On time (0 to ${ON_TIME_MINUTES} min)`, count: lateList.filter((m) => m <= ON_TIME_MINUTES).length },
      { label: "6 to 15 min late", count: lateList.filter((m) => m > ON_TIME_MINUTES && m <= 15).length },
      { label: "16 to 30 min late", count: lateList.filter((m) => m > 15 && m <= 30).length },
      { label: "Over 30 min late", count: lateList.filter((m) => m > 30).length }
    ],
    routes: [...routeTally].map(([route, t]) => ({ route, seats: t.seats, rode: t.rode })).sort((a, b) => b.seats - a.seats || a.route.localeCompare(b.route)),
    leads: [...leadTally].map(([name, count]) => ({ name, trips: count })).sort((a, b) => b.trips - a.trips || a.name.localeCompare(b.name)).slice(0, 6),
    headsUp
  };
}

reportRoutes.get("/insights", requireRole("admin", "dispatch"), async (request, response) => {
  const from = new Date(String(request.query.from ?? ""));
  const to = new Date(String(request.query.to ?? ""));
  const tz = String(request.query.tz ?? "America/New_York");
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch {
    response.status(400).json({ error: "Unknown time zone." }); return;
  }
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from || to.getTime() - from.getTime() > MAX_DAYS * 86_400_000) {
    response.status(400).json({ error: `Choose a period of up to ${MAX_DAYS} days.` });
    return;
  }
  response.json(insightsSchema.parse(await insights(from, to, formatters(tz), String(request.query.period ?? "").slice(0, 80))));
});

// ---------- Build your own: raw rows for one dataset ----------

const f = (key: string, label: string, kind: "text" | "number" = "text", total: "sum" | "avg" | null = null) => ({ key, label, kind, total });
const FIELDS: Record<BuildDataset, BuildField[]> = {
  trips: [f("date", "Date"), f("time", "Time"), f("bus", "Bus"), f("route", "Route"), f("period", "AM/PM"), f("status", "Status"),
    f("driver", "Driver"), f("lead", "Lead"), f("counselors", "Counselors"), f("riders", "Riders", "number", "sum"),
    f("left", "Left"), f("returned", "Returned"), f("late", "Minutes late", "number", "avg"), f("length", "Trip minutes", "number", "avg"),
    f("stops", "Stops done")],
  rides: [f("date", "Date"), f("time", "Time"), f("route", "Route"), f("bus", "Bus"), f("rider", "Rider"), f("stop", "Stop"),
    f("result", "Result"), f("checkedAt", "Checked at"), f("checkedBy", "Checked by")],
  riders: [f("rider", "Rider"), f("first", "First"), f("last", "Last"), f("amRoute", "AM route"), f("amStop", "AM stop"),
    f("pmRoute", "PM route"), f("pmStop", "PM stop"), f("guardians", "Guardians"), f("phones", "Phones"), f("emails", "Emails")]
};

async function buildRows(dataset: BuildDataset, from: Date, to: Date, fmt: Fmt): Promise<BuildData["rows"]> {
  if (dataset === "trips") {
    return (await loadTrips(from, to)).map((t) => {
      const late = minutes(t.departureAt, t.startedAt);
      return {
        date: fmt.short(t.departureAt), time: fmt.clock(t.departureAt), bus: t.bus, route: t.routeName, period: t.period,
        status: STATUS[t.status] ?? t.status, driver: t.driver?.name ?? null, lead: t.lead,
        counselors: t.counselors.map((c) => c.displayName).join(", ") || null, riders: t.riders,
        left: fmt.clock(t.startedAt), returned: fmt.clock(t.endedAt), late: late === null ? null : Math.max(0, late),
        length: minutes(t.startedAt, t.endedAt), stops: `${t.stopsDone} of ${t.stops}`
      };
    });
  }
  if (dataset === "rides") {
    return (await loadSeats(from, to)).map((seat) => ({
      date: fmt.short(seat.departureAt), time: fmt.clock(seat.departureAt), route: seat.route, bus: seat.bus, rider: seat.rider,
      stop: seat.stop, result: seat.result, checkedAt: fmt.clock(seat.state.boardedAt ?? seat.state.stateAt), checkedBy: seat.state.stateBy
    }));
  }
  const result = await pool.query<Record<string, string | null>>(
    `SELECT r.family_name || ', ' || r.given_name AS rider, r.given_name AS first, r.family_name AS last,
            amr.name AS "amRoute", ams.label AS "amStop", pmr.name AS "pmRoute", pms.label AS "pmStop",
            (SELECT string_agg(g.name, ', ' ORDER BY g.name) FROM rider_guardian_links l JOIN guardians g ON g.id = l.guardian_id WHERE l.rider_id = r.id) AS guardians,
            (SELECT string_agg(g.phone, ', ' ORDER BY g.name) FROM rider_guardian_links l JOIN guardians g ON g.id = l.guardian_id WHERE l.rider_id = r.id AND g.phone IS NOT NULL) AS phones,
            (SELECT string_agg(g.email, ', ' ORDER BY g.name) FROM rider_guardian_links l JOIN guardians g ON g.id = l.guardian_id WHERE l.rider_id = r.id AND g.email IS NOT NULL) AS emails
       FROM riders r
       LEFT JOIN rider_stop_assignments am ON am.rider_id = r.id AND am.direction = 'AM'
       LEFT JOIN routes amr ON amr.id = am.route_id LEFT JOIN route_stops ams ON ams.id = am.route_stop_id
       LEFT JOIN rider_stop_assignments pm ON pm.rider_id = r.id AND pm.direction = 'PM'
       LEFT JOIN routes pmr ON pmr.id = pm.route_id LEFT JOIN route_stops pms ON pms.id = pm.route_stop_id
      ORDER BY r.family_name, r.given_name`
  );
  return result.rows;
}

reportRoutes.get("/build/:dataset", requireRole("admin", "dispatch"), async (request, response) => {
  const dataset = buildDatasetSchema.safeParse(request.params.dataset);
  const from = new Date(String(request.query.from ?? ""));
  const to = new Date(String(request.query.to ?? ""));
  const tz = String(request.query.tz ?? "America/New_York");
  if (!dataset.success) { response.status(404).json({ error: "No such data." }); return; }
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { response.status(400).json({ error: "Unknown time zone." }); return; }
  if (dataset.data !== "riders" && (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from ||
      to.getTime() - from.getTime() > MAX_DAYS * 86_400_000)) {
    response.status(400).json({ error: `Choose a period of up to ${MAX_DAYS} days.` }); return;
  }
  response.json(buildDataSchema.parse({ dataset: dataset.data, fields: FIELDS[dataset.data], rows: await buildRows(dataset.data, from, to, formatters(tz)) }));
});

// ---------- Saved reports ----------

type SavedRow = { id: string; name: string; definition: unknown; createdBy: string; updatedAt: Date };
const SAVED_SELECT = `SELECT s.id, s.name, s.definition, m.display_name AS "createdBy", s.updated_at AS "updatedAt"
                        FROM saved_reports s JOIN members m ON m.id = s.created_by`;
const toSaved = (row: SavedRow) => savedReportSchema.parse({ ...row, updatedAt: row.updatedAt.toISOString() });

reportRoutes.get("/saved", requireRole("admin", "dispatch"), async (_request, response) => {
  const result = await pool.query<SavedRow>(`${SAVED_SELECT} ORDER BY lower(s.name)`);
  response.json(savedReportsResponseSchema.parse({ reports: result.rows.map(toSaved) }));
});

reportRoutes.post("/saved", requireSameOrigin, requireRole("admin", "dispatch"), async (request, response) => {
  const input = saveReportInputSchema.safeParse(request.body);
  if (!input.success) { response.status(400).json({ error: input.error.issues[0]?.message ?? "Check the report." }); return; }
  try {
    const created = await pool.query<{ id: string }>(
      `INSERT INTO saved_reports (name, definition, created_by) VALUES ($1, $2, $3) RETURNING id`,
      [input.data.name, input.data.definition, currentMember(response).id]);
    const row = await pool.query<SavedRow>(`${SAVED_SELECT} WHERE s.id = $1`, [created.rows[0]!.id]);
    response.status(201).json(toSaved(row.rows[0]!));
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      response.status(409).json({ error: "A saved report already has that name. Pick another, or update that one." }); return;
    }
    throw error;
  }
});

reportRoutes.put("/saved/:id", requireSameOrigin, requireRole("admin", "dispatch"), async (request, response) => {
  const id = String(request.params.id);
  const input = saveReportInputSchema.safeParse(request.body);
  if (!/^[0-9a-f-]{36}$/i.test(id) || !input.success) {
    response.status(400).json({ error: input.success ? "Report not found." : input.error.issues[0]?.message ?? "Check the report." }); return;
  }
  try {
    const updated = await pool.query(`UPDATE saved_reports SET name = $2, definition = $3, updated_at = now() WHERE id = $1`,
      [id, input.data.name, input.data.definition]);
    if (!updated.rowCount) { response.status(404).json({ error: "Report not found." }); return; }
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      response.status(409).json({ error: "Another saved report has that name." }); return;
    }
    throw error;
  }
  const row = await pool.query<SavedRow>(`${SAVED_SELECT} WHERE s.id = $1`, [id]);
  response.json(toSaved(row.rows[0]!));
});

reportRoutes.delete("/saved/:id", requireSameOrigin, requireRole("admin", "dispatch"), async (request, response) => {
  const id = String(request.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) { response.status(400).json({ error: "Report not found." }); return; }
  await pool.query(`DELETE FROM saved_reports WHERE id = $1`, [id]);
  response.status(204).end();
});

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

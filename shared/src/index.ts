import { z } from "zod";

export const coordinateSchema = z.strictObject({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180)
});

export type Coordinate = z.infer<typeof coordinateSchema>;

export const loginSchema = z.strictObject({
  identity: z.string().trim().toLowerCase().min(3).max(254),
  password: z.string().min(1).max(1024)
});

export type LoginInput = z.infer<typeof loginSchema>;

export const changePasswordSchema = z.strictObject({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12).max(1024)
});

export const signedInMemberSchema = z.strictObject({
  id: z.string().uuid(),
  email: z.string().email().nullable(),
  username: z.string().nullable(),
  display_name: z.string(),
  passwordChangeRequired: z.boolean(),
  roles: z.array(z.enum(["admin", "dispatch", "staff", "family"]))
});

export const authResponseSchema = z.strictObject({
  member: signedInMemberSchema,
  tenant: z.strictObject({ key: z.string(), name: z.string() })
});

export type SignedInMember = z.infer<typeof signedInMemberSchema>;

// Everyone who signs in to run the camp: admins, dispatchers and counselors (staff).
// Family logins are on the Riders page instead.
export const staffMemberSchema = z.strictObject({
  id: z.string().uuid(),
  displayName: z.string(),
  username: z.string().nullable(),
  email: z.string().email().nullable(),
  phone: z.string().nullable(),
  roles: z.array(z.enum(["admin", "dispatch", "staff"])),
  passwordChangeRequired: z.boolean(),
  suspended: z.boolean()
});

export const staffMembersResponseSchema = z.strictObject({
  staff: z.array(staffMemberSchema)
});

// ---------- Usernames: first name + last initial ----------
// "Emily Gabor" -> emilyg. If that's taken: emilyga, emilygab, ... then emilyg2, emilyg3.
// Lowercase letters and digits only, 3 to 32 characters, easy to say out loud.
export function usernameCandidates(fullName: string): string[] {
  const words = fullName.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .split(/\s+/).map((word) => word.replace(/[^a-z0-9]/g, "")).filter(Boolean);
  if (!words.length) return [];
  const first = words[0]!.slice(0, 26);
  const last = words.length > 1 ? words.at(-1)! : "";
  const out: string[] = [];
  for (let k = 1; k <= Math.min(last.length, 6); k += 1) out.push(first + last.slice(0, k));
  if (!last) out.push(first);
  const base = out[0] ?? first;
  for (let n = 2; n <= 99; n += 1) out.push(`${base}${n}`);
  return out.map((name) => name.length >= 3 ? name : name.padEnd(3, "0")).filter((name, i, all) => all.indexOf(name) === i);
}

/** The first free username for this person. */
export function suggestUsername(fullName: string, taken: (username: string) => boolean): string {
  return usernameCandidates(fullName).find((name) => !taken(name)) ?? "";
}

export const usernameSuggestionSchema = z.strictObject({ username: z.string() });

export const updateStaffMemberSchema = z.strictObject({
  displayName: z.string().trim().min(1, "Enter a name.").max(120),
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,32}$/, "Username: 3 to 32 letters, numbers or underscores."),
  email: z.string().trim().toLowerCase().pipe(z.email("That email doesn't look right.")).nullable(),
  // Leaving it out keeps the number on file.
  phone: z.lazy(() => phoneSchema).optional()
});
export const staffStatusInputSchema = z.strictObject({ suspended: z.boolean() });
export const staffPasswordResetSchema = z.strictObject({ temporaryPassword: z.string() });

export const createStaffMemberSchema = z.strictObject({
  displayName: z.string().trim().min(1).max(120),
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,32}$/),
  email: z.string().trim().toLowerCase().email().nullable(),
  phone: z.lazy(() => phoneSchema).optional(),
  temporaryPassword: z.string().min(12).max(1024)
});

export type StaffMember = z.infer<typeof staffMemberSchema>;

export const staffScheduleEntrySchema = z.strictObject({
  memberId: z.string().uuid(),
  displayName: z.string(),
  tripId: z.string().uuid(),
  routeName: z.string(),
  servicePeriod: z.enum(["AM", "PM"]),
  busLabel: z.string(),
  departureAt: z.string(),
  status: z.enum(["planned", "active", "completed", "cancelled"])
});

export const staffScheduleResponseSchema = z.strictObject({
  entries: z.array(staffScheduleEntrySchema)
});

export type StaffScheduleEntry = z.infer<typeof staffScheduleEntrySchema>;

export const tripStaffSchema = z.strictObject({
  id: z.string().uuid(),
  displayName: z.string(),
  // Sent where Dispatch needs to call them (the lead on the board).
  phone: z.string().nullable().optional()
});

// A driver is a person on the trip, not a login.
export const tripDriverSchema = z.strictObject({
  id: z.string().uuid(),
  name: z.string(),
  phone: z.string().nullable()
});
export type TripDriver = z.infer<typeof tripDriverSchema>;

export const dispatchStaffResponseSchema = z.strictObject({
  staff: z.array(tripStaffSchema),
  // Active drivers, for the crew picker.
  drivers: z.array(tripDriverSchema)
});

// The whole crew for one trip, saved at once.
//   driverId:     who is driving (can be swapped while the trip runs).
//   leadId:       the lead counselor; runs the trip. Required to start.
//   counselorIds: up to 3 more counselors, for Ride Check.
// Lead and counselors can only change before the trip starts.
export const assignTripCrewSchema = z.strictObject({
  driverId: z.string().uuid().nullable(),
  leadId: z.string().uuid().nullable(),
  counselorIds: z.array(z.string().uuid()).max(3, "A trip can have the lead plus up to 3 more counselors.")
}).refine((crew) => new Set(crew.counselorIds).size === crew.counselorIds.length,
  { message: "Each counselor can only be added once." })
  .refine((crew) => !crew.leadId || !crew.counselorIds.includes(crew.leadId),
  { message: "The lead is already on the crew. Pick someone else as a counselor." });
export type AssignTripCrew = z.infer<typeof assignTripCrewSchema>;

export const assignTripStaffSchema = z.strictObject({
  memberId: z.string().uuid().nullable()
});

export const tripStaffAssignmentResponseSchema = z.strictObject({
  assignedStaff: tripStaffSchema.nullable()
});

export type TripStaff = z.infer<typeof tripStaffSchema>;

export const busSchema = z.strictObject({
  id: z.string().uuid(),
  label: z.string(),
  active: z.boolean(),
  createdAt: z.string(),
  plate: z.string().nullable(),
  company: z.string().nullable(),
  seats: z.number().int().nullable(),
  inspectionDue: z.string().nullable(),
  insuranceExpires: z.string().nullable(),
  notes: z.string().nullable(),
  /** The driver on most of this bus's trips in the last 30 days. */
  usualDriver: z.string().nullable()
});

const blankToNull = (max: number, message: string) =>
  z.string().trim().max(max, message).transform((value) => value || null).nullable();
const dayOrNull = z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/, "Pick a date.").transform((value) => value || null).nullable();

/** Everything on file for a bus. */
export const busDetailsInputSchema = z.strictObject({
  label: z.string().trim().min(1, "Give the bus a name.").max(80),
  plate: blankToNull(20, "Keep the plate under 20 characters."),
  company: blankToNull(120, "Keep the company under 120 characters."),
  seats: z.number().int().min(1, "Seats must be 1 or more.").max(120, "Seats must be 120 or fewer.").nullable(),
  inspectionDue: dayOrNull,
  insuranceExpires: dayOrNull,
  notes: blankToNull(500, "Keep notes under 500 characters.")
});
export type BusDetailsInput = z.infer<typeof busDetailsInputSchema>;
export const busActiveInputSchema = z.strictObject({ active: z.boolean() });

export type BusCheck = { key: "plate" | "company" | "seats" | "inspection" | "insurance" | "gps"; label: string; state: "ok" | "missing" | "expired" | "soon"; text: string };

/**
 * The bus checklist: what's on file, what's missing, what's expired or expiring in 30 days.
 * today is "YYYY-MM-DD" in the camp's calendar; gpsPaired says whether a phone is set up on it.
 */
export function busChecks(bus: Pick<z.infer<typeof busSchema>, "plate" | "company" | "seats" | "inspectionDue" | "insuranceExpires">, today: string, gpsPaired: boolean): BusCheck[] {
  const soon = (day: string) => {
    const days = Math.round((Date.parse(`${day}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
    return days < 0 ? "expired" : days <= 30 ? "soon" : "ok";
  };
  const dated = (key: "inspection" | "insurance", label: string, day: string | null): BusCheck => {
    if (!day) return { key, label, state: "missing", text: `No ${label.toLowerCase()} date` };
    const state = soon(day);
    const nice = new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
    return { key, label, state, text: state === "expired" ? `${label} expired ${nice}` : state === "soon" ? `${label} due ${nice}` : `${label} good until ${nice}` };
  };
  return [
    bus.plate ? { key: "plate", label: "Plate", state: "ok", text: bus.plate } : { key: "plate", label: "Plate", state: "missing", text: "No plate" },
    bus.company ? { key: "company", label: "Company", state: "ok", text: bus.company } : { key: "company", label: "Company", state: "missing", text: "No company" },
    bus.seats ? { key: "seats", label: "Seats", state: "ok", text: `${bus.seats} seats` } : { key: "seats", label: "Seats", state: "missing", text: "Seats not set" },
    dated("inspection", "Inspection", bus.inspectionDue),
    dated("insurance", "Insurance", bus.insuranceExpires),
    gpsPaired ? { key: "gps", label: "GPS phone", state: "ok", text: "Phone paired" } : { key: "gps", label: "GPS phone", state: "missing", text: "No GPS phone (the lead's phone tracks it)" }
  ];
}

export const busesResponseSchema = z.strictObject({
  buses: z.array(busSchema)
});

export const createBusSchema = z.strictObject({
  label: z.string().trim().min(1).max(80)
});

export type Bus = z.infer<typeof busSchema>;

export const routeServicePeriodSchema = z.enum(["AM", "PM"]);
export type RouteServicePeriod = z.infer<typeof routeServicePeriodSchema>;

export const routeFamilyNameSchema = z.string().trim().min(1).max(80);

export const createRouteSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  familyName: routeFamilyNameSchema,
  servicePeriod: routeServicePeriodSchema,
  stops: z.array(
    z.strictObject({
      label: z.string().trim().min(1).max(120),
      latitude: coordinateSchema.shape.latitude,
      longitude: coordinateSchema.shape.longitude
    })
  ).min(1).max(100)
});

export const updateRouteSchema = z.strictObject({
  name: createRouteSchema.shape.name,
  familyName: createRouteSchema.shape.familyName,
  servicePeriod: createRouteSchema.shape.servicePeriod,
  stops: z.array(
    createRouteSchema.shape.stops.element.extend({
      id: z.string().uuid().optional()
    })
  ).min(1).max(100)
});

export const routeSchema = z.strictObject({
  id: z.string().uuid(),
  name: z.string(),
  routeFamilyId: z.string().uuid(),
  routeFamilyName: routeFamilyNameSchema,
  servicePeriod: routeServicePeriodSchema,
  active: z.boolean(),
  stops: z.array(
    z.strictObject({
      id: z.string().uuid(),
      position: z.number().int().positive(),
      label: z.string(),
      latitude: z.number(),
      longitude: z.number()
    })
  )
});

export const routesResponseSchema = z.strictObject({
  routes: z.array(routeSchema)
});

export type Route = z.infer<typeof routeSchema>;

export const createPlannedTripSchema = z.strictObject({
  routeId: z.string().uuid(),
  busId: z.string().uuid(),
  departureAt: z.string().datetime({ offset: true })
});

export const updatePlannedTripSchema = createPlannedTripSchema.extend({
  expected: createPlannedTripSchema
});

/** How an arrival was recorded: by GPS, by a tap, or by a tap that GPS disagreed with. */
export const arrivalMethodSchema = z.enum(["automatic", "manual", "override"]);
export type ArrivalMethod = z.infer<typeof arrivalMethodSchema>;

/** A tapped Arrived refused because GPS puts the bus somewhere else. The phone offers "I'm here anyway". */
export const GPS_FAR_CODE = "gps_far";

export const tripActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("start") }),
  /** override: the person tapped "I'm here anyway" after GPS said the bus was somewhere else. */
  z.strictObject({ type: z.literal("arrive"), stopId: z.string().uuid(), override: z.boolean().optional() }),
  z.strictObject({ type: z.literal("depart"), stopId: z.string().uuid() }),
  z.strictObject({ type: z.literal("undo_arrival"), stopId: z.string().uuid() }),
  z.strictObject({ type: z.literal("complete") }),
  z.strictObject({ type: z.literal("cancel") })
]);

export const plannedTripSchema = z.strictObject({
  id: z.string().uuid(),
  routeId: z.string().uuid(),
  routeName: z.string(),
  servicePeriod: routeServicePeriodSchema,
  busId: z.string().uuid(),
  busLabel: z.string(),
  departureAt: z.string(),
  status: z.enum(["planned", "active", "completed", "cancelled"]),
  stopCount: z.number().int().nonnegative(),
  assignedStaff: tripStaffSchema.nullable()
});

export const plannedTripsResponseSchema = z.strictObject({
  trips: z.array(plannedTripSchema)
});

export type PlannedTrip = z.infer<typeof plannedTripSchema>;

export const boardStopSchema = z.strictObject({
  id: z.string().uuid(),
  position: z.number().int().positive(),
  label: z.string(),
  latitude: coordinateSchema.shape.latitude,
  longitude: coordinateSchema.shape.longitude,
  arrivedAt: z.string().nullable(),
  departedAt: z.string().nullable(),
  arrivalMethod: arrivalMethodSchema.nullable(),
  departureMethod: z.enum(["automatic", "manual"]).nullable()
});

export const boardLocationSchema = coordinateSchema.extend({
  observedAt: z.string(),
  accuracyM: z.number().positive()
});

export const boardStopEtaSchema = z.strictObject({
  stopId: z.string().uuid(),
  label: z.string(),
  etaAt: z.string(),
  durationSecondsFromNow: z.number().nonnegative(),
  distanceMFromNow: z.number().nonnegative(),
  actualArrival: z.boolean()
});

export const boardEtaSchema = z.strictObject({
  status: z.enum([
    "live",
    "aging",
    "calculating",
    "stale",
    "off-route",
    "unavailable"
  ]),
  source: z.enum(["mapbox-traffic", "live-gps"]).nullable(),
  generatedAt: z.string().nullable(),
  stops: z.array(boardStopEtaSchema)
});

export const boardTripSchema = plannedTripSchema.extend({
  // assignedStaff (from plannedTripSchema) is the lead counselor.
  driver: tripDriverSchema.nullable(),
  counselors: z.array(tripStaffSchema),
  stops: z.array(boardStopSchema),
  location: boardLocationSchema.nullable(),
  staffLastSeenAt: z.string().nullable(),
  eta: boardEtaSchema.nullable()
});

export const boardResponseSchema = z.strictObject({
  trips: z.array(boardTripSchema)
});

export const dispatchLocationUpdateSchema = z.strictObject({
  tripId: z.string().uuid(),
  location: boardLocationSchema
});

export type BoardTrip = z.infer<typeof boardTripSchema>;

export const routeGeometriesResponseSchema = z.strictObject({
  geometries: z.array(z.strictObject({
    routeId: z.string().uuid(),
    coordinates: z.array(z.tuple([z.number(), z.number()]).rest(z.number())).min(2)
  }))
});
export type DispatchLocationUpdate = z.infer<typeof dispatchLocationUpdateSchema>;

export const dispatchGpsAuditEntrySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("sample"),
    id: z.string().uuid(),
    observedAt: z.string(),
    receivedAt: z.string(),
    latitude: coordinateSchema.shape.latitude,
    longitude: coordinateSchema.shape.longitude,
    accuracyM: z.number().positive(),
    speedMps: z.number().nonnegative().nullable(),
    headingDegrees: z.number().min(0).lt(360).nullable()
  }),
  z.strictObject({
    kind: z.literal("journey"),
    id: z.string().uuid(),
    occurredAt: z.string(),
    action: z.enum(["arrived_stop", "departed_stop"]),
    stopLabel: z.string()
  }),
  z.strictObject({
    kind: z.literal("correction"),
    id: z.string().uuid(),
    occurredAt: z.string(),
    action: z.literal("arrival_undone"),
    stopLabel: z.string()
  }),
  z.strictObject({
    kind: z.literal("gap"),
    id: z.string(),
    startedAt: z.string(),
    resumedAt: z.string(),
    durationSeconds: z.number().int().positive()
  })
]);

export const dispatchGpsAuditResponseSchema = z.strictObject({
  entries: z.array(dispatchGpsAuditEntrySchema)
});

export type DispatchGpsAuditEntry = z.infer<typeof dispatchGpsAuditEntrySchema>;

export const staffTripStopSchema = z.strictObject({
  id: z.string().uuid(),
  position: z.number().int().positive(),
  label: z.string(),
  latitude: coordinateSchema.shape.latitude,
  longitude: coordinateSchema.shape.longitude,
  arrivedAt: z.string().nullable(),
  departedAt: z.string().nullable(),
  arrivalMethod: arrivalMethodSchema.nullable(),
  departureMethod: z.enum(["automatic", "manual"]).nullable()
});

export const staffTripSchema = z.strictObject({
  id: z.string().uuid(),
  routeName: z.string(),
  servicePeriod: routeServicePeriodSchema,
  busLabel: z.string(),
  departureAt: z.string(),
  status: z.enum(["planned", "active"]),
  stops: z.array(staffTripStopSchema),
  // The phone's seat on this trip (null on the bus phone itself).
  crewRole: z.enum(["lead", "counselor"]).nullable(),
  // The bus's own phone is reporting, so staff phones send no GPS.
  busPhoneLive: z.boolean()
});

export const staffTripResponseSchema = z.strictObject({
  trip: staffTripSchema.nullable()
});

export const tripActionResponseSchema = z.strictObject({
  status: z.enum(["planned", "active", "completed", "cancelled"])
});

export type StaffTrip = z.infer<typeof staffTripSchema>;

export const staffLocationSampleInputSchema = z.strictObject({
  tripId: z.string().uuid(),
  clientSampleId: z.string().uuid(),
  observedAt: z.string().datetime({ offset: true }),
  latitude: coordinateSchema.shape.latitude,
  longitude: coordinateSchema.shape.longitude,
  accuracyM: z.number().positive().max(10000),
  speedMps: z.number().min(0).max(200).nullable(),
  headingDegrees: z.number().min(0).lt(360).nullable()
});

export const staffLocationSampleRejectionReasonSchema = z.enum([
  "duplicate",
  "stale",
  "future",
  "poor_accuracy",
  "bus_phone" // the bus's own phone is the GPS right now
]);

export const staffJourneyTransitionSchema = z.strictObject({
  action: z.enum(["arrived", "departed"]),
  stopId: z.string().uuid(),
  stopLabel: z.string()
});

export type StaffJourneyTransition = z.infer<typeof staffJourneyTransitionSchema>;

export const staffJourneyProgressSchema = z.strictObject({
  phase: z.enum(["approaching", "confirming_arrival", "arrived", "confirming_departure", "rearming"]),
  stopId: z.string().uuid(),
  stopLabel: z.string(),
  distanceM: z.number().nonnegative(),
  qualifyingFixes: z.number().int().nonnegative(),
  requiredFixes: z.number().int().positive(),
  qualifyingSpanSeconds: z.number().nonnegative(),
  requiredSpanSeconds: z.number().positive()
});

export type StaffJourneyProgress = z.infer<typeof staffJourneyProgressSchema>;

export const staffLocationSampleResponseSchema = z.union([
  z.strictObject({
    accepted: z.literal(true),
    journey: staffJourneyTransitionSchema.nullable()
  }),
  z.strictObject({
    accepted: z.literal(false),
    reason: staffLocationSampleRejectionReasonSchema
  })
]);

export const riderAssignmentInputSchema = z.strictObject({
  routeId: z.string().uuid(),
  stopId: z.string().uuid()
});

const normalizedEmailSchema = z.string().trim().toLowerCase().pipe(z.email());

// ---------- Phone numbers: one format everywhere ----------
// US numbers are stored as 973-555-0123, however they were typed ("9735550123",
// "(973) 555-0123", "+1 973 555 0123"). Numbers starting with + and another
// country code are stored as +<digits>. Anything else is refused with an example.
export const PHONE_HELP = "Enter a 10-digit phone number, like 973-555-0123.";

export function formatPhone(raw: string): { ok: true; value: string | null } | { ok: false; error: string } {
  const text = raw.trim();
  if (!text) return { ok: true, value: null };
  const digits = text.replace(/\D/g, "");
  if (text.startsWith("+") && !text.startsWith("+1")) {
    return digits.length >= 8 && digits.length <= 15 ? { ok: true, value: `+${digits}` } : { ok: false, error: PHONE_HELP };
  }
  const us = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (us.length !== 10) return { ok: false, error: PHONE_HELP };
  return { ok: true, value: `${us.slice(0, 3)}-${us.slice(3, 6)}-${us.slice(6)}` };
}

/** Optional phone: blank becomes null, anything else is formatted or refused. */
export const phoneSchema = z.string().transform((value, ctx) => {
  const result = formatPhone(value);
  if (!result.ok) { ctx.addIssue({ code: "custom", message: result.error }); return z.NEVER; }
  return result.value;
});

/** Blank text means "none". */
const optionalText = (max: number, message: string) =>
  z.string().trim().max(max, message).transform((value) => value || null).nullable();

/** Care info for counselors. Each field is optional; leaving one out of an update keeps it as is. */
export const riderCareInputSchema = z.strictObject({
  careNotes: optionalText(500, "Keep care notes under 500 characters.").optional(),
  emergencyName: optionalText(120, "Keep the emergency contact name under 120 characters.").optional(),
  emergencyPhone: phoneSchema.transform((value) => value || null).nullable().optional()
});

export const riderInputSchema = z.strictObject({
  givenName: z.string().trim().min(1).max(80),
  familyName: z.string().trim().min(1).max(80),
  am: riderAssignmentInputSchema.nullable(),
  pm: riderAssignmentInputSchema.nullable(),
  guardianIds: z.array(z.string().uuid()).min(1).max(10),
  // Leaving it out keeps the rider's days as they are.
  rideDays: z.lazy(() => rideDaysSchema).optional(),
  ...riderCareInputSchema.shape
}).refine((rider) => new Set(rider.guardianIds).size === rider.guardianIds.length,
  { message: "Each guardian must be unique." });

export const guardianInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  email: normalizedEmailSchema.nullable(),
  phone: phoneSchema.nullable()
});

export const guardianSchema = z.strictObject({
  id: z.string().uuid(), name: z.string(), email: z.string().email().nullable(),
  phone: z.string().nullable(), accountStatus: z.enum(["none", "pending", "active"]),
  lastSignedIn: z.string().nullable(), importDataset: z.string().nullable()
});
export const guardiansResponseSchema = z.strictObject({ guardians: z.array(guardianSchema) });
export type Guardian = z.infer<typeof guardianSchema>;

export const riderSchema = z.strictObject({
  id: z.string().uuid(),
  imported: z.boolean(),
  givenName: z.string(),
  familyName: z.string(),
  am: z.strictObject({
    routeId: z.string().uuid(), routeName: z.string(),
    stopId: z.string().uuid(), stopLabel: z.string()
  }).nullable(),
  pm: z.strictObject({
    routeId: z.string().uuid(), routeName: z.string(),
    stopId: z.string().uuid(), stopLabel: z.string()
  }).nullable(),
  guardians: z.array(guardianSchema),
  rideDays: z.array(z.number().int().min(1).max(7)).nullable(),
  careNotes: z.string().nullable(),
  emergencyName: z.string().nullable(),
  emergencyPhone: z.string().nullable()
});

export const rosterResponseSchema = z.strictObject({ riders: z.array(riderSchema) });

/** Riders the buses will miss: no AM and no PM stop, or only one direction. */
export const riderCoverageSchema = z.strictObject({
  noRoute: z.array(z.strictObject({ id: z.string().uuid(), name: z.string() })),
  amOnly: z.number().int().nonnegative(),
  pmOnly: z.number().int().nonnegative()
});
export type RiderCoverage = z.infer<typeof riderCoverageSchema>;
export type Rider = z.infer<typeof riderSchema>;

export const addressSearchResponseSchema = z.strictObject({
  results: z.array(z.strictObject({
    label: z.string(),
    latitude: coordinateSchema.shape.latitude,
    longitude: coordinateSchema.shape.longitude,
    locationType: z.enum(["address", "place"])
  }))
});

export type AddressSearchResult =
  z.infer<typeof addressSearchResponseSchema>["results"][number];

export const familyPortalEtaSchema = z.strictObject({
  status: z.enum([
    "live",
    "aging",
    "calculating",
    "stale",
    "off-route",
    "unavailable"
  ]),
  source: z.enum(["mapbox-traffic", "live-gps"]).nullable(),
  stopEtaAt: z.string().nullable(),
  leaveAt: z.string().nullable(),
  leaveBufferMinutes: z.number().int().min(0).max(60)
});

export const familyPortalRideSchema = z.strictObject({
  riderId: z.string().uuid(),
  riderName: z.string(),
  tripId: z.string().uuid(),
  routeName: z.string(),
  servicePeriod: routeServicePeriodSchema,
  busLabel: z.string(),
  departureAt: z.string(),
  tripStatus: z.enum(["planned", "active"]),
  stop: z.strictObject({
    id: z.string().uuid(),
    label: z.string(),
    latitude: coordinateSchema.shape.latitude,
    longitude: coordinateSchema.shape.longitude,
    arrivedAt: z.string().nullable(),
    departedAt: z.string().nullable()
  }),
  location: z.strictObject({
    latitude: coordinateSchema.shape.latitude,
    longitude: coordinateSchema.shape.longitude,
    observedAt: z.string()
  }).nullable(),
  routeStops: z.array(z.strictObject({
    id: z.string().uuid(),
    position: z.number().int().positive(),
    label: z.string(),
    latitude: coordinateSchema.shape.latitude,
    longitude: coordinateSchema.shape.longitude,
    passed: z.boolean()
  })),
  eta: familyPortalEtaSchema.nullable(),
  // Not riding: the parent (or a counselor) said this kid won't be on this bus.
  riding: z.boolean(),
  ridingNote: z.string().nullable(),
  // The parent can still change it: the bus hasn't left yet.
  canChange: z.boolean(),
  /** The crew's latest "running late" or "heavy traffic" note on this trip, if any. */
  crewNotice: z.strictObject({ text: z.string(), at: z.string() }).nullable()
});

export const familyPortalResponseSchema = z.strictObject({
  rides: z.array(familyPortalRideSchema),
  leaveBufferMinutes: z.number().int().min(0).max(60)
});

/** A parent marks one kid as not riding one bus (or riding after all), before it leaves. */
export const familyRidingInputSchema = z.strictObject({ riding: z.boolean() });

export const leaveBufferInputSchema = z.strictObject({
  minutes: z.number().int().min(0).max(60)
});

export type FamilyPortalRide = z.infer<typeof familyPortalRideSchema>;

// ---------------------------------------------------------------------------
// Ride Check: per-rider check events layered on the trip_riders snapshot.
// ---------------------------------------------------------------------------

export const riderCheckStateSchema = z.enum([
  "expected",
  "aboard",
  "dropped",
  "no_show",
  "not_riding"
]);

export type RiderCheckState = z.infer<typeof riderCheckStateSchema>;

export const riderCheckEventTypeSchema = z.enum([
  "boarded",
  "dropped_off",
  "no_show",
  "not_riding",
  "undone",
  "handled"
]);

export type RiderCheckEventType = z.infer<typeof riderCheckEventTypeSchema>;

export const riderCheckActionSchema = z.strictObject({
  type: z.enum(["board", "drop", "no_show", "not_riding", "undo", "handled"]),
  // What the tapping phone saw. If someone else changed the rider since, the tap is refused
  // instead of silently overwriting them.
  expected: riderCheckStateSchema.optional(),
  // When the counselor tapped. A tap saved on the phone with no signal is sent later with its
  // real time; the server keeps it within the last 6 hours and never before the rider's last event.
  occurredAt: z.string().datetime({ offset: true }).optional()
});

export type RiderCheckAction = z.infer<typeof riderCheckActionSchema>;

/** Bulk checks only ever apply to the stop the bus is at. */
export const bulkCheckActionSchema = z.strictObject({
  type: z.enum(["board_waiting", "drop_aboard"]),
  stopId: z.string().uuid()
});

export const checkRiderSchema = z.strictObject({
  riderId: z.string().uuid(),
  givenName: z.string(),
  familyName: z.string(),
  stopId: z.string().uuid(),
  state: riderCheckStateSchema,
  stateAt: z.string().nullable(),
  stateBy: z.string().nullable(),
  boardedAt: z.string().nullable(),
  handled: z.boolean(),
  guardians: z.array(z.strictObject({
    name: z.string(),
    phone: z.string().nullable()
  })),
  careNotes: z.string().nullable(),
  emergency: z.strictObject({ name: z.string(), phone: z.string().nullable() }).nullable()
});

export type CheckRider = z.infer<typeof checkRiderSchema>;

export const checkEventSchema = z.strictObject({
  id: z.string().uuid(),
  riderId: z.string().uuid().nullable(),
  riderName: z.string().nullable(),
  kind: z.union([riderCheckEventTypeSchema, z.literal("bus_checked_empty")]),
  occurredAt: z.string(),
  recordedBy: z.string()
});

export type CheckEvent = z.infer<typeof checkEventSchema>;

export const checkTripSchema = z.strictObject({
  id: z.string().uuid(),
  busId: z.string().uuid(),
  busLabel: z.string(),
  routeName: z.string(),
  servicePeriod: routeServicePeriodSchema,
  departureAt: z.string(),
  status: z.enum(["planned", "active", "completed", "cancelled"]),
  assignedStaff: tripStaffSchema.nullable(),
  staffLastSeenAt: z.string().nullable(),
  stops: z.array(z.strictObject({
    id: z.string().uuid(),
    position: z.number().int().positive(),
    label: z.string(),
    arrivedAt: z.string().nullable(),
    departedAt: z.string().nullable()
  })),
  sweep: z.strictObject({
    confirmedAt: z.string(),
    confirmedBy: z.string()
  }).nullable(),
  riders: z.array(checkRiderSchema),
  events: z.array(checkEventSchema)
});

export type CheckTrip = z.infer<typeof checkTripSchema>;

export const checkBoardResponseSchema = z.strictObject({
  trips: z.array(checkTripSchema)
});

/** A counselor's phone: Ride Check for the one trip they are on. */
export const staffCheckResponseSchema = z.strictObject({ trip: checkTripSchema.nullable() });

// ---------------------------------------------------------------------------
// Trip alerts: a counselor tells Dispatch something (an update) or calls for help (an emergency).
// ---------------------------------------------------------------------------

export const TRIP_ALERT_CHOICES = {
  update: {
    late_5: "Running 5 min late", late_10: "Running 10 min late", late_15: "Running 15+ min late",
    traffic: "Heavy traffic", bathroom: "Bathroom stop", kid_issue: "Kid issue, handling it",
    bus_problem: "Bus problem", other: "Update"
  },
  emergency: {
    accident: "Accident", medical: "Medical emergency", breakdown: "Bus broke down", other: "Emergency, call me"
  }
} as const;
export type TripAlertKind = keyof typeof TRIP_ALERT_CHOICES;
/** Updates parents also see on their bus screen. */
export const PARENT_VISIBLE_UPDATES = ["late_5", "late_10", "late_15", "traffic"] as const;

export function tripAlertLabel(kind: TripAlertKind, code: string): string {
  return (TRIP_ALERT_CHOICES[kind] as Record<string, string>)[code] ?? (kind === "emergency" ? "Emergency" : "Update");
}

export const tripAlertInputSchema = z.strictObject({
  kind: z.enum(["update", "emergency"]),
  code: z.string().regex(/^[a-z_0-9]{1,40}$/),
  note: z.string().trim().max(300, "Keep it under 300 characters.").transform((value) => value || null).nullable().optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional()
}).refine((input) => input.code in TRIP_ALERT_CHOICES[input.kind], { message: "Pick one of the choices." })
  .refine((input) => (input.latitude === undefined) === (input.longitude === undefined), { message: "Send both coordinates." });

export const tripAlertSchema = z.strictObject({
  id: z.string().uuid(),
  tripId: z.string().uuid(),
  busLabel: z.string(),
  routeName: z.string(),
  servicePeriod: routeServicePeriodSchema,
  kind: z.enum(["update", "emergency"]),
  code: z.string(),
  label: z.string(),
  note: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  sentBy: z.string(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
  resolvedBy: z.string().nullable()
});
export type TripAlert = z.infer<typeof tripAlertSchema>;
export const tripAlertsResponseSchema = z.strictObject({ alerts: z.array(tripAlertSchema) });

/** Admin's View as picker: every counselor and bus, with the trip their phone would open to. */
export const previewPeopleSchema = z.strictObject({
  counselors: z.array(z.strictObject({ id: z.string().uuid(), name: z.string(), trip: z.string().nullable() })),
  buses: z.array(z.strictObject({ id: z.string().uuid(), label: z.string(), trip: z.string().nullable(), paired: z.boolean() })),
  /** Family logins only: a guardian without a login has no screen to preview. */
  parents: z.array(z.strictObject({ id: z.string().uuid(), name: z.string(), kids: z.string(), trip: z.string().nullable() }))
});
export type PreviewPeople = z.infer<typeof previewPeopleSchema>;

// ---------------------------------------------------------------------------
// Transit: recorded trip history for review.
// ---------------------------------------------------------------------------

export const historyEventSchema = z.strictObject({
  id: z.string().uuid(),
  type: z.enum(["started", "arrived_stop", "departed_stop", "completed", "cancelled", "correction", "note"]),
  occurredAt: z.string(),
  stopLabel: z.string().nullable(),
  method: z.enum(["automatic", "manual"]).nullable(),
  replaced: z.boolean(),
  recordedBy: z.string()
});

export type HistoryEvent = z.infer<typeof historyEventSchema>;

export const historyTripSchema = z.strictObject({
  id: z.string().uuid(),
  busId: z.string().uuid(),
  busLabel: z.string(),
  routeName: z.string(),
  servicePeriod: routeServicePeriodSchema,
  departureAt: z.string(),
  status: z.enum(["planned", "active", "completed", "cancelled"]),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  // assignedStaff is the lead counselor.
  assignedStaff: tripStaffSchema.nullable(),
  driver: tripDriverSchema.nullable(),
  counselors: z.array(tripStaffSchema),
  stops: z.array(z.strictObject({
    id: z.string().uuid(),
    position: z.number().int().positive(),
    label: z.string(),
    arrivedAt: z.string().nullable(),
    departedAt: z.string().nullable(),
    arrivalMethod: arrivalMethodSchema.nullable(),
    departureMethod: z.enum(["automatic", "manual"]).nullable()
  })),
  events: z.array(historyEventSchema),
  /** Updates and emergencies the crew sent from the bus. */
  alerts: z.array(z.strictObject({
    kind: z.enum(["update", "emergency"]), label: z.string(), note: z.string().nullable(),
    sentBy: z.string(), createdAt: z.string(), resolvedAt: z.string().nullable(), resolvedBy: z.string().nullable()
  })),
  /** Ride Check, totalled: who rode, who didn't, and anyone never accounted for. */
  riders: z.strictObject({
    total: z.number().int().nonnegative(),
    rode: z.number().int().nonnegative(),
    noShow: z.number().int().nonnegative(),
    notRiding: z.number().int().nonnegative(),
    unchecked: z.number().int().nonnegative(),
    stillAboard: z.number().int().nonnegative(),
    sweptAt: z.string().nullable()
  }),
  gps: z.strictObject({
    samples: z.number().int().nonnegative(),
    lastObservedAt: z.string().nullable(),
    gaps: z.array(z.strictObject({
      startedAt: z.string(),
      resumedAt: z.string(),
      durationSeconds: z.number().int().positive()
    }))
  })
});

export type HistoryTrip = z.infer<typeof historyTripSchema>;

export const historyResponseSchema = z.strictObject({
  trips: z.array(historyTripSchema)
});

// ---------------------------------------------------------------------------
// Admin reset: wipes operational data, keeps admin logins and tenant identity.
// ---------------------------------------------------------------------------

export const RESET_CONFIRMATION = "RESET";

export const adminResetInputSchema = z.strictObject({
  confirm: z.literal(RESET_CONFIRMATION)
});

export const adminResetCountsSchema = z.strictObject({
  buses: z.number().int().nonnegative(),
  routes: z.number().int().nonnegative(),
  trips: z.number().int().nonnegative(),
  riders: z.number().int().nonnegative(),
  guardians: z.number().int().nonnegative(),
  members: z.number().int().nonnegative(),
  gpsSamples: z.number().int().nonnegative(),
  keptAdmins: z.number().int().nonnegative()
});

export type AdminResetCounts = z.infer<typeof adminResetCountsSchema>;

// ---------------------------------------------------------------------------
// Family messages: an admin writes, guardians read them in the family portal.
// ---------------------------------------------------------------------------

export const MESSAGE_MAX_LENGTH = 1000;
export const messageAudienceSchema = z.enum(["all", "route", "trip", "rider"]);
export type MessageAudience = z.infer<typeof messageAudienceSchema>;

/** Who a message goes to: everyone, one line (AM and PM), one trip, or a custom list of kids' guardians. */
export const messageTargetSchema = z.discriminatedUnion("audience", [
  z.strictObject({ audience: z.literal("all") }),
  z.strictObject({ audience: z.literal("route"), routeFamilyId: z.string().uuid() }),
  z.strictObject({ audience: z.literal("trip"), tripId: z.string().uuid() }),
  z.strictObject({ audience: z.literal("rider"), riderIds: z.array(z.string().uuid()).min(1).max(500) })
]);
export type MessageTarget = z.infer<typeof messageTargetSchema>;

export const sendMessageInputSchema = z.strictObject({
  target: messageTargetSchema,
  body: z.string().trim().min(1).max(MESSAGE_MAX_LENGTH)
});

export const messageReachSchema = z.strictObject({
  label: z.string(),
  guardians: z.number().int().nonnegative(),
  withLogin: z.number().int().nonnegative()
});
export type MessageReach = z.infer<typeof messageReachSchema>;

export const sentMessageSchema = z.strictObject({
  id: z.string().uuid(),
  body: z.string(),
  audience: messageAudienceSchema,
  audienceLabel: z.string(),
  sentBy: z.string(),
  sentAt: z.string(),
  retractedAt: z.string().nullable(),
  guardians: z.number().int().nonnegative(),
  withLogin: z.number().int().nonnegative(),
  readBy: z.number().int().nonnegative()
});
export type SentMessage = z.infer<typeof sentMessageSchema>;
export const sentMessagesResponseSchema = z.strictObject({ messages: z.array(sentMessageSchema) });

export const familyMessageSchema = z.strictObject({
  id: z.string().uuid(),
  body: z.string(),
  audienceLabel: z.string(),
  sentAt: z.string(),
  read: z.boolean()
});
export type FamilyMessage = z.infer<typeof familyMessageSchema>;
export const familyMessagesResponseSchema = z.strictObject({ messages: z.array(familyMessageSchema) });

// ---------- Data mode: every table as a plain grid (admin) ----------
export const dataTableKeySchema = z.enum(["riders", "guardians", "drivers", "buses", "routes", "stops", "members"]);
export type DataTableKey = z.infer<typeof dataTableKeySchema>;
export const dataTablesResponseSchema = z.strictObject({
  tables: z.array(z.strictObject({ key: dataTableKeySchema, label: z.string(), count: z.number().int().nonnegative() }))
});
export const dataCellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type DataCell = z.infer<typeof dataCellSchema>;
// How a column can be edited in the grid. null = read-only.
// choice: pick from `options`. number: whole number. pin: "latitude, longitude".
export const dataEditKindSchema = z.enum(["text", "email", "phone", "stop-AM", "stop-PM", "choice", "number", "pin"]).nullable();
export type DataEditKind = z.infer<typeof dataEditKindSchema>;
export const dataColumnSchema = z.strictObject({
  key: z.string(), label: z.string(), edit: dataEditKindSchema,
  options: z.array(z.string()).optional()
});
export type DataColumn = z.infer<typeof dataColumnSchema>;
export const dataRowSchema = z.strictObject({
  id: z.string(),
  cells: z.record(z.string(), dataCellSchema),
  // Why this row can't be edited here (for example, it came from a roster file). null = editable.
  locked: z.string().nullable()
});
export type DataRow = z.infer<typeof dataRowSchema>;
export const dataTableResponseSchema = z.strictObject({
  key: dataTableKeySchema,
  label: z.string(),
  columns: z.array(dataColumnSchema),
  rows: z.array(dataRowSchema)
});
export type DataTable = z.infer<typeof dataTableResponseSchema>;

// One cell edit. "from" is what the grid showed, so a change made by someone else
// in the meantime is caught instead of silently overwritten.
export const dataEditSchema = z.strictObject({
  column: z.string().min(1).max(40),
  from: z.string().max(500),
  value: z.string().max(500)
});
export type DataEdit = z.infer<typeof dataEditSchema>;
export const dataEditResponseSchema = z.strictObject({ row: dataRowSchema });

// Add a driver from Data mode. Drivers are names on a trip, not logins.
export const driverInputSchema = z.strictObject({
  name: z.string().trim().min(1, "Enter the driver's name.").max(120, "Keep the name under 120 characters."),
  phone: phoneSchema
});
export type DriverInput = z.input<typeof driverInputSchema>;

/** A driver on the Team page. Drivers never sign in: a name and a phone on each trip. */
export const teamDriverSchema = z.strictObject({
  id: z.string().uuid(),
  name: z.string(),
  phone: z.string().nullable(),
  active: z.boolean(),
  /** Trips they're on in the next 7 days, soonest first. */
  upcoming: z.array(z.strictObject({ tripId: z.string().uuid(), routeName: z.string(), busLabel: z.string(), departureAt: z.string() }))
});
export type TeamDriver = z.infer<typeof teamDriverSchema>;
export const teamDriversResponseSchema = z.strictObject({ drivers: z.array(teamDriverSchema) });
export const driverStatusInputSchema = z.strictObject({ active: z.boolean() });

// Choices for the AM and PM stop dropdowns: active routes only.
export const dataStopOptionSchema = z.strictObject({ value: z.string(), label: z.string() });
export const dataStopOptionsResponseSchema = z.strictObject({
  AM: z.array(dataStopOptionSchema),
  PM: z.array(dataStopOptionSchema)
});

// ---------- Data mode: roster CSV import (admin) ----------
// The file is read in the browser and sent as plain rows. The server answers with a
// preview of every change; nothing is written until the same file is sent to apply.
export const rosterImportInputSchema = z.strictObject({
  headers: z.array(z.string().max(80)).min(1).max(80),
  rows: z.array(z.array(z.string().max(500)).max(80)).max(5000),
  // From the preview. Apply refuses if the plan no longer matches what was previewed.
  token: z.string().max(100).optional()
});
export type RosterImportInput = z.infer<typeof rosterImportInputSchema>;
export const rosterImportItemSchema = z.strictObject({
  line: z.number().int(),
  rider: z.string(),
  kind: z.enum(["new", "update", "same", "skip", "error"]),
  changes: z.array(z.string()),
  error: z.string().nullable()
});
export type RosterImportItem = z.infer<typeof rosterImportItemSchema>;
export const rosterImportPreviewSchema = z.strictObject({
  items: z.array(rosterImportItemSchema),
  counts: z.strictObject({
    new: z.number().int(), update: z.number().int(), same: z.number().int(),
    skip: z.number().int(), error: z.number().int(), newGuardians: z.number().int()
  }),
  missingColumns: z.array(z.string()),
  token: z.string()
});
export type RosterImportPreview = z.infer<typeof rosterImportPreviewSchema>;
export const rosterImportResultSchema = z.strictObject({
  applied: z.number().int(), created: z.number().int(), updated: z.number().int(), newGuardians: z.number().int()
});
export type RosterImportResult = z.infer<typeof rosterImportResultSchema>;

// ---------- Bus trackers: a phone mounted on a bus that signs in as the bus ----------
export const pairCodeResponseSchema = z.strictObject({
  code: z.string().regex(/^\d{6}$/),
  expiresAt: z.string(),
  busLabel: z.string()
});
export type PairCodeResponse = z.infer<typeof pairCodeResponseSchema>;

export const pairDeviceInputSchema = z.strictObject({
  code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from Fleet.")
});

export const deviceMeResponseSchema = z.strictObject({
  bus: z.strictObject({ id: z.string().uuid(), label: z.string() }),
  tenant: z.string()
});
export type DeviceMe = z.infer<typeof deviceMeResponseSchema>;

export const trackerSchema = z.strictObject({
  busId: z.string().uuid(),
  pairedAt: z.string(),
  lastSeenAt: z.string().nullable()
});
export type Tracker = z.infer<typeof trackerSchema>;
export const trackersResponseSchema = z.strictObject({ trackers: z.array(trackerSchema) });

// ---------- Reports ----------
// Every report has the same shape, so one preview, one print layout and one CSV
// export serve them all: a title, summary numbers, then titled tables.
export const reportKeySchema = z.enum(["run-sheet", "attendance", "trip-times", "crew", "riders"]);
export type ReportKey = z.infer<typeof reportKeySchema>;
export const reportCellSchema = z.union([z.string(), z.number(), z.null()]);
export const reportSchema = z.strictObject({
  key: reportKeySchema,
  title: z.string(),
  period: z.string(),
  generatedAt: z.string(),
  summary: z.array(z.strictObject({ label: z.string(), value: z.string(), tone: z.enum(["good", "bad"]).nullable() })),
  sections: z.array(z.strictObject({
    heading: z.string(),
    note: z.string().nullable(),
    // A new printed page starts at this section (one page per day on week and month sheets).
    pageBreak: z.boolean(),
    columns: z.array(z.strictObject({ key: z.string(), label: z.string(), numeric: z.boolean() })),
    rows: z.array(z.record(z.string(), reportCellSchema))
  }))
});
export type Report = z.infer<typeof reportSchema>;

// Visualize: the numbers behind the Reports dashboard, one period at a time.
export const insightsSchema = z.strictObject({
  period: z.string(),
  days: z.array(z.strictObject({
    day: z.string(),            // YYYY-MM-DD in the viewer's zone
    label: z.string(),          // "Mon 26"
    trips: z.number().int(),
    rode: z.number().int(),
    noShow: z.number().int(),
    notRiding: z.number().int(),
    unchecked: z.number().int(),
    avgLength: z.number().nullable(), // minutes, finished trips only
    departed: z.number().int(),
    onTime: z.number().int()
  })),
  totals: z.strictObject({
    trips: z.number().int(), ran: z.number().int(), rode: z.number().int(), noShow: z.number().int(),
    notRiding: z.number().int(), uniqueRiders: z.number().int(), attendance: z.number().nullable(),
    onTime: z.number().nullable(), avgLength: z.number().nullable(), avgLate: z.number().nullable(), missingLead: z.number().int()
  }),
  lateness: z.array(z.strictObject({ label: z.string(), count: z.number().int() })),
  routes: z.array(z.strictObject({ route: z.string(), seats: z.number().int(), rode: z.number().int() })),
  leads: z.array(z.strictObject({ name: z.string(), trips: z.number().int() })),
  headsUp: z.array(z.strictObject({ tone: z.enum(["bad", "warn", "good"]), title: z.string(), text: z.string() }))
});
export type Insights = z.infer<typeof insightsSchema>;

// Build your own: the raw rows for one dataset, and saved report settings.
export const buildDatasetSchema = z.enum(["trips", "rides", "riders"]);
export type BuildDataset = z.infer<typeof buildDatasetSchema>;
export const buildFieldSchema = z.strictObject({
  key: z.string(), label: z.string(),
  // number fields can be totaled; "avg" ones (minutes late, trip length) are averaged instead.
  kind: z.enum(["text", "number"]), total: z.enum(["sum", "avg"]).nullable()
});
export type BuildField = z.infer<typeof buildFieldSchema>;
export const buildDataSchema = z.strictObject({
  dataset: buildDatasetSchema,
  fields: z.array(buildFieldSchema),
  rows: z.array(z.record(z.string(), reportCellSchema))
});
export type BuildData = z.infer<typeof buildDataSchema>;
export const reportDefinitionSchema = z.strictObject({
  dataset: buildDatasetSchema,
  columns: z.array(z.string()).min(1).max(20),
  filters: z.array(z.strictObject({ field: z.string(), values: z.array(z.string()).max(200) })).max(10),
  layout: z.enum(["list", "totals"]),
  groupBy: z.string().nullable(),
  sortBy: z.string().nullable(),
  sortDir: z.enum(["asc", "desc"])
});
export type ReportDefinition = z.infer<typeof reportDefinitionSchema>;
export const savedReportSchema = z.strictObject({
  id: z.string().uuid(), name: z.string(), definition: reportDefinitionSchema, createdBy: z.string(), updatedAt: z.string()
});
export type SavedReport = z.infer<typeof savedReportSchema>;
export const savedReportsResponseSchema = z.strictObject({ reports: z.array(savedReportSchema) });
export const saveReportInputSchema = z.strictObject({
  name: z.string().trim().min(1, "Give the report a name.").max(80, "Keep the name under 80 characters."),
  definition: reportDefinitionSchema
});

// ---------------------------------------------------------------------------
// Repeating trips: "Bus 1 runs ALPHA AM at 8:00, Mon to Fri, all summer, with this crew".
// Bussin builds the real trips two weeks ahead. Weekdays are ISO: 1 = Monday ... 7 = Sunday.
// ---------------------------------------------------------------------------

export const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
/** The camp's clock. Trip times and weekdays are worked out in this zone. */
export const CAMP_TIME_ZONE = "America/New_York";

/** "Mon to Fri", "Mon, Wed, Fri", "Every day". Null (no limit) is every day. */
export function weekdaysLabel(days: readonly number[] | null) {
  if (!days || days.length >= 7) return "Every day";
  const sorted = [...days].sort((a, b) => a - b);
  const run = sorted.every((day, index) => index === 0 || day === sorted[index - 1]! + 1);
  if (run && sorted.length >= 3) return `${WEEKDAY_NAMES[sorted[0]! - 1]} to ${WEEKDAY_NAMES[sorted.at(-1)! - 1]}`;
  return sorted.map((day) => WEEKDAY_NAMES[day - 1]).join(", ");
}

/** A kid's ride days: null = every day. Six days or fewer, each once, in order. */
export const rideDaysSchema = z.array(z.number().int().min(1).max(7)).min(1, "Pick at least one day.").max(7)
  .nullable()
  .transform((days) => days ? [...new Set(days)].sort((a, b) => a - b) : null)
  .transform((days) => days && days.length === 7 ? null : days);

const DAY_WORDS: Record<string, number> = {
  mo: 1, mon: 1, monday: 1, tu: 2, tue: 2, tues: 2, tuesday: 2, we: 3, wed: 3, wednesday: 3,
  th: 4, thu: 4, thur: 4, thurs: 4, thursday: 4, fr: 5, fri: 5, friday: 5,
  sa: 6, sat: 6, saturday: 6, su: 7, sun: 7, sunday: 7
};

/**
 * Ride days typed in a spreadsheet: "Mon Wed Fri", "Mon, Tue", "Mon-Thu", "Mon to Fri".
 * Blank, "every day" or "all" means every day (null).
 */
export function parseRideDays(text: string): { ok: true; days: number[] | null } | { ok: false; error: string } {
  const value = text.trim().toLowerCase();
  if (!value || ["every day", "everyday", "all", "daily", "all days"].includes(value)) return { ok: true, days: null };
  const days: number[] = [];
  const parts = value.replace(/\s+(to|through|thru)\s+/g, "-").replace(/\s*-\s*/g, "-").split(/[\s,;/&]+|\band\b/).filter(Boolean);
  for (const part of parts) {
    const [from, to, extra] = part.split("-");
    const start = DAY_WORDS[from!.replace(/\.$/, "")];
    const end = to === undefined ? start : DAY_WORDS[to.replace(/\.$/, "")];
    if (!start || !end || extra !== undefined) return { ok: false, error: `"${text.trim()}" isn't a list of days. Use something like Mon Wed Fri or Mon-Thu.` };
    if (end < start) return { ok: false, error: `"${part}" runs backwards. Write it Monday first, like Mon-Fri.` };
    for (let day = start; day <= end; day += 1) days.push(day);
  }
  const parsed = rideDaysSchema.safeParse(days);
  return parsed.success ? { ok: true, days: parsed.data } : { ok: false, error: "Pick at least one day." };
}
/** How far ahead repeating trips are built. */
export const SCHEDULE_HORIZON_DAYS = 14;

const isoDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date.");
const dayNumber = (day: string) => Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) / 86_400_000;

export const tripScheduleInputSchema = z.strictObject({
  routeId: z.string().uuid("Pick a route."),
  busId: z.string().uuid("Pick a bus."),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1, "Pick at least one day.").max(7),
  departTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Pick a time it leaves."),
  startsOn: isoDaySchema,
  endsOn: isoDaySchema,
  crew: assignTripCrewSchema
}).refine((input) => new Set(input.weekdays).size === input.weekdays.length, { message: "Each day only once." })
  .refine((input) => input.endsOn >= input.startsOn, { message: "The last day must be on or after the first day." })
  .refine((input) => dayNumber(input.endsOn) - dayNumber(input.startsOn) <= 366, { message: "Keep it to one year or less." });
export type TripScheduleInput = z.infer<typeof tripScheduleInputSchema>;

export const tripScheduleSchema = z.strictObject({
  id: z.string().uuid(),
  routeId: z.string().uuid(),
  routeName: z.string(),
  servicePeriod: routeServicePeriodSchema,
  routeUsable: z.boolean(),
  busId: z.string().uuid(),
  busLabel: z.string(),
  weekdays: z.array(z.number().int().min(1).max(7)),
  departTime: z.string(),
  startsOn: z.string(),
  endsOn: z.string(),
  lead: tripStaffSchema.nullable(),
  counselors: z.array(tripStaffSchema),
  driver: tripDriverSchema.nullable(),
  stoppedAt: z.string().nullable(),
  upcoming: z.number().int().nonnegative(),
  nextDepartureAt: z.string().nullable()
});
export type TripSchedule = z.infer<typeof tripScheduleSchema>;
export const tripSchedulesResponseSchema = z.strictObject({ schedules: z.array(tripScheduleSchema) });

/** A day that couldn't be built (bus already booked, route has no stops) and why. */
export const scheduleSkipSchema = z.strictObject({ day: z.string(), reason: z.string() });
export const tripScheduleSaveResponseSchema = z.strictObject({
  schedule: tripScheduleSchema,
  built: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  skipped: z.array(scheduleSkipSchema)
});

// ---------------------------------------------------------------------------
// Phone alerts (Web Push) for parents: bus left, about 10 minutes away, at your stop.
// ---------------------------------------------------------------------------

export const pushKeyResponseSchema = z.strictObject({ publicKey: z.string().nullable() });
export const pushSubscribeInputSchema = z.object({
  endpoint: z.string().url().startsWith("https://").max(1000),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) })
});
export const pushUnsubscribeInputSchema = z.strictObject({ endpoint: z.string().max(1000) });

// ---------------------------------------------------------------------------
// Lines: a route family seen as one thing. Its morning route, its afternoon route,
// the repeating trips that run them, and the kids on it. Most camp lines are shuttles:
// one place to get on, one place to get off.
// ---------------------------------------------------------------------------

export const LINE_COLORS = ["#d9622b", "#2f6fd0", "#11704a", "#8442a1", "#b8860b", "#148783", "#c14345", "#4b5563"] as const;

const lineColorSchema = z.string().regex(/^#[0-9a-f]{6}$/, "Pick a color.");

export const lineDirectionSchema = z.strictObject({
  routeId: z.string().uuid(),
  routeName: z.string(),
  active: z.boolean(),
  stops: z.array(z.strictObject({ id: z.string().uuid(), label: z.string() })),
  schedules: z.array(tripScheduleSchema)
});
export type LineDirection = z.infer<typeof lineDirectionSchema>;

export const lineSchema = z.strictObject({
  id: z.string().uuid(),
  name: z.string(),
  color: lineColorSchema,
  am: lineDirectionSchema.nullable(),
  pm: lineDirectionSchema.nullable(),
  kids: z.number().int().nonnegative(),
  partWeek: z.number().int().nonnegative()
});
export type Line = z.infer<typeof lineSchema>;
export const linesResponseSchema = z.strictObject({ lines: z.array(lineSchema) });

const placeInputSchema = z.strictObject({
  label: z.string().trim().min(1, "Name both places.").max(120),
  latitude: coordinateSchema.shape.latitude,
  longitude: coordinateSchema.shape.longitude
});

/** A new shuttle line: two places, one bus, a morning and an afternoon time, the days and the crew. */
export const lineCreateInputSchema = z.strictObject({
  name: z.string().trim().min(1, "Give the line a name.").max(60),
  color: lineColorSchema,
  from: placeInputSchema,
  to: placeInputSchema,
  busId: z.string().uuid("Pick a bus."),
  morningTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),
  afternoonTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1, "Pick at least one day.").max(7),
  startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick the first day."),
  endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick the last day."),
  crew: assignTripCrewSchema
}).refine((input) => input.morningTime || input.afternoonTime, { message: "Give a morning time, an afternoon time, or both." })
  .refine((input) => input.endsOn >= input.startsOn, { message: "The last day must be on or after the first day." })
  .refine((input) => input.from.label.toLowerCase() !== input.to.label.toLowerCase(), { message: "The two places need different names." });
export type LineCreateInput = z.infer<typeof lineCreateInputSchema>;

export const lineColorInputSchema = z.strictObject({ color: lineColorSchema });

/** Places already on a route, to pick from instead of typing coordinates again. */
export const knownPlacesResponseSchema = z.strictObject({
  places: z.array(z.strictObject({ label: z.string(), latitude: z.number(), longitude: z.number() }))
});

// ---------------------------------------------------------------------------
// Typed times: "634am", "6:34", "634p", "6p", "1830", "noon". Returns "HH:MM" (24 h) or null.
// No am/pm: 1 to 5 means afternoon, 6 to 11 morning, 12 noon, 0 and 13 to 23 are 24-hour.
// That matches a camp day; the screen always shows what it understood.
// ---------------------------------------------------------------------------

export function parseTypedTime(text: string): string | null {
  const value = text.trim().toLowerCase().replace(/\./g, "").replace(/\s+/g, "");
  if (!value) return null;
  if (value === "noon") return "12:00";
  if (value === "midnight") return "00:00";
  const match = value.match(/^(\d{1,4})(?::(\d{2}))?(am|a|pm|p)?$/);
  if (!match) return null;
  let digits = match[1]!;
  let minutes = match[2];
  if (minutes === undefined) {
    if (digits.length <= 2) minutes = "00";
    else { minutes = digits.slice(-2); digits = digits.slice(0, -2); }
  } else if (digits.length > 2) return null;
  let hour = Number(digits);
  const minute = Number(minutes);
  if (minute > 59) return null;
  const suffix = match[3];
  if (suffix) {
    if (hour < 1 || hour > 12) return null;
    const pm = suffix.startsWith("p");
    hour = pm ? (hour === 12 ? 12 : hour + 12) : (hour === 12 ? 0 : hour);
  } else {
    if (hour > 23) return null;
    // A leading zero ("0130") means the 24-hour clock was meant: leave it in the morning.
    if (hour >= 1 && hour <= 5 && !match[1]!.startsWith("0")) hour += 12;
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** "06:34" -> "6:34 AM" */
export function timeLabel(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** Set up (or change) a line in one form: bus, both times, days, season, crew. Blank time = that run doesn't repeat. */
export const lineSetupInputSchema = z.strictObject({
  busId: z.string().uuid("Pick a bus."),
  morningTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),
  afternoonTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1, "Pick at least one day.").max(7),
  startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick the first day."),
  endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick the last day."),
  crew: assignTripCrewSchema
}).refine((input) => input.endsOn >= input.startsOn, { message: "The last day must be on or after the first day." });
export type LineSetupInput = z.infer<typeof lineSetupInputSchema>;

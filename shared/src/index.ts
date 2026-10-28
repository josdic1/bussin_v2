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
  email: z.string().trim().toLowerCase().pipe(z.email("That email doesn't look right.")).nullable()
});
export const staffStatusInputSchema = z.strictObject({ suspended: z.boolean() });
export const staffPasswordResetSchema = z.strictObject({ temporaryPassword: z.string() });

export const createStaffMemberSchema = z.strictObject({
  displayName: z.string().trim().min(1).max(120),
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,32}$/),
  email: z.string().trim().toLowerCase().email().nullable(),
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
  displayName: z.string()
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
  createdAt: z.string()
});

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

export const tripActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("start") }),
  z.strictObject({ type: z.literal("arrive"), stopId: z.string().uuid() }),
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
  arrivalMethod: z.enum(["automatic", "manual"]).nullable(),
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
  arrivalMethod: z.enum(["automatic", "manual"]).nullable(),
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

export const riderInputSchema = z.strictObject({
  givenName: z.string().trim().min(1).max(80),
  familyName: z.string().trim().min(1).max(80),
  am: riderAssignmentInputSchema.nullable(),
  pm: riderAssignmentInputSchema.nullable(),
  guardianIds: z.array(z.string().uuid()).min(1).max(10)
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
  guardians: z.array(guardianSchema)
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
  eta: familyPortalEtaSchema.nullable()
});

export const familyPortalResponseSchema = z.strictObject({
  rides: z.array(familyPortalRideSchema),
  leaveBufferMinutes: z.number().int().min(0).max(60)
});

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
  expected: riderCheckStateSchema.optional()
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
  }))
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
    arrivalMethod: z.enum(["automatic", "manual"]).nullable(),
    departureMethod: z.enum(["automatic", "manual"]).nullable()
  })),
  events: z.array(historyEventSchema),
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

/** Who a message goes to: everyone, one route (AM and PM), one trip, or one child's guardians. */
export const messageTargetSchema = z.discriminatedUnion("audience", [
  z.strictObject({ audience: z.literal("all") }),
  z.strictObject({ audience: z.literal("route"), routeFamilyId: z.string().uuid() }),
  z.strictObject({ audience: z.literal("trip"), tripId: z.string().uuid() }),
  z.strictObject({ audience: z.literal("rider"), riderId: z.string().uuid() })
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

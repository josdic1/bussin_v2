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

export const staffMemberSchema = z.strictObject({
  id: z.string().uuid(),
  displayName: z.string(),
  username: z.string(),
  email: z.string().email().nullable(),
  passwordChangeRequired: z.boolean(),
  suspended: z.boolean()
});

export const staffMembersResponseSchema = z.strictObject({
  staff: z.array(staffMemberSchema)
});

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

export const dispatchStaffResponseSchema = z.strictObject({
  staff: z.array(tripStaffSchema)
});

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
  stops: z.array(staffTripStopSchema)
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
  "poor_accuracy"
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
  phone: z.string().trim().min(1).max(40).nullable()
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
  type: z.enum(["board", "drop", "no_show", "not_riding", "undo", "handled"])
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
  assignedStaff: tripStaffSchema.nullable(),
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

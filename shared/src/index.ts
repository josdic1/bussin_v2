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

export const createRouteSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
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
  stops: z.array(
    createRouteSchema.shape.stops.element.extend({
      id: z.string().uuid().optional()
    })
  ).min(1).max(100)
});

export const routeSchema = z.strictObject({
  id: z.string().uuid(),
  name: z.string(),
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

export const plannedTripSchema = z.strictObject({
  id: z.string().uuid(),
  routeId: z.string().uuid(),
  routeName: z.string(),
  busId: z.string().uuid(),
  busLabel: z.string(),
  departureAt: z.string(),
  status: z.enum(["planned", "active", "completed", "cancelled"]),
  stopCount: z.number().int().nonnegative()
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
  departedAt: z.string().nullable()
});

export const boardLocationSchema = coordinateSchema.extend({
  observedAt: z.string(),
  accuracyM: z.number().positive()
});

export const boardTripSchema = plannedTripSchema.extend({
  stops: z.array(boardStopSchema),
  location: boardLocationSchema.nullable()
});

export const boardResponseSchema = z.strictObject({
  trips: z.array(boardTripSchema)
});

export type BoardTrip = z.infer<typeof boardTripSchema>;

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

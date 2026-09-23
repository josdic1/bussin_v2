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
  member: signedInMemberSchema
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

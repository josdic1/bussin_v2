import { z } from "zod";

export const coordinateSchema = z.strictObject({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180)
});

export type Coordinate = z.infer<typeof coordinateSchema>;

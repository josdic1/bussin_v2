import { Router } from "express";
import { busSchema, busesResponseSchema, createBusSchema } from "@bussin/shared";
import { requireRole, requireSameOrigin } from "../auth/guard.js";
import { pool } from "../db/pool.js";

export const fleetRoutes = Router();

type BusRow = {
  id: string;
  label: string;
  active: boolean;
  createdAt: Date;
};

fleetRoutes.get("/buses", requireRole("admin", "dispatch"), async (_request, response) => {
  const result = await pool.query<BusRow>(
    `SELECT id, label, active, created_at AS "createdAt"
     FROM buses
     ORDER BY label, id`
  );

  response.json(busesResponseSchema.parse({
    buses: result.rows.map((bus) => ({
      ...bus,
      createdAt: bus.createdAt.toISOString()
    }))
  }));
});

fleetRoutes.post(
  "/buses",
  requireSameOrigin,
  requireRole("admin"),
  async (request, response) => {
    const parsed = createBusSchema.safeParse(request.body);

    if (!parsed.success) {
      response.status(400).json({ error: "Enter a bus name (up to 80 characters)" });
      return;
    }

    try {
      const result = await pool.query<BusRow>(
        `INSERT INTO buses (label)
         VALUES ($1)
         RETURNING id, label, active, created_at AS "createdAt"`,
        [parsed.data.label]
      );

      response.status(201).json(busSchema.parse({
        ...result.rows[0],
        createdAt: result.rows[0].createdAt.toISOString()
      }));
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      ) {
        response.status(409).json({ error: "A bus with that name already exists" });
        return;
      }
      throw error;
    }
  }
);

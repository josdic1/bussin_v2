import { Router } from "express";
import { z } from "zod";
import { busActiveInputSchema, busDetailsInputSchema, busSchema, busesResponseSchema, createBusSchema } from "@bussin/shared";
import { requireRole, requireSameOrigin } from "../auth/guard.js";
import { pool } from "../db/pool.js";

// Buses: the name everyone uses, plus what the office keeps on file (plate, company,
// seats, inspection and insurance dates). "Usual driver" is worked out from the last
// 30 days of trips, so nobody has to keep it up to date.

export const fleetRoutes = Router();
const idSchema = z.string().uuid();

type BusRow = {
  id: string; label: string; active: boolean; createdAt: Date;
  plate: string | null; company: string | null; seats: number | null;
  inspectionDue: string | null; insuranceExpires: string | null; notes: string | null; usualDriver: string | null;
};

const BUS_SELECT = `
  SELECT b.id, b.label, b.active, b.created_at AS "createdAt", b.plate, b.company, b.seats::int AS seats,
         to_char(b.inspection_due, 'YYYY-MM-DD') AS "inspectionDue",
         to_char(b.insurance_expires, 'YYYY-MM-DD') AS "insuranceExpires", b.notes,
         (SELECT d.name FROM trip_driver_assignments a
            JOIN trips t ON t.id = a.trip_id
            JOIN drivers d ON d.id = a.driver_id
           WHERE t.bus_id = b.id AND t.departure_at > now() - interval '30 days'
           GROUP BY d.id, d.name ORDER BY count(*) DESC, d.name LIMIT 1) AS "usualDriver"
    FROM buses b`;

const toBus = (row: BusRow) => busSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });
const taken = (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "23505";

async function readBus(id: string) {
  const result = await pool.query<BusRow>(`${BUS_SELECT} WHERE b.id = $1`, [id]);
  return result.rows[0] ? toBus(result.rows[0]) : null;
}

fleetRoutes.get("/buses", requireRole("admin", "dispatch"), async (_request, response) => {
  const result = await pool.query<BusRow>(`${BUS_SELECT} ORDER BY b.label, b.id`);
  response.json(busesResponseSchema.parse({ buses: result.rows.map(toBus) }));
});

fleetRoutes.post("/buses", requireSameOrigin, requireRole("admin"), async (request, response) => {
  const parsed = createBusSchema.safeParse(request.body);
  if (!parsed.success) { response.status(400).json({ error: "Enter a bus name (up to 80 characters)" }); return; }
  try {
    const created = await pool.query<{ id: string }>(`INSERT INTO buses (label) VALUES ($1) RETURNING id`, [parsed.data.label]);
    response.status(201).json(await readBus(created.rows[0]!.id));
  } catch (error) {
    if (taken(error)) { response.status(409).json({ error: "A bus with that name already exists" }); return; }
    throw error;
  }
});

/** Everything on file for one bus. */
fleetRoutes.put("/buses/:id", requireSameOrigin, requireRole("admin"), async (request, response) => {
  const id = idSchema.safeParse(request.params.id);
  const input = busDetailsInputSchema.safeParse(request.body);
  if (!id.success) { response.status(400).json({ error: "Choose a bus." }); return; }
  if (!input.success) { response.status(400).json({ error: input.error.issues[0]?.message ?? "Check the form." }); return; }
  const bus = input.data;
  try {
    const updated = await pool.query(
      `UPDATE buses SET label = $2, plate = $3, company = $4, seats = $5, inspection_due = $6, insurance_expires = $7, notes = $8
        WHERE id = $1`,
      [id.data, bus.label, bus.plate, bus.company, bus.seats, bus.inspectionDue, bus.insuranceExpires, bus.notes]);
    if (!updated.rowCount) { response.status(404).json({ error: "Bus not found." }); return; }
    response.json(await readBus(id.data));
  } catch (error) {
    if (taken(error)) { response.status(409).json({ error: "Another bus already has that name." }); return; }
    throw error;
  }
});

/** Out of service (sold, in the shop for the summer) or back in service. Its history stays. */
fleetRoutes.post("/buses/:id/active", requireSameOrigin, requireRole("admin"), async (request, response) => {
  const id = idSchema.safeParse(request.params.id);
  const input = busActiveInputSchema.safeParse(request.body);
  if (!id.success || !input.success) { response.status(400).json({ error: "Choose a bus." }); return; }
  if (!input.data.active) {
    const running = await pool.query("SELECT 1 FROM trips WHERE bus_id = $1 AND status = 'active'", [id.data]);
    if (running.rowCount) { response.status(409).json({ error: "This bus is on the road right now. Take it out of service after the trip." }); return; }
  }
  const updated = await pool.query("UPDATE buses SET active = $2 WHERE id = $1", [id.data, input.data.active]);
  if (!updated.rowCount) { response.status(404).json({ error: "Bus not found." }); return; }
  response.json(await readBus(id.data));
});

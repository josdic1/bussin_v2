import { Router } from "express";
import { adminResetCountsSchema, adminResetInputSchema } from "@bussin/shared";
import { currentMember, requireRole, requireSameOrigin } from "../auth/guard.js";
import { pool } from "../db/pool.js";
import { resetAllButAdmins, resetCounts } from "./reset.js";

export const adminRoutes = Router();

/** What a reset would delete right now, shown before the admin confirms. */
adminRoutes.get("/reset", requireRole("admin"), async (_request, response) => {
  const client = await pool.connect();
  try {
    response.json(adminResetCountsSchema.parse(await resetCounts(client)));
  } finally {
    client.release();
  }
});

adminRoutes.post("/reset", requireSameOrigin, requireRole("admin"), async (request, response) => {
  const parsed = adminResetInputSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Type RESET to confirm." });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const removed = await resetAllButAdmins(client);
    await client.query("COMMIT");
    console.warn(`Reset by ${currentMember(response).display_name}: removed ${JSON.stringify(removed)}`);
    response.json(adminResetCountsSchema.parse(removed));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
});

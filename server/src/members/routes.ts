import { Router } from "express";
import {
  createStaffMemberSchema,
  staffMemberSchema,
  staffMembersResponseSchema
} from "@bussin/shared";
import { requireRole, requireSameOrigin } from "../auth/guard.js";
import { hashPassword } from "../auth/sessions.js";
import { pool } from "../db/pool.js";

export const memberRoutes = Router();

type StaffRow = {
  id: string;
  displayName: string;
  username: string;
  email: string | null;
  passwordChangeRequired: boolean;
  suspended: boolean;
};

memberRoutes.get("/", requireRole("admin"), async (_request, response) => {
  const result = await pool.query<StaffRow>(
    `SELECT m.id,
            m.display_name AS "displayName",
            m.username,
            m.email,
            m.password_change_required AS "passwordChangeRequired",
            m.suspended_at IS NOT NULL AS suspended
       FROM members m
       JOIN member_roles r
         ON r.member_id = m.id
        AND r.role = 'staff'
        AND r.revoked_at IS NULL
      WHERE m.username IS NOT NULL
      ORDER BY m.display_name, m.username, m.id`
  );

  response.json(staffMembersResponseSchema.parse({ staff: result.rows }));
});

memberRoutes.post(
  "/",
  requireSameOrigin,
  requireRole("admin"),
  async (request, response) => {
    const parsed = createStaffMemberSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: "Enter a name, valid username, optional email, and a temporary password of at least 12 characters."
      });
      return;
    }

    const passwordHash = await hashPassword(parsed.data.temporaryPassword);
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      const result = await client.query<StaffRow>(
        `INSERT INTO members
           (display_name, username, email, password_hash, activated_at, password_change_required)
         VALUES ($1, $2, $3, $4, now(), true)
         RETURNING id,
                   display_name AS "displayName",
                   username,
                   email,
                   password_change_required AS "passwordChangeRequired",
                   suspended_at IS NOT NULL AS suspended`,
        [
          parsed.data.displayName,
          parsed.data.username,
          parsed.data.email,
          passwordHash
        ]
      );

      await client.query(
        `INSERT INTO member_roles (member_id, role) VALUES ($1, 'staff')`,
        [result.rows[0].id]
      );

      await client.query("COMMIT");
      response.status(201).json(staffMemberSchema.parse(result.rows[0]));
    } catch (error) {
      await client.query("ROLLBACK");
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      ) {
        response.status(409).json({ error: "That username or email is already in use." });
        return;
      }
      throw error;
    } finally {
      client.release();
    }
  }
);

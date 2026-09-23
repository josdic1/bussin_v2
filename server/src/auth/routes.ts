import { Router, type Request, type Response } from "express";
import { changePasswordSchema, loginSchema } from "@bussin/shared";
import { pool } from "../db/pool.js";
import {
  createSession,
  hashPassword,
  readSession,
  revokeSession,
  verifyPassword
} from "./sessions.js";

export const authRoutes = Router();

const cookieName = "bussin_session";
const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/"
};

function sessionToken(request: Request): string | undefined {
  const cookie = request.headers.cookie
    ?.split(/;\s*/)
    .find((part) => part.startsWith(`${cookieName}=`));

  return cookie?.slice(cookieName.length + 1);
}

function requireSameOrigin(request: Request, response: Response): boolean {
  const origin = request.get("origin");
  const host = request.get("host");

  if (!origin || !host) {
    response.status(403).json({ error: "Request origin required" });
    return false;
  }

  try {
    if (new URL(origin).host === host) return true;
  } catch {
    // Invalid origin.
  }

  response.status(403).json({ error: "Request origin not allowed" });
  return false;
}

authRoutes.post("/login", async (request, response) => {
  if (!requireSameOrigin(request, response)) return;

  const parsed = loginSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Enter a valid email and password" });
    return;
  }

  const result = await pool.query<{
    id: string;
    password_hash: string;
  }>(
    `SELECT m.id, m.password_hash
     FROM members m
     WHERE (m.username = $1 OR m.email = $1)
       AND m.password_hash IS NOT NULL
       AND m.activated_at IS NOT NULL
       AND m.suspended_at IS NULL
       AND EXISTS (
         SELECT 1 FROM member_roles r
         WHERE r.member_id = m.id AND r.revoked_at IS NULL
       )`,
    [parsed.data.identity]
  );

  const member = result.rows[0];
  if (!member || !(await verifyPassword(member.password_hash, parsed.data.password))) {
    response.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const token = await createSession(member.id);
  const currentMember = await readSession(token);

  if (!currentMember) {
    await revokeSession(token);
    response.status(401).json({ error: "Account unavailable" });
    return;
  }

  response.cookie(cookieName, token, {
    ...cookieOptions,
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
  response.json({ member: currentMember });
});

authRoutes.get("/me", async (request, response) => {
  const member = await readSession(sessionToken(request));

  if (!member) {
    response.status(401).json({ error: "Not signed in" });
    return;
  }

  response.json({ member });
});

authRoutes.post("/logout", async (request, response) => {
  if (!requireSameOrigin(request, response)) return;

  await revokeSession(sessionToken(request));
  response.clearCookie(cookieName, cookieOptions);
  response.status(204).end();
});

authRoutes.post("/change-password", async (request, response) => {
  if (!requireSameOrigin(request, response)) return;

  const member = await readSession(sessionToken(request));
  if (!member) {
    response.status(401).json({ error: "Not signed in" });
    return;
  }

  const parsed = changePasswordSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "New password must have at least 12 characters" });
    return;
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query<{ password_hash: string }>(
      `SELECT password_hash FROM members
       WHERE id = $1 AND suspended_at IS NULL
       FOR UPDATE`,
      [member.id]
    );

    const storedHash = result.rows[0]?.password_hash;
    if (!storedHash || !(await verifyPassword(
      storedHash,
      parsed.data.currentPassword
    ))) {
      await client.query("ROLLBACK");
      response.status(401).json({ error: "Current password is incorrect" });
      return;
    }

    if (await verifyPassword(storedHash, parsed.data.newPassword)) {
      await client.query("ROLLBACK");
      response.status(400).json({ error: "Choose a different password" });
      return;
    }

    const newHash = await hashPassword(parsed.data.newPassword);

    await client.query(
      `UPDATE members
       SET password_hash = $1, password_change_required = false
       WHERE id = $2`,
      [newHash, member.id]
    );

    await client.query(
      `UPDATE sessions SET revoked_at = now()
       WHERE member_id = $1 AND revoked_at IS NULL`,
      [member.id]
    );

    await client.query("COMMIT");
    response.clearCookie(cookieName, cookieOptions);
    response.status(204).end();
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

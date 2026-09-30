import { Router, type Request, type Response } from "express";
import { changePasswordSchema, loginSchema } from "@bussin/shared";
import { pool } from "../db/pool.js";
import { readTenant } from "../db/tenant.js";
import { clientIp, FailureLimiter } from "../http.js";
import { clearSessionCookie, sessionToken, setSessionCookie } from "./cookies.js";
import {
  createSession,
  hashPassword,
  readSession,
  readSessionDetailed,
  revokeSession,
  verifyPassword
} from "./sessions.js";

export const authRoutes = Router();

const WINDOW_MS = 15 * 60 * 1000;
/** 10 wrong passwords for one identity from one address, 30 per address overall. */
const identityFailures = new FailureLimiter(10, WINDOW_MS);
const addressFailures = new FailureLimiter(30, WINDOW_MS);

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

function tooMany(response: Response, seconds: number) {
  response.set("Retry-After", String(seconds));
  response.status(429).json({
    error: `Too many sign-in attempts. Try again in ${Math.ceil(seconds / 60)} min.`
  });
}

authRoutes.post("/login", async (request, response) => {
  if (!requireSameOrigin(request, response)) return;

  const parsed = loginSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Enter a valid email and password" });
    return;
  }

  const ip = clientIp(request);
  const identityKey = `${ip}|${parsed.data.identity}`;
  const wait = Math.max(identityFailures.retryAfter(identityKey), addressFailures.retryAfter(ip));
  if (wait) {
    tooMany(response, wait);
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
    identityFailures.fail(identityKey);
    addressFailures.fail(ip);
    response.status(401).json({ error: "Invalid email or password" });
    return;
  }
  identityFailures.clear(identityKey);

  const token = await createSession(member.id);
  const currentMember = await readSession(token);

  if (!currentMember) {
    await revokeSession(token);
    response.status(401).json({ error: "Account unavailable" });
    return;
  }

  setSessionCookie(response, token);
  response.json({ member: currentMember, tenant: await readTenant() });
});

authRoutes.get("/me", async (request, response) => {
  const token = sessionToken(request);
  const session = await readSessionDetailed(token);

  if (!session) {
    response.status(401).json({ error: "Not signed in" });
    return;
  }

  if (session.renewed && token) setSessionCookie(response, token);
  response.json({ member: session.member, tenant: await readTenant() });
});

authRoutes.post("/logout", async (request, response) => {
  if (!requireSameOrigin(request, response)) return;

  await revokeSession(sessionToken(request));
  clearSessionCookie(response);
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
    clearSessionCookie(response);
    response.status(204).end();
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

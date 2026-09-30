import { createHash, randomBytes } from "node:crypto";
import argon2 from "argon2";
import { pool } from "../db/pool.js";

export type Role = "admin" | "dispatch" | "staff" | "family";

export type SignedInMember = {
  id: string;
  email: string | null;
  username: string | null;
  display_name: string;
  passwordChangeRequired: boolean;
  roles: Role[];
};

/** Sessions slide: each day of use pushes expiry out to 7 days, never past 30 days from sign-in. */
export const SESSION_DAYS = 7;
export const SESSION_MAX_DAYS = 30;

const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1
  });
}

export async function verifyPassword(
  hash: string,
  password: string
): Promise<boolean> {
  return argon2.verify(hash, password);
}

export async function createSession(memberId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");

  await pool.query(
    `INSERT INTO sessions (member_id, token_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(days => $3))`,
    [memberId, tokenHash(token), SESSION_DAYS]
  );

  return token;
}

type SessionRow = SignedInMember & { sessionId: string; renew: boolean };

/**
 * Reads the signed-in member for a session token. `renewed` is true when this
 * read extended the session, so the caller can refresh the browser cookie.
 */
export async function readSessionDetailed(
  token: string | undefined
): Promise<{ member: SignedInMember; renewed: boolean } | null> {
  if (!token || !tokenPattern.test(token)) return null;

  const result = await pool.query<SessionRow>(
    `SELECT m.id, m.email, m.username, m.display_name,
            m.password_change_required AS "passwordChangeRequired",
            CASE WHEN m.password_change_required
              THEN ARRAY[]::text[]
              ELSE ARRAY(
              SELECT mr.role
              FROM member_roles mr
              WHERE mr.member_id = m.id AND mr.revoked_at IS NULL
              ORDER BY mr.role
            ) END AS roles,
            s.id AS "sessionId",
            (s.expires_at < now() + make_interval(days => $2 - 1)
              AND s.created_at + make_interval(days => $3) > now() + interval '1 hour') AS renew
     FROM sessions s
     JOIN members m ON m.id = s.member_id
     WHERE s.token_hash = $1
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
       AND m.activated_at IS NOT NULL
       AND m.suspended_at IS NULL`,
    [tokenHash(token), SESSION_DAYS, SESSION_MAX_DAYS]
  );

  const row = result.rows[0];
  if (!row) return null;

  const { sessionId, renew, ...member } = row;
  if (renew) {
    await pool.query(
      `UPDATE sessions
          SET expires_at = LEAST(now() + make_interval(days => $2),
                                 created_at + make_interval(days => $3))
        WHERE id = $1 AND revoked_at IS NULL`,
      [sessionId, SESSION_DAYS, SESSION_MAX_DAYS]
    );
  }
  return { member, renewed: renew };
}

export async function readSession(
  token: string | undefined
): Promise<SignedInMember | null> {
  return (await readSessionDetailed(token))?.member ?? null;
}

export async function revokeSession(token: string | undefined): Promise<void> {
  if (!token || !tokenPattern.test(token)) return;

  await pool.query(
    `UPDATE sessions
     SET revoked_at = now()
     WHERE token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash(token)]
  );
}

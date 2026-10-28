import type { PoolClient } from "pg";
import type { pool } from "../db/pool.js";

// Guardian emails are one per person: an email is how a parent signs in, and how
// uploads recognize a parent. Phones may be shared (a home line), so they aren't checked.

/** The name of another guardian already using this email, or null. */
export async function guardianEmailOwner(
  db: PoolClient | typeof pool, email: string | null, exceptId: string | null
): Promise<string | null> {
  if (!email) return null;
  const result = await db.query<{ name: string }>(
    `SELECT name FROM guardians WHERE lower(email) = lower($1) AND ($2::uuid IS NULL OR id <> $2) LIMIT 1`,
    [email, exceptId]
  );
  return result.rows[0]?.name ?? null;
}

export const emailTakenMessage = (email: string, owner: string) => `${email} already belongs to ${owner}. Each parent needs their own email.`;

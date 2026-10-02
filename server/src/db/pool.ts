import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
const databaseName = process.env.PGDATABASE;

if (!databaseUrl && !databaseName) {
  throw new Error("Set DATABASE_URL or PGDATABASE before using the database");
}

const configuredMax = Number(process.env.PG_POOL_MAX);
const max = Number.isInteger(configuredMax) && configuredMax > 1 ? configuredMax : 10;

// Fail fast instead of hanging forever: a phone waiting on a stuck request
// shows "Retrying" and "Saving..." indefinitely.
const limits = {
  max,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 15_000,
  idle_in_transaction_session_timeout: 30_000
};

export const pool = new Pool(
  databaseUrl
    ? { connectionString: databaseUrl, ...limits }
    : { database: databaseName, ...limits }
);

pool.on("error", (error) => {
  console.error("Idle PostgreSQL connection failed", error);
});

// A connection that drops while checked out emits "error" on the client. With
// no listener that kills the whole server process. Log it instead.
pool.on("connect", (client) => {
  client.on("error", (error) => {
    console.error("PostgreSQL connection failed while in use", error);
  });
});

import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
const databaseName = process.env.PGDATABASE;

if (!databaseUrl && !databaseName) {
  throw new Error("Set DATABASE_URL or PGDATABASE before using the database");
}

const configuredMax = Number(process.env.PG_POOL_MAX);
const max = Number.isInteger(configuredMax) && configuredMax > 1 ? configuredMax : 10;

export const pool = new Pool(
  databaseUrl
    ? { connectionString: databaseUrl, max }
    : { database: databaseName, max }
);

pool.on("error", (error) => {
  console.error("Idle PostgreSQL connection failed", error);
});

import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
const databaseName = process.env.PGDATABASE;

if (!databaseUrl && !databaseName) {
  throw new Error("Set DATABASE_URL or PGDATABASE before using the database");
}

export const pool = new Pool(
  databaseUrl
    ? { connectionString: databaseUrl, max: 10 }
    : { database: databaseName, max: 10 }
);

pool.on("error", (error) => {
  console.error("Idle PostgreSQL connection failed", error);
});

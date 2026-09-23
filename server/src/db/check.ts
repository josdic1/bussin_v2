import { pool } from "./pool.js";

try {
  const result = await pool.query<{
    database: string;
    migrations: number;
  }>(
    `SELECT current_database() AS database,
            (SELECT count(*)::integer FROM schema_migrations) AS migrations`
  );

  console.log(result.rows[0]);
} finally {
  await pool.end();
}

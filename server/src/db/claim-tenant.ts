import { pool } from "./pool.js";

const [key, name] = process.argv.slice(2);
if (!key || !/^[a-z][a-z0-9-]{1,39}$/.test(key) || !name || name.trim().length > 80 || process.argv.length !== 4) {
  throw new Error('Usage: npm run tenant:init -w @bussin/server -- local-test "Local test"');
}

const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(472903)");
  const existing = await client.query<{ key: string; name: string }>(
    `SELECT tenant_key AS key, display_name AS name FROM tenant_identity FOR UPDATE`
  );
  if (existing.rowCount) {
    if (existing.rows[0].key !== key || existing.rows[0].name !== name.trim()) {
      throw new Error(`Database already belongs to ${existing.rows[0].name} (${existing.rows[0].key}); refusing to relabel it.`);
    }
    console.log(`Already claimed: ${key}`);
  } else {
    const contents = await client.query<{
      routes: string; buses: string; trips: string; riders: string; members: string; foreignImports: string;
    }>(`SELECT (SELECT count(*) FROM routes)::text AS routes,
              (SELECT count(*) FROM buses)::text AS buses,
              (SELECT count(*) FROM trips)::text AS trips,
              (SELECT count(*) FROM riders)::text AS riders,
              (SELECT count(*) FROM members)::text AS members,
              ((SELECT count(*) FROM riders WHERE import_dataset IS NOT NULL AND import_dataset <> $1)
               + (SELECT count(*) FROM guardians WHERE import_dataset IS NOT NULL AND import_dataset <> $1))::text AS "foreignImports"`, [key]);
    const counts = contents.rows[0];
    if (Number(counts.foreignImports) ||
        (key !== "local-test" && [counts.routes, counts.buses, counts.trips, counts.riders, counts.members].some((n) => Number(n) > 0))) {
      throw new Error("This database contains other data. Only an empty database can be claimed for a new organization.");
    }
    await client.query(
      `INSERT INTO tenant_identity (tenant_key, display_name) VALUES ($1, $2)`, [key, name.trim()]
    );
    console.log(`Claimed database: ${name.trim()} (${key})`);
  }
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  client.release();
  await pool.end();
}

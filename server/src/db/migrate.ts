import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pool } from "./pool.js";

const directory = fileURLToPath(
  new URL("../../db/migrations/", import.meta.url)
);

const files = (await readdir(directory))
  .filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file))
  .sort();

const migrations = files.map((file) => {
  const match = /^(\d{3})_([a-z0-9_]+)\.sql$/.exec(file)!;
  return { file, version: Number(match[1]), name: match[2] };
});

if (new Set(migrations.map((item) => item.version)).size !== migrations.length) {
  throw new Error("Two migration files have the same version");
}

const client = await pool.connect();

try {
  await client.query("SELECT pg_advisory_lock(472901)");

  const table = await client.query<{ exists: string | null }>(
    "SELECT to_regclass('public.schema_migrations')::text AS exists"
  );

  const applied = new Map<number, string>();

  if (table.rows[0]?.exists) {
    const rows = await client.query<{ version: number; name: string }>(
      "SELECT version, name FROM schema_migrations ORDER BY version"
    );
    for (const row of rows.rows) applied.set(row.version, row.name);
  }

  for (const [version, name] of applied) {
    if (!migrations.some((item) => item.version === version && item.name === name)) {
      throw new Error(`Applied migration ${version} (${name}) has no matching file`);
    }
  }

  for (const migration of migrations) {
    if (applied.has(migration.version)) {
      console.log(`Already applied: ${migration.file}`);
      continue;
    }

    const sql = await readFile(`${directory}/${migration.file}`, "utf8");
    await client.query("BEGIN");

    try {
      await client.query(sql);

      // Migration 001 created the ledger and recorded itself.
      const recorded = await client.query<{ name: string }>(
        "SELECT name FROM schema_migrations WHERE version = $1",
        [migration.version]
      );

      if (recorded.rows.length === 0) {
        await client.query(
          "INSERT INTO schema_migrations (version, name) VALUES ($1, $2)",
          [migration.version, migration.name]
        );
      } else if (recorded.rows[0]?.name !== migration.name) {
        throw new Error(`Migration ${migration.version} recorded the wrong name`);
      }

      await client.query("COMMIT");
      console.log(`Applied: ${migration.file}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  await client.query("SELECT pg_advisory_unlock(472901)").catch(() => {});
  client.release();
  await pool.end();
}

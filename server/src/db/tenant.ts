import { pool } from "./pool.js";

export type Tenant = { key: string; name: string };

export async function readTenant(): Promise<Tenant> {
  const configured = process.env.BUSSIN_TENANT;
  if (!configured || !/^[a-z][a-z0-9-]{1,39}$/.test(configured)) {
    throw new Error("Set BUSSIN_TENANT to this database's tenant key before starting the app.");
  }
  const result = await pool.query<Tenant>(
    `SELECT tenant_key AS key, display_name AS name FROM tenant_identity WHERE singleton = true`
  );
  const tenant = result.rows[0];
  if (!tenant || tenant.key !== configured) {
    throw new Error(`Database tenant identity does not match BUSSIN_TENANT=${configured}. Run tenant:init only for an unclaimed database.`);
  }
  return tenant;
}

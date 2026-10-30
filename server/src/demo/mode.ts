// Demo mode. Only a separate demo copy of Bussin turns this on (DEMO_MODE=1), and it only
// works when that copy's database has a tenant key ending in "-demo". The real camp's
// database never does, so even a DEMO_MODE=1 set by mistake on the real server does nothing.

export const DEMO_REQUESTED = process.env.DEMO_MODE === "1";
export const isDemoTenant = (key: string) => /-demo$/.test(key);

let active = false;
/** Called once at startup, after the tenant is read. */
export function settleDemoMode(tenantKey: string) {
  active = DEMO_REQUESTED && isDemoTenant(tenantKey);
  if (DEMO_REQUESTED && !active) console.warn(`DEMO_MODE=1 ignored: tenant "${tenantKey}" is not a demo copy.`);
  return active;
}
export const demoActive = () => active;

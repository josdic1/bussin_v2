import { createHash, randomBytes } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import { pool } from "../db/pool.js";

// Bus tracker sign-in. A paired phone holds a long-lived device cookie that stands
// for the bus, not a person. The database keeps only a hash of it.

export const DEVICE_COOKIE = "bussin_device";
// Browsers cap cookie lifetimes at about 400 days; re-pairing after that is a 1-minute job.
const DEVICE_DAYS = 400;

const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/"
};

export type Device = { id: string; busId: string; busLabel: string };

export const hashSecret = (value: string) => createHash("sha256").update(value).digest();

export function newDeviceToken(): string {
  return randomBytes(32).toString("base64url");
}

export function deviceToken(request: Request): string | undefined {
  return request.headers.cookie
    ?.split(/;\s*/)
    .find((part) => part.startsWith(`${DEVICE_COOKIE}=`))
    ?.slice(DEVICE_COOKIE.length + 1);
}

export function setDeviceCookie(response: Response, token: string): void {
  response.cookie(DEVICE_COOKIE, token, { ...cookieOptions, maxAge: DEVICE_DAYS * 24 * 60 * 60 * 1000 });
}

export function clearDeviceCookie(response: Response): void {
  response.clearCookie(DEVICE_COOKIE, cookieOptions);
}

/** Loads the paired bus for this request, or answers 401. Also marks the tracker as seen. */
export const requireDevice: RequestHandler = async (request, response, next) => {
  const token = deviceToken(request);
  if (!token) {
    response.status(401).json({ error: "This phone isn't paired to a bus." });
    return;
  }
  const found = await pool.query<Device>(
    `SELECT d.id, d.bus_id AS "busId", b.label AS "busLabel"
       FROM bus_devices d JOIN buses b ON b.id = d.bus_id
      WHERE d.token_hash = $1 AND d.revoked_at IS NULL`,
    [hashSecret(token)]
  );
  const device = found.rows[0];
  if (!device) {
    clearDeviceCookie(response);
    response.status(401).json({ error: "This phone was unpaired. Pair it again from Fleet." });
    return;
  }
  // At most one write every 20 seconds per tracker.
  await pool.query(
    `UPDATE bus_devices SET last_seen_at = now()
      WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '20 seconds')`,
    [device.id]
  );
  response.locals.device = device;
  next();
};

export function currentDevice(response: Response): Device {
  const device = response.locals.device as Device | undefined;
  if (!device) throw new Error("currentDevice() used on a route without requireDevice");
  return device;
}

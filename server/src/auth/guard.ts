import type { RequestHandler } from "express";
import { readSession, type Role } from "./sessions.js";

export function requireRole(...allowed: Role[]): RequestHandler {
  return async (request, response, next) => {
    const token = request.headers.cookie
      ?.split(/;\s*/)
      .find((part) => part.startsWith("bussin_session="))
      ?.slice("bussin_session=".length);

    const member = await readSession(token);

    if (!member) {
      response.status(401).json({ error: "Not signed in" });
      return;
    }

    if (
      member.passwordChangeRequired ||
      !allowed.some((role) => member.roles.includes(role))
    ) {
      response.status(403).json({ error: "Access denied" });
      return;
    }

    next();
  };
}

export const requireSameOrigin: RequestHandler = (request, response, next) => {
  const origin = request.get("origin");
  const host = request.get("host");

  try {
    if (origin && host && new URL(origin).host === host) {
      next();
      return;
    }
  } catch {
    // Invalid origin.
  }

  response.status(403).json({ error: "Request origin not allowed" });
};

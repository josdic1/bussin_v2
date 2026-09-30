import type { RequestHandler, Response } from "express";
import { readSessionDetailed, type Role, type SignedInMember } from "./sessions.js";
import { sessionToken, setSessionCookie } from "./cookies.js";

/**
 * Loads the session once per request. Handlers read the member from
 * `currentMember(response)` instead of querying the session again.
 */
export function requireRole(...allowed: Role[]): RequestHandler {
  return async (request, response, next) => {
    const token = sessionToken(request);
    const session = await readSessionDetailed(token);

    if (!session) {
      response.status(401).json({ error: "Not signed in" });
      return;
    }

    const { member } = session;
    if (
      member.passwordChangeRequired ||
      !allowed.some((role) => member.roles.includes(role))
    ) {
      response.status(403).json({ error: "Access denied" });
      return;
    }

    if (session.renewed && token) setSessionCookie(response, token);
    response.locals.member = member;
    next();
  };
}

/** The member loaded by requireRole for this request. */
export function currentMember(response: Response): SignedInMember {
  const member = response.locals.member as SignedInMember | undefined;
  if (!member) throw new Error("currentMember() used on a route without requireRole()");
  return member;
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

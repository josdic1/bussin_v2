import type { Request, Response } from "express";
import { SESSION_DAYS } from "./sessions.js";

export const SESSION_COOKIE = "bussin_session";

const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/"
};

export function sessionToken(request: Request): string | undefined {
  return request.headers.cookie
    ?.split(/;\s*/)
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
}

export function setSessionCookie(response: Response, token: string): void {
  response.cookie(SESSION_COOKIE, token, {
    ...cookieOptions,
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000
  });
}

export function clearSessionCookie(response: Response): void {
  response.clearCookie(SESSION_COOKIE, cookieOptions);
}

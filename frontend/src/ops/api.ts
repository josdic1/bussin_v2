import { ZodError, type z } from "zod";
import { CHECK_EVENT } from "../UpdateBanner";

// Data this page doesn't recognize almost always means Bussin was updated while the
// tab was open. Say that in plain words, and check the version so the reload bar shows.
export const OUTDATED = "Bussin was just updated. Reload the page to continue.";
function outdated(): Error {
  window.dispatchEvent(new Event(CHECK_EVENT));
  return new Error(OUTDATED);
}

async function errorFrom(response: Response, fallback: string) {
  const body: unknown = await response.json().catch(() => null);
  return new Error(body && typeof body === "object" && "error" in body &&
    typeof body.error === "string" ? body.error : fallback);
}

export async function getJson<T extends z.ZodType>(
  url: string, schema: T, signal?: AbortSignal
): Promise<z.infer<T>> {
  const response = await fetch(url, { credentials: "same-origin", signal });
  if (!response.ok) throw await errorFrom(response, `Could not load ${url}`);
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) throw outdated();
  return parsed.data;
}

/** Write request. Resolves to the parsed JSON body; rejects with the server's message. */
export async function send(
  method: "POST" | "PUT" | "PATCH" | "DELETE", url: string, body?: unknown, fallback = "Request failed."
): Promise<unknown> {
  const response = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.ok) throw await errorFrom(response, fallback);
  return response.json().catch(() => null);
}

export function message(cause: unknown, fallback: string) {
  if (cause instanceof ZodError) return outdated().message;
  return cause instanceof Error ? cause.message : fallback;
}

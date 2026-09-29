import type { z } from "zod";

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
  return schema.parse(await response.json());
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
  return cause instanceof Error ? cause.message : fallback;
}

import { useEffect, useState } from "react";

// Is this the demo copy? Asked once per page load. The real site always answers no.

export type DemoInfo = { demo: false } | { demo: true; people: { office: string | null; counselor: string | null; parent: string | null } };

let cached: Promise<DemoInfo> | null = null;
export function loadDemo(): Promise<DemoInfo> {
  cached ??= fetch("/api/demo", { credentials: "same-origin" })
    .then((response) => (response.ok ? response.json() : { demo: false }) as Promise<DemoInfo>)
    .catch(() => ({ demo: false }) as DemoInfo);
  return cached;
}
export function refreshDemo() { cached = null; return loadDemo(); }

export function useDemo(): DemoInfo | null {
  const [info, setInfo] = useState<DemoInfo | null>(null);
  useEffect(() => { let live = true; void loadDemo().then((value) => { if (live) setInfo(value); }); return () => { live = false; }; }, []);
  return info;
}

async function post(url: string, body: unknown) {
  const response = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) {
    const reply: unknown = await response.json().catch(() => null);
    throw new Error(reply && typeof reply === "object" && "error" in reply && typeof reply.error === "string" ? reply.error : "That didn't work.");
  }
  return response.json() as Promise<unknown>;
}

export type Who = "office" | "counselor" | "parent";
export async function signInAs(who: Who) {
  await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => undefined);
  await post("/api/demo/signin", { as: who });
  location.assign("/");
}
export async function resetDemo(period: "AM" | "PM") {
  await post("/api/demo/reset", { period });
  refreshDemo();
  location.reload();
}

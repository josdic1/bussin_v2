import { useEffect, useState } from "react";
import { announceSignIn } from "../auth/AuthProvider";

// Is this the demo copy? Asked once per page load. The real site always answers no.

export type DemoInfo = { demo: false } | {
  demo: true;
  /** False until someone builds a camp: then the welcome page shows instead of sign-in. */
  ready: boolean;
  camp: string;
  size: { buses: number; kids: number };
  /** The robot driver: speed 0 is off. */
  driving: { speed: number; buses: number };
  people: { office: string | null; counselor: string | null; parent: string | null };
};

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
  announceSignIn();
  location.assign("/");
}
export async function resetDemo(period: "AM" | "PM") {
  await post("/api/demo/reset", { period });
  refreshDemo();
  location.reload();
}

export type HistorySpan = "day" | "week" | "month" | "season";
export async function buildCamp(input: { campName: string; buses: number; kids: number; history: HistorySpan | "none" }) {
  return post("/api/demo/build", input) as Promise<{ buses: number; kids: number; families: number; staff: number; runs: number; history: number }>;
}
export async function fillHistory(span: HistorySpan) {
  return post("/api/demo/history", { span }) as Promise<{ trips: number; cancelled: number; days: number }>;
}

export type Keep = { setup: boolean; team: boolean; kids: boolean; history: boolean; messages: boolean };
/** Wipe what isn't kept. Without the camp setup there is nothing to run, so sign out to the welcome page. */
export async function clearDemo(keep: Keep) {
  await post("/api/demo/clear", keep);
  if (!keep.setup) { await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => undefined); announceSignIn(); }
  location.assign("/");
}

export async function drive(speed: 0 | 1 | 5 | 15) {
  const state = await post("/api/demo/drive", { speed }) as { speed: number; buses: number };
  refreshDemo();
  return state;
}

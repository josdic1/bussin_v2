import { useEffect, useState } from "react";
import { pushKeyResponseSchema } from "@bussin/shared";

/*
 * "Get bus alerts on this phone." Turns on Web Push for the phone in the parent's hand:
 * the bus left, it's about 10 minutes away, it's at your stop. iPhones only allow this
 * from the home-screen app, so they get the two taps to set that up instead.
 */

type State = "loading" | "unavailable" | "iphone-install" | "blocked" | "off" | "on";

function keyBytes(base64: string) {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

const isIphone = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const installed = () => window.matchMedia?.("(display-mode: standalone)").matches || ("standalone" in navigator && (navigator as { standalone?: boolean }).standalone === true);

async function post(url: string, body: unknown) {
  const response = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) {
    const reply: unknown = await response.json().catch(() => null);
    throw new Error(reply && typeof reply === "object" && "error" in reply && typeof reply.error === "string" ? reply.error : "That didn't work. Try again.");
  }
}

export function BusAlerts({ preview }: { preview?: boolean }) {
  const [state, setState] = useState<State>("loading");
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    if (preview) { setState("unavailable"); return; }
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/push/key", { credentials: "same-origin" });
        const publicKey = response.ok ? pushKeyResponseSchema.parse(await response.json()).publicKey : null;
        if (cancelled) return;
        setKey(publicKey);
        if (!publicKey) { setState("unavailable"); return; }
        const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
        if (!supported) { setState(isIphone() && !installed() ? "iphone-install" : "unavailable"); return; }
        if (Notification.permission === "denied") { setState("blocked"); return; }
        const registration = await navigator.serviceWorker.ready;
        const existing = await registration.pushManager.getSubscription();
        if (!cancelled) setState(existing ? "on" : "off");
        // Keep the server's copy fresh (a phone can rotate its subscription).
        if (existing) await post("/api/push/subscribe", existing.toJSON()).catch(() => undefined);
      } catch {
        if (!cancelled) setState("unavailable");
      }
    })();
    return () => { cancelled = true; };
  }, [preview]);

  async function turnOn() {
    if (!key) return;
    setBusy(true); setNote("");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") { setState(permission === "denied" ? "blocked" : "off"); return; }
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
      await post("/api/push/subscribe", subscription.toJSON());
      setState("on");
      setNote("Alerts are on. Send a test to be sure.");
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true); setNote("");
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await post("/api/push/unsubscribe", { endpoint: subscription.endpoint }).catch(() => undefined);
        await subscription.unsubscribe();
      }
      setState("off");
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true); setNote("");
    try { await post("/api/push/test", {}); setNote("Sent. It should show up in a few seconds."); }
    catch (cause) { setNote(cause instanceof Error ? cause.message : "That didn't send."); }
    finally { setBusy(false); }
  }

  if (state === "loading" || state === "unavailable") return null;
  return <section className="falerts">
    {state === "on" ? <>
      <div><b>Bus alerts are on</b><small>When the bus leaves, at 10 minutes away, and at your stop.</small></div>
      <div className="falerts-btns">
        <button type="button" disabled={busy} onClick={() => void test()}>Send a test</button>
        <button type="button" className="quiet" disabled={busy} onClick={() => void turnOff()}>Turn off</button>
      </div>
    </> : state === "off" ? <>
      <div><b>Get bus alerts on this phone</b><small>When the bus leaves, at 10 minutes away, and at your stop.</small></div>
      <button type="button" className="go" disabled={busy} onClick={() => void turnOn()}>{busy ? "Turning on…" : "Turn on"}</button>
    </> : state === "blocked" ? <div><b>Alerts are blocked on this phone</b>
      <small>Allow notifications for this site in your phone&rsquo;s settings, then reload.</small></div>
      : <div><b>Want bus alerts on your iPhone?</b>
        <small>Add Bussin to your home screen first (the button at the top of this page), then turn alerts on there.</small></div>}
    {note && <p className="falerts-note" role="status">{note}</p>}
  </section>;
}
